import { buildMainLlmProvider, type MoltbookOutreachPolicyConfig, type MoltbookRuntimeConfig } from "./config.js";
import type { ChatMessage } from "./llm-client.js";
import { saveLlmDebugInput } from "./llm-debug.js";
import type { MoltbookComment, MoltbookPost } from "./moltbook-api.js";
import type { MoltbookHeartbeatSources } from "./moltbook-venue.js";
import {
  candidateAllowed,
  type ActionBundleDecision,
  type ActionCandidateSource,
  type ConstrainedActionCandidate
} from "./action-planning.js";
import { activeQueuedActionIds } from "./action-execution.js";
import {
  canCreatePost,
  isNewAgent,
  planHeartbeatActions,
  postedWithinCooldown,
  type OutreachAgentState,
  type PlannedAction
} from "./policy.js";

export interface MoltbookActionPlanningInput {
  sources: MoltbookHeartbeatSources;
  state: OutreachAgentState;
  config?: MoltbookRuntimeConfig;
  policy?: Partial<MoltbookOutreachPolicyConfig>;
  now?: Date;
  mode?: "read_only" | "human_review" | "approved_autopost";
}

interface LlmBundleSelectionResponse {
  selectedCandidateIds?: string[];
  selectedWriteCandidateId?: string;
  rationale?: string;
}

interface MoltbookBundleSelectionInput {
  candidates: readonly ConstrainedActionCandidate[];
  config?: MoltbookRuntimeConfig;
  sources?: MoltbookHeartbeatSources;
  state?: OutreachAgentState;
  runId?: string;
  fetchImpl?: typeof fetch;
}

export function buildMoltbookActionCandidates(
  input: MoltbookActionPlanningInput
): ConstrainedActionCandidate[] {
  const now = input.now ?? new Date();
  const { sources, state } = input;
  const queuedActionIds = activeQueuedActionIds(state.queuedActionJobs);
  const planned = planHeartbeatActions({
    home: sources.home,
    followingFeed: sources.followingFeed,
    hotFeed: sources.hotFeed,
    exploreFeed: sources.exploreFeed,
    state,
    policy: input.policy,
    factSheet: sources.factSheet,
    profileCreatedAt: sources.me.agent?.created_at,
    now
  }).filter((action) => !plannedActionAlreadyQueued(action, queuedActionIds));
  const followingIds = new Set((sources.followingFeed.posts ?? []).map((post) => post.post_id ?? post.id).filter(Boolean));
  const hotIds = new Set((sources.hotFeed.posts ?? []).map((post) => post.post_id ?? post.id).filter(Boolean));
  const exploreIds = new Set((sources.exploreFeed.posts ?? []).map((post) => post.post_id ?? post.id).filter(Boolean));
  const constraintsForMode = (action: PlannedAction): ConstrainedActionCandidate["constraints"] => {
    if (input.mode === "approved_autopost") {
      return [];
    }
    if (action.type === "inspect_dms" || action.type === "noop") {
      return [];
    }
    return [
      {
        id: "venue_mode_blocks_publish",
        passed: false,
        severity: "block",
        reason: `Venue mode ${input.mode ?? "approved_autopost"} does not allow execution for ${action.type}.`
      }
    ];
  };

  const candidates = planned.map((action, index): ConstrainedActionCandidate => {
    const source = inferActionSource(action, followingIds, hotIds, exploreIds);
    const score = scorePlannedAction(action, index, source);
    const constraints = constraintsForMode(action);
    return {
      id: candidateIdForAction(action, index),
      venue: "moltbook",
      type: action.type,
      source,
      score,
      needsContent: action.type === "create_post" || action.type === "comment_on_post" || action.type === "reply_to_activity",
      reason: action.reason,
      surface: action.type === "comment_on_post" ? action.post.submolt_name : undefined,
      targetId:
        action.type === "reply_to_activity"
          ? action.activity.post_id
          : action.type === "comment_on_post"
            ? action.post.post_id ?? action.post.id
            : undefined,
      title:
        action.type === "reply_to_activity"
          ? action.activity.post_title
          : action.type === "comment_on_post"
            ? action.post.title
            : undefined,
      summary:
        action.type === "reply_to_activity"
          ? action.activity.preview
          : action.type === "comment_on_post"
            ? action.post.content_preview ?? action.post.content
            : undefined,
      raw: action,
      constraints,
      allowed: constraints.every((constraint) => constraint.passed || constraint.severity !== "block")
    };
  });

  const newAgent = isNewAgent(sources.me.agent?.created_at, state, now);
  const hasPendingPost = state.pendingWrites.some((entry) => entry.type === "post");
  const hasCreatePostCandidate = candidates.some((candidate) => candidate.type === "create_post");
  if (
    !hasCreatePostCandidate &&
    !hasPendingPost &&
    canCreatePost(state, newAgent, input.policy, now) &&
    !postedWithinCooldown(state, newAgent, now)
  ) {
    const constraints =
      input.mode === "approved_autopost"
        ? []
        : [
            {
              id: "venue_mode_blocks_publish",
              passed: false,
              severity: "block" as const,
              reason: `Venue mode ${input.mode ?? "approved_autopost"} does not allow execution for create_post.`
            }
          ];
    candidates.push({
      id: "candidate:create_post:cold_start",
      venue: "moltbook",
      type: "create_post",
      source: "cold_start",
      score: 12,
      needsContent: true,
      reason:
        "Optional cold-start post only when the bundle LLM judges it net-new versus recent Moltbook posts and our authored history.",
      constraints,
      allowed: constraints.every((constraint) => constraint.passed || constraint.severity !== "block"),
      raw: {
        type: "create_post",
        reason:
          "Optional cold-start post only when the bundle LLM judges it net-new versus recent Moltbook posts and our authored history."
      } satisfies PlannedAction
    });
  }

  return candidates;
}

