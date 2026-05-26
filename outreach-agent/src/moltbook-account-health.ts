import type { MoltbookRuntimeConfig } from "./config.js";
import type { MoltbookPost } from "./moltbook-api.js";
import {
  normalizeState,
  type OutreachAgentState,
  type OutboundPostPauseReason,
  type RecentGeneratedArtifact
} from "./policy.js";
import { recordPromptRotationAction } from "./prompt-rotation.js";

export const MOLTBOOK_BACKFILL_POST_LIMIT = 8;
export const MOLTBOOK_SPAM_PAUSE_MS = 48 * 60 * 60 * 1000;
export const MOLTBOOK_FAILED_VERIFICATION_PAUSE_MS = 24 * 60 * 60 * 1000;
export const MAX_MOLTBOOK_PROCESSED_MODERATION_POST_IDS = 50;

export function isMoltbookPostModerationFailure(
  post: Pick<MoltbookPost, "is_spam" | "verification_status">
): boolean {
  if (post.is_spam === true) {
    return true;
  }
  const status = post.verification_status?.trim().toLowerCase();
  return status === "failed" || status === "rejected";
}

function postId(post: MoltbookPost): string {
  return post.id || post.post_id || "";
}

function postToArtifact(post: MoltbookPost): RecentGeneratedArtifact | null {
  const id = postId(post);
  if (!id) {
    return null;
  }
  const content = post.content?.trim() || post.content_preview?.trim() || "";
  const title = post.title?.trim();
  if (!content && !title) {
    return null;
  }
  return {
    id,
    type: "post",
    title,
    content: content || title || "",
    targetId: id,
    createdAt: post.created_at ?? new Date().toISOString()
  };
}