export async function chooseMoltbookActionBundle(
  input: MoltbookBundleSelectionInput
): Promise<ActionBundleDecision> {
  const fallback = chooseMoltbookActionBundleFallback(input.candidates);
  const llmProvider = input.config ? buildMainLlmProvider(input.config, input.fetchImpl) : undefined;
  if (!llmProvider) {
    return fallback;
  }
  const allowed = input.candidates.filter((candidate) => candidateAllowed(candidate) && candidate.type !== "noop");
  if (allowed.length === 0) {
    return fallback;
  }
  const messages = buildBundleSelectionMessages({
    candidates: allowed,
    sources: input.sources,
    state: input.state
  });
  const debugInputPath = input.config
    ? await saveLlmDebugInput(input.config, {
        phase: "moltbook-bundle-choice",
        providerLabel: llmProvider.label,
        runId: input.runId,
        messages,
        context: {
          candidateIds: allowed.map((candidate) => candidate.id),
          sourceCounts: countSources(allowed)
        }
      })
    : undefined;
  try {
    const response = await llmProvider.createJsonCompletion<LlmBundleSelectionResponse>(messages);
    const sanitized = sanitizeBundleSelection(response, allowed);
    if (!sanitized) {
      return {
        ...fallback,
        debugInputPath
      };
    }
    return {
      ...sanitized,
      strategy: "llm",
      debugInputPath
    };
  } catch {
    return {
      ...fallback,
      debugInputPath
    };
  }
}