export function backfillRecentPostArtifacts(
  state: OutreachAgentState,
  posts: readonly MoltbookPost[]
): OutreachAgentState {
  const sortedPosts = [...posts]
    .filter((post) => postId(post))
    .sort((left, right) => Date.parse(right.created_at ?? "") - Date.parse(left.created_at ?? ""))
    .slice(0, MOLTBOOK_BACKFILL_POST_LIMIT);

  if (sortedPosts.length === 0) {
    return state;
  }

  const knownIds = new Set(
    state.recentGeneratedArtifacts.flatMap((artifact) =>
      [artifact.id, artifact.targetId].filter((value): value is string => Boolean(value))
    )
  );
  const additions: RecentGeneratedArtifact[] = [];
  for (const post of sortedPosts) {
    const id = postId(post);
    if (knownIds.has(id)) {
      continue;
    }
    const artifact = postToArtifact(post);
    if (!artifact) {
      continue;
    }
    additions.push(artifact);
    knownIds.add(id);
  }

  if (additions.length === 0) {
    return state;
  }

  return {
    ...state,
    recentGeneratedArtifacts: [...state.recentGeneratedArtifacts, ...additions].sort(
      (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
    )
  };
}

function findArtifactForPost(
  state: OutreachAgentState,
  post: MoltbookPost
): RecentGeneratedArtifact | undefined {
  const id = postId(post);
  if (!id) {
    return undefined;
  }
  return state.recentGeneratedArtifacts.find(
    (artifact) => artifact.id === id || artifact.targetId === id
  );
}

function extendOutboundPostPause(
  state: OutreachAgentState,
  reason: OutboundPostPauseReason,
  pauseMs: number,
  now: Date
): OutreachAgentState {
  const nextPauseUntil = new Date(now.getTime() + pauseMs).toISOString();
  const currentPauseUntil = state.outboundPostPauseUntil
    ? Date.parse(state.outboundPostPauseUntil)
    : Number.NEGATIVE_INFINITY;
  const nextPauseTimestamp = Date.parse(nextPauseUntil);
  const pauseUntil =
    Number.isFinite(currentPauseUntil) && currentPauseUntil > nextPauseTimestamp
      ? state.outboundPostPauseUntil!
      : nextPauseUntil;
  const pauseReason =
    reason === "spam" || state.outboundPostPauseReason === "spam" ? "spam" : reason;

  return {
    ...state,
    outboundPostPauseUntil: pauseUntil,
    outboundPostPauseReason: pauseReason
  };
}

async function recordModerationPromptRotation(input: {
  config: MoltbookRuntimeConfig;
  artifact: RecentGeneratedArtifact | undefined;
  post: MoltbookPost;
  reason: OutboundPostPauseReason;
  now: Date;
}): Promise<void> {
  if (!input.artifact?.promptVariantId) {
    return;
  }

  await recordPromptRotationAction({
    config: input.config,
    entry: {
      id: `moltbook:moderation:${postId(input.post)}:${input.reason}`,
      venue: "moltbook",
      actionType: "create_post",
      scopeKey: "moltbook:create_post",
      createdAt: input.now.toISOString(),
      status: "spam_accusation",
      eventType: "failed",
      promptProfileId: input.artifact.promptProfileId,
      promptVariantId: input.artifact.promptVariantId,
      promptVariantLabel: input.artifact.promptVariantId,
      promptParameters: input.artifact.promptParameters,
      layout: input.artifact.layout,
      messageStyle: input.artifact.promptParameters?.messageStyle,
      technicalDepth: input.artifact.promptParameters?.technicalDepth,
      tone: input.artifact.promptParameters?.tone,
      creativity: input.artifact.promptParameters?.creativity,
      selectionRationale:
        input.reason === "spam"
          ? "Moltbook flagged a recent post as spam; pausing create_post and penalizing this variant."
          : "Moltbook failed verification on a recent post; pausing create_post and penalizing this variant."
    }
  }).catch(() => undefined);
}

async function enrichPostModerationFields(
  post: MoltbookPost,
  getPost?: (postId: string) => Promise<MoltbookPost | undefined>
): Promise<MoltbookPost> {
  if (post.is_spam !== undefined || isMoltbookPostModerationFailure(post)) {
    return post;
  }
  const id = postId(post);
  if (!id || !getPost) {
    return post;
  }
  try {
    const fullPost = await getPost(id);
    return fullPost ? { ...post, ...fullPost } : post;
  } catch {
    return post;
  }
}

export interface MoltbookAccountHealthSyncResult {
  state: OutreachAgentState;
  alerts: string[];
  changed: boolean;
  newlyFlaggedPosts: Array<{ postId: string; reason: OutboundPostPauseReason }>;
}

export async function syncMoltbookAccountHealth(input: {
  state: OutreachAgentState;
  agentName: string;
  config: MoltbookRuntimeConfig;
  getAgentProfile: (agentName: string) => Promise<{ recentPosts?: MoltbookPost[] }>;
  getPost?: (postId: string) => Promise<MoltbookPost | undefined>;
  now?: Date;
}): Promise<MoltbookAccountHealthSyncResult> {
  const now = input.now ?? new Date();
  const alerts: string[] = [];
  const newlyFlaggedPosts: Array<{ postId: string; reason: OutboundPostPauseReason }> = [];
  let nextState = normalizeState(input.state, now);
  let changed = false;

  let profilePosts: MoltbookPost[] = [];
  try {
    const profile = await input.getAgentProfile(input.agentName);
    profilePosts = profile.recentPosts ?? [];
  } catch (error) {
    alerts.push(
      `Moltbook account health sync skipped profile fetch for ${input.agentName}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { state: nextState, alerts, changed, newlyFlaggedPosts };
  }

  const backfilledState = backfillRecentPostArtifacts(nextState, profilePosts);
  if (backfilledState.recentGeneratedArtifacts.length !== nextState.recentGeneratedArtifacts.length) {
    nextState = backfilledState;
    changed = true;
    alerts.push(
      `Backfilled ${backfilledState.recentGeneratedArtifacts.length - input.state.recentGeneratedArtifacts.length} recent Moltbook posts into dedupe memory.`
    );
  }

  const processedIds = new Set(nextState.moltbookProcessedModerationPostIds ?? []);
  const recentPosts = profilePosts
    .filter((post) => postId(post))
    .sort((left, right) => Date.parse(right.created_at ?? "") - Date.parse(left.created_at ?? ""))
    .slice(0, MOLTBOOK_BACKFILL_POST_LIMIT);

  for (const post of recentPosts) {
    const id = postId(post);
    if (!id || processedIds.has(id)) {
      continue;
    }

    const enrichedPost = await enrichPostModerationFields(post, input.getPost);
    if (!isMoltbookPostModerationFailure(enrichedPost)) {
      continue;
    }

    const reason: OutboundPostPauseReason =
      enrichedPost.is_spam === true ? "spam" : "failed_verification";
    const pauseMs =
      reason === "spam" ? MOLTBOOK_SPAM_PAUSE_MS : MOLTBOOK_FAILED_VERIFICATION_PAUSE_MS;
    const artifact = findArtifactForPost(nextState, enrichedPost);

    nextState = extendOutboundPostPause(nextState, reason, pauseMs, now);
    processedIds.add(id);
    newlyFlaggedPosts.push({ postId: id, reason });
    changed = true;

    await recordModerationPromptRotation({
      config: input.config,
      artifact,
      post: enrichedPost,
      reason,
      now
    });

    alerts.push(
      reason === "spam"
        ? `Moltbook flagged post ${id} as spam; create_post paused until ${nextState.outboundPostPauseUntil}.`
        : `Moltbook failed verification on post ${id}; create_post paused until ${nextState.outboundPostPauseUntil}.`
    );
  }

  const processedList = [...processedIds].slice(-MAX_MOLTBOOK_PROCESSED_MODERATION_POST_IDS);
  if (
    processedList.length !== (nextState.moltbookProcessedModerationPostIds?.length ?? 0) ||
    processedList.some((id, index) => id !== nextState.moltbookProcessedModerationPostIds?.[index])
  ) {
    nextState = {
      ...nextState,
      moltbookProcessedModerationPostIds: processedList
    };
    changed = true;
  }

  return {
    state: normalizeState(nextState, now),
    alerts,
    changed,
    newlyFlaggedPosts
  };
}