export function chooseMoltbookActionBundleFallback(
  candidates: readonly ConstrainedActionCandidate[]
): ActionBundleDecision {
  const allowed = candidates.filter((candidate) => candidateAllowed(candidate) && candidate.type !== "noop");
  const noContent = allowed.filter((candidate) => !candidate.needsContent);
  const writes = allowed.filter((candidate) => candidate.needsContent);
  const selectedNoContent: string[] = [];
  let upvotes = 0;
  let follows = 0;
  let inspectedDms = false;

  for (const candidate of [...noContent].sort((left, right) => right.score - left.score)) {
    if (candidate.type === "upvote_post") {
      if (upvotes >= 2) {
        continue;
      }
      upvotes += 1;
      selectedNoContent.push(candidate.id);
      continue;
    }
    if (candidate.type === "follow_agent") {
      if (follows >= 3) {
        continue;
      }
      follows += 1;
      selectedNoContent.push(candidate.id);
      continue;
    }
    if (candidate.type === "inspect_dms") {
      if (inspectedDms) {
        continue;
      }
      inspectedDms = true;
      selectedNoContent.push(candidate.id);
    }
  }

  const selectedWrite = [...writes]
    .sort(compareWriteCandidates)
    .find((candidate) => candidate.type !== "create_post");
  const selectedCandidateIds = [...selectedNoContent, ...(selectedWrite ? [selectedWrite.id] : [])];
  const deferredCandidateIds = allowed
    .map((candidate) => candidate.id)
    .filter((candidateId) => !selectedCandidateIds.includes(candidateId));

  return {
    selectedCandidateIds,
    selectedWriteCandidateId: selectedWrite?.id,
    selectedNoContentCandidateIds: selectedNoContent,
    deferredCandidateIds,
    strategy: "deterministic_fallback",
    rationale: selectedWrite
      ? `Selected ${selectedWrite.type} from ${selectedWrite.source} as the write slot and kept safe no-content actions alongside it.`
      : selectedNoContent.length > 0
        ? "Skipped cold-start posting; only safe no-content actions were selected."
        : "No legal action bundle beat doing nothing."
  };
}

function buildBundleSelectionMessages(input: {
  candidates: readonly ConstrainedActionCandidate[];
  sources?: MoltbookHeartbeatSources;
  state?: OutreachAgentState;
}): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are selecting a safe Moltbook action bundle for one heartbeat.",
        "Every candidate is optional — doing nothing is valid when no action clearly helps.",
        "You must choose only from the provided candidate ids.",
        "At most one write candidate may be selected, or omit all write candidates.",
        "Write candidates are create_post, comment_on_post, and reply_to_activity.",
        "No-content actions can accompany the write slot, but stay conservative.",
        "Prefer direct replies on our active threads first, then hot-thread comments, then cold-start posting last.",
        "Skip create_post when recentOwnPostsOnMoltbook, recentAuthoredHistory, or hot/explore feeds already cover the same thesis.",
        "Do not re-select candidates that already appear in queuedActionJobs with status queued or running.",
        "Use the action history, hot-thread summary, and recent activity on our own threads to avoid blind or repetitive choices.",
        "Do not invent ids. Do not select blocked candidates.",
        "Return one JSON object only.",
        "selectedCandidateIds must be an array of valid candidate ids.",
        "selectedWriteCandidateId must either be omitted or match one selected write candidate id.",
        "Return strict JSON with keys: selectedCandidateIds, selectedWriteCandidateId, rationale."
      ].join(" ")
    },
    {
      role: "user",
      content: JSON.stringify(buildBundleSelectionPayload(input), null, 2)
    }
  ];
}

function buildBundleSelectionPayload(input: {
  candidates: readonly ConstrainedActionCandidate[];
  sources?: MoltbookHeartbeatSources;
  state?: OutreachAgentState;
}) {
  const state = input.state;
  const sources = input.sources;
  return {
    heartbeatContext: {
      pendingDmRequests: sources?.home.your_direct_messages?.pending_request_count ?? 0,
      unreadNotifications: sources?.home.your_account.unread_notification_count ?? 0,
      pendingWrites: state?.pendingWrites.length ?? 0,
      queuedJobs: state?.queuedActionJobs.length ?? 0,
      dailyCommentCount: state?.dailyCommentCount ?? 0,
      dailyReplyCount: state?.dailyReplyCount ?? 0,
      dailyPostCount: state?.dailyPostCount ?? 0
    },
    recentActionHistory: summarizeRecentActionHistory(state),
    recentAuthoredHistory: summarizeRecentGeneratedHistory(state),
    recentOwnPostsOnMoltbook: summarizeRecentOwnPostsOnMoltbook(sources),
    recentActivityOnOurThreads: summarizeOwnThreadActivity(sources),
    hotThreads: summarizeFeedPosts(sources?.hotFeed.posts ?? [], 5),
    followingFeed: summarizeFeedPosts(sources?.followingFeed.posts ?? [], 3),
    exploreFeed: summarizeFeedPosts(sources?.exploreFeed.posts ?? [], 3),
    candidates: input.candidates.map((candidate) => buildBundleCandidatePayload(candidate, sources)),
    rules: {
      maxWriteCandidates: 1,
      maxUpvotes: 2,
      maxFollows: 3,
      maxInspectDms: 1
    }
  };
}

function sanitizeBundleSelection(
  response: LlmBundleSelectionResponse,
  allowedCandidates: readonly ConstrainedActionCandidate[]
): ActionBundleDecision | undefined {
  const allowedIds = new Set(allowedCandidates.map((candidate) => candidate.id));
  const selectedIds = Array.from(
    new Set((response.selectedCandidateIds ?? []).filter((candidateId) => allowedIds.has(candidateId)))
  );
  const writes = selectedIds.filter((candidateId) =>
    allowedCandidates.some((candidate) => candidate.id === candidateId && candidate.needsContent)
  );
  if (writes.length > 1) {
    return undefined;
  }
  const requestedWrite =
    response.selectedWriteCandidateId &&
    allowedCandidates.some(
      (candidate) =>
        candidate.id === response.selectedWriteCandidateId &&
        candidate.needsContent &&
        selectedIds.includes(candidate.id)
    )
      ? response.selectedWriteCandidateId
      : writes[0];
  const selectedNoContent: string[] = [];
  let upvotes = 0;
  let follows = 0;
  let inspectDms = 0;
  for (const candidateId of selectedIds) {
    if (candidateId === requestedWrite) {
      continue;
    }
    const candidate = allowedCandidates.find((entry) => entry.id === candidateId);
    if (!candidate || candidate.needsContent) {
      continue;
    }
    if (candidate.type === "upvote_post") {
      if (upvotes >= 2) {
        continue;
      }
      upvotes += 1;
      selectedNoContent.push(candidate.id);
      continue;
    }
    if (candidate.type === "follow_agent") {
      if (follows >= 3) {
        continue;
      }
      follows += 1;
      selectedNoContent.push(candidate.id);
      continue;
    }
    if (candidate.type === "inspect_dms") {
      if (inspectDms >= 1) {
        continue;
      }
      inspectDms += 1;
      selectedNoContent.push(candidate.id);
      continue;
    }
  }
  const finalSelectedIds = [...selectedNoContent, ...(requestedWrite ? [requestedWrite] : [])];
  if (finalSelectedIds.length === 0) {
    if (Array.isArray(response.selectedCandidateIds) && response.selectedCandidateIds.length === 0) {
      return {
        selectedCandidateIds: [],
        selectedNoContentCandidateIds: [],
        deferredCandidateIds: allowedCandidates.map((candidate) => candidate.id),
        rationale: response.rationale?.trim() || "LLM deferred all actions this heartbeat."
      };
    }
    return undefined;
  }
  return {
    selectedCandidateIds: finalSelectedIds,
    selectedWriteCandidateId: requestedWrite,
    selectedNoContentCandidateIds: selectedNoContent,
    deferredCandidateIds: allowedCandidates
      .map((candidate) => candidate.id)
      .filter((candidateId) => !finalSelectedIds.includes(candidateId)),
    rationale: response.rationale?.trim() || "LLM selected the heartbeat action bundle."
  };
}

function summarizeRecentActionHistory(state: OutreachAgentState | undefined) {
  if (!state) {
    return [];
  }
  return {
    engagementEvents: state.engagementEvents.slice(-10).map((event) => ({
      type: event.type,
      targetId: event.targetId,
      targetSummary: event.targetSummary,
      createdAt: event.createdAt
    })),
    pendingWrites: state.pendingWrites.slice(-5).map((entry) => ({
      type: entry.type,
      postId: entry.postId,
      targetCommentId: entry.targetCommentId,
      targetSummary: entry.targetSummary,
      createdAt: entry.createdAt
    })),
    queuedActionJobs: state.queuedActionJobs.slice(-12).map((job) => ({
      type: job.type,
      actionId: job.payload.id ?? job.actionId,
      candidateId: job.candidateId,
      status: job.status,
      notBefore: job.notBefore,
      createdAt: job.createdAt
    }))
  };
}

function summarizeRecentOwnPostsOnMoltbook(sources: MoltbookHeartbeatSources | undefined) {
  if (!sources) {
    return [];
  }
  return (sources.me.recentPosts ?? []).slice(0, 8).map((post) => ({
    postId: post.post_id ?? post.id,
    title: post.title,
    submolt: post.submolt_name,
    preview: trimText(post.content_preview ?? post.content, 220),
    createdAt: post.created_at
  }));
}

function summarizeRecentGeneratedHistory(state: OutreachAgentState | undefined) {
  if (!state) {
    return [];
  }
  return state.recentGeneratedArtifacts.slice(-5).map((artifact) => ({
    type: artifact.type,
    title: artifact.title,
    targetId: artifact.targetId,
    targetSummary: artifact.targetSummary,
    opening: artifact.content.slice(0, 180),
    createdAt: artifact.createdAt
  }));
}

function summarizeOwnThreadActivity(sources: MoltbookHeartbeatSources | undefined) {
  if (!sources) {
    return [];
  }
  return sources.home.activity_on_your_posts.slice(0, 3).map((activity) => ({
    postId: activity.post_id,
    postTitle: activity.post_title,
    submolt: activity.submolt_name,
    newNotificationCount: activity.new_notification_count,
    latestAt: activity.latest_at,
    latestCommenters: activity.latest_commenters ?? [],
    preview: trimText(activity.preview, 220),
    recentComments: summarizeComments(sources.activityCommentsByPostId[activity.post_id] ?? [], 6)
  }));
}

function summarizeFeedPosts(posts: readonly MoltbookPost[], limit: number) {
  return posts.slice(0, limit).map((post) => ({
    postId: post.post_id ?? post.id,
    title: post.title,
    authorName: post.author_name,
    submolt: post.submolt_name,
    upvotes: post.upvotes ?? 0,
    commentCount: post.comment_count ?? 0,
    preview: trimText(post.content_preview ?? post.content, 220)
  }));
}

function buildBundleCandidatePayload(
  candidate: ConstrainedActionCandidate,
  sources: MoltbookHeartbeatSources | undefined
) {
  const payload = {
    id: candidate.id,
    type: candidate.type,
    source: candidate.source,
    score: candidate.score,
    needsContent: candidate.needsContent,
    reason: candidate.reason,
    title: candidate.title,
    summary: trimText(candidate.summary, 220),
    constraints: candidate.constraints.map((constraint) => ({
      id: constraint.id,
      passed: constraint.passed,
      severity: constraint.severity,
      reason: constraint.reason
    }))
  };
  if (!sources || candidate.type !== "reply_to_activity") {
    return payload;
  }
  return {
    ...payload,
    recentComments: summarizeComments(sources.activityCommentsByPostId[candidate.targetId ?? ""] ?? [], 6)
  };
}

function summarizeComments(comments: readonly MoltbookComment[], limit: number) {
  return flattenComments(comments)
    .sort(compareCommentsByNewest)
    .slice(0, limit)
    .map((comment) => ({
      commentId: comment.id,
      parentId: comment.parent_id,
      authorName: comment.author_name ?? comment.author?.name,
      content: trimText(comment.content, 220),
      createdAt: comment.created_at
    }));
}

function flattenComments(comments: readonly MoltbookComment[]): MoltbookComment[] {
  const flattened: MoltbookComment[] = [];
  for (const comment of comments) {
    flattened.push(comment);
    if (comment.replies?.length) {
      flattened.push(...flattenComments(comment.replies));
    }
  }
  return flattened;
}

function compareCommentsByNewest(left: MoltbookComment, right: MoltbookComment): number {
  return Date.parse(right.created_at ?? "") - Date.parse(left.created_at ?? "");
}

function trimText(value: string | undefined, limit: number): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function plannedActionAlreadyQueued(action: PlannedAction, queuedActionIds: ReadonlySet<string>): boolean {
  switch (action.type) {
    case "follow_agent":
      return queuedActionIds.has(`follow:${action.agentName}`);
    case "upvote_post": {
      const postId = action.post.post_id ?? action.post.id;
      return Boolean(postId && queuedActionIds.has(`upvote:${postId}`));
    }
    case "comment_on_post": {
      const postId = action.post.post_id ?? action.post.id;
      return Boolean(postId && queuedActionIds.has(`comment:${postId}`));
    }
    case "create_post":
      return queuedActionIds.has("create-post");
    case "reply_to_activity":
    case "inspect_dms":
    case "noop":
      return false;
  }
}

function countSources(candidates: readonly ConstrainedActionCandidate[]) {
  return candidates.reduce<Record<string, number>>((counts, candidate) => {
    counts[candidate.source] = (counts[candidate.source] ?? 0) + 1;
    return counts;
  }, {});
}

export function plannedActionFromCandidate(candidate: ConstrainedActionCandidate): PlannedAction {
  return candidate.raw as PlannedAction;
}

function candidateIdForAction(action: PlannedAction, index: number): string {
  switch (action.type) {
    case "reply_to_activity":
      return `candidate:reply:${action.activity.post_id}`;
    case "comment_on_post":
      return `candidate:comment:${action.post.post_id ?? action.post.id ?? index}`;
    case "create_post":
      return "candidate:create_post:planned";
    case "upvote_post":
      return `candidate:upvote:${action.post.post_id ?? action.post.id ?? index}`;
    case "follow_agent":
      return `candidate:follow:${action.agentName}`;
    case "inspect_dms":
      return "candidate:inspect_dms";
    case "noop":
      return `candidate:noop:${index}`;
  }
}

function inferActionSource(
  action: PlannedAction,
  followingIds: ReadonlySet<string>,
  hotIds: ReadonlySet<string>,
  exploreIds: ReadonlySet<string>
): ActionCandidateSource {
  switch (action.type) {
    case "reply_to_activity":
      return "activity_reply";
    case "inspect_dms":
      return "dm_queue";
    case "create_post":
      return "cold_start";
    case "comment_on_post":
    case "upvote_post":
    case "follow_agent": {
      const postId = action.type === "follow_agent" ? undefined : action.post.post_id ?? action.post.id;
      if (postId && hotIds.has(postId)) {
        return "hot_thread";
      }
      if (postId && followingIds.has(postId)) {
        return "following_feed";
      }
      if (postId && exploreIds.has(postId)) {
        return "explore_feed";
      }
      return "explore_feed";
    }
    case "noop":
      return "cold_start";
  }
}

function scorePlannedAction(action: PlannedAction, index: number, source: ActionCandidateSource): number {
  const sourceBonus =
    source === "activity_reply"
      ? 100
      : source === "hot_thread"
        ? 70
        : source === "following_feed"
          ? 55
          : source === "explore_feed"
            ? 45
            : source === "dm_queue"
              ? 90
              : 30;
  switch (action.type) {
    case "reply_to_activity":
      return sourceBonus + 20 + (action.activity.new_notification_count ?? 0);
    case "comment_on_post":
      return sourceBonus + 10 + Math.min(20, action.post.upvotes ?? 0);
    case "create_post":
      return sourceBonus;
    case "upvote_post":
      return sourceBonus + Math.min(10, action.post.upvotes ?? 0);
    case "follow_agent":
      return sourceBonus + 5;
    case "inspect_dms":
      return sourceBonus;
    case "noop":
      return Math.max(0, 1 - index);
  }
}

function compareWriteCandidates(left: ConstrainedActionCandidate, right: ConstrainedActionCandidate): number {
  const typePriority = (candidate: ConstrainedActionCandidate): number =>
    candidate.type === "reply_to_activity"
      ? 3
      : candidate.source === "hot_thread" && candidate.type === "comment_on_post"
        ? 2
        : candidate.type === "comment_on_post"
          ? 1
          : 0;
  const typeDelta = typePriority(right) - typePriority(left);
  if (typeDelta !== 0) {
    return typeDelta;
  }
  return right.score - left.score;
}
