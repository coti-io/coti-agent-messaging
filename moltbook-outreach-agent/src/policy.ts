import type {
  MoltbookActivityItem,
  MoltbookComment,
  MoltbookFeedResponse,
  MoltbookHomeResponse,
  MoltbookPost
} from "./moltbook-api.js";
import type { ProductFactSheet } from "./product-facts.js";

export interface RecentGeneratedArtifact {
  id: string;
  type: "post" | "comment" | "reply";
  title?: string;
  content: string;
  targetId?: string;
  targetSummary?: string;
  createdAt: string;
}

export interface PendingWrite {
  id: string;
  type: "post" | "comment" | "reply";
  fingerprint: string;
  reconciliationMisses?: number;
  title?: string;
  content: string;
  postId?: string;
  targetCommentId?: string;
  targetSummary?: string;
  replyToAuthor?: string;
  createdAt: string;
}

export interface OutreachAgentState {
  firstSeenAt?: string;
  lastHeartbeatAt?: string;
  lastPostAt?: string;
  lastCommentAt?: string;
  dailyCommentDate?: string;
  dailyCommentCount: number;
  upvotedPostIds: string[];
  followedAgentNames: string[];
  repliedCommentIds: string[];
  createdPostFingerprints: string[];
  recentGeneratedArtifacts: RecentGeneratedArtifact[];
  pendingWrites: PendingWrite[];
}

export const MAX_OUTREACH_STATE_BYTES = 64 * 1024;
const MAX_UPVOTED_POST_IDS = 250;
const MAX_FOLLOWED_AGENT_NAMES = 100;
const MAX_REPLIED_COMMENT_IDS = 500;
const MAX_CREATED_POST_FINGERPRINTS = 50;
const MAX_RECENT_GENERATED_ARTIFACTS = 20;
const MAX_PENDING_WRITES = 10;
const MAX_STORED_ARTIFACT_TITLE_LENGTH = 140;
const MAX_STORED_ARTIFACT_CONTENT_LENGTH = 700;
const MAX_STORED_ARTIFACT_TARGET_SUMMARY_LENGTH = 280;
const REPLY_GENERIC_PRAISE_PATTERNS = [
  /\b(?:great|nice|cool|awesome|amazing|love|loving)\b.{0,24}\b(?:project|work|post|ecosystem|community)\b/i,
  /\b(?:bullish|based|gm|wagmi|lfgo|lfg)\b/i,
  /\bthanks for sharing\b/i,
  /\bkeep it up\b/i
] as const;
const REPLY_SPAM_PATTERNS = [
  /\bspam\b/i,
  /\bairdrop\b/i,
  /\bgiveaway\b/i,
  /\bpromo(?:tion)?\b/i,
  /\b(?:dm|pm)\b.{0,12}\b(?:me|for)\b/i,
  /\bcheck (?:my|our) profile\b/i
] as const;
const REPLY_OVERLAP_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "our",
  "so",
  "that",
  "the",
  "their",
  "this",
  "to",
  "us",
  "we",
  "what",
  "with",
  "you",
  "your"
]);

export type PlannedAction =
  | {
      type: "reply_to_activity";
      activity: MoltbookActivityItem;
      reason: string;
    }
  | {
      type: "upvote_post";
      post: MoltbookPost;
      reason: string;
    }
  | {
      type: "follow_agent";
      agentName: string;
      reason: string;
    }
  | {
      type: "comment_on_post";
      post: MoltbookPost;
      reason: string;
    }
  | {
      type: "create_post";
      reason: string;
    }
  | {
      type: "inspect_dms";
      reason: string;
    }
  | {
      type: "noop";
      reason: string;
    };

export interface ReplyTarget {
  commentId: string;
  postId: string;
  authorName?: string;
  content: string;
}

export function createInitialState(): OutreachAgentState {
  return {
    dailyCommentCount: 0,
    upvotedPostIds: [],
    followedAgentNames: [],
    repliedCommentIds: [],
    createdPostFingerprints: [],
    recentGeneratedArtifacts: [],
    pendingWrites: []
  };
}

function uniqueRecent(values: readonly string[], limit: number): string[] {
  return [...new Set(values)].slice(-limit);
}

function clampText(value: string | undefined, limit: number): string | undefined {
  if (!value) {
    return value;
  }

  return value.length > limit ? value.slice(0, limit) : value;
}

function approximateStateSizeBytes(state: OutreachAgentState): number {
  return Buffer.byteLength(JSON.stringify(state), "utf8");
}

function enforceStateSizeLimit(state: OutreachAgentState): OutreachAgentState {
  if (approximateStateSizeBytes(state) <= MAX_OUTREACH_STATE_BYTES) {
    return state;
  }

  const nextState: OutreachAgentState = {
    ...state,
    recentGeneratedArtifacts: state.recentGeneratedArtifacts.map((artifact) => ({
      ...artifact,
      title: clampText(artifact.title, MAX_STORED_ARTIFACT_TITLE_LENGTH),
      content: clampText(artifact.content, MAX_STORED_ARTIFACT_CONTENT_LENGTH) ?? "",
      targetSummary: clampText(artifact.targetSummary, MAX_STORED_ARTIFACT_TARGET_SUMMARY_LENGTH)
    }))
  };

  while (
    approximateStateSizeBytes(nextState) > MAX_OUTREACH_STATE_BYTES &&
    nextState.recentGeneratedArtifacts.length > 0
  ) {
    nextState.recentGeneratedArtifacts = nextState.recentGeneratedArtifacts.slice(1);
  }

  if (approximateStateSizeBytes(nextState) <= MAX_OUTREACH_STATE_BYTES) {
    return nextState;
  }

  const reducers: Array<(current: OutreachAgentState) => OutreachAgentState> = [
    (current) => ({
      ...current,
      repliedCommentIds: current.repliedCommentIds.slice(-250)
    }),
    (current) => ({
      ...current,
      upvotedPostIds: current.upvotedPostIds.slice(-125)
    }),
    (current) => ({
      ...current,
      followedAgentNames: current.followedAgentNames.slice(-50)
    }),
    (current) => ({
      ...current,
      createdPostFingerprints: current.createdPostFingerprints.slice(-25)
    })
  ];

  let reducedState = nextState;
  for (const reduce of reducers) {
    if (approximateStateSizeBytes(reducedState) <= MAX_OUTREACH_STATE_BYTES) {
      break;
    }
    reducedState = reduce(reducedState);
  }

  return reducedState;
}

export function normalizeState(
  state: Partial<OutreachAgentState> | undefined,
  now = new Date()
): OutreachAgentState {
  const initial = createInitialState();
  const normalized: OutreachAgentState = {
    firstSeenAt: state?.firstSeenAt,
    lastHeartbeatAt: state?.lastHeartbeatAt,
    lastPostAt: state?.lastPostAt,
    lastCommentAt: state?.lastCommentAt,
    dailyCommentDate: state?.dailyCommentDate,
    dailyCommentCount: state?.dailyCommentCount ?? initial.dailyCommentCount,
    upvotedPostIds: state?.upvotedPostIds ?? initial.upvotedPostIds,
    followedAgentNames: state?.followedAgentNames ?? initial.followedAgentNames,
    repliedCommentIds: state?.repliedCommentIds ?? initial.repliedCommentIds,
    createdPostFingerprints: state?.createdPostFingerprints ?? initial.createdPostFingerprints,
    recentGeneratedArtifacts: state?.recentGeneratedArtifacts ?? initial.recentGeneratedArtifacts,
    pendingWrites: state?.pendingWrites ?? initial.pendingWrites
  };

  const today = now.toISOString().slice(0, 10);
  if (normalized.dailyCommentDate !== today) {
    normalized.dailyCommentDate = today;
    normalized.dailyCommentCount = 0;
  }

  normalized.upvotedPostIds = uniqueRecent(normalized.upvotedPostIds, MAX_UPVOTED_POST_IDS);
  normalized.followedAgentNames = uniqueRecent(normalized.followedAgentNames, MAX_FOLLOWED_AGENT_NAMES);
  normalized.repliedCommentIds = uniqueRecent(normalized.repliedCommentIds, MAX_REPLIED_COMMENT_IDS);
  normalized.createdPostFingerprints = uniqueRecent(
    normalized.createdPostFingerprints,
    MAX_CREATED_POST_FINGERPRINTS
  );
  normalized.recentGeneratedArtifacts = normalized.recentGeneratedArtifacts
    .map((artifact) => ({
      ...artifact,
      title: clampText(artifact.title, MAX_STORED_ARTIFACT_TITLE_LENGTH),
      content: clampText(artifact.content, MAX_STORED_ARTIFACT_CONTENT_LENGTH) ?? "",
      targetSummary: clampText(artifact.targetSummary, MAX_STORED_ARTIFACT_TARGET_SUMMARY_LENGTH)
    }))
    .slice(-MAX_RECENT_GENERATED_ARTIFACTS);
  normalized.pendingWrites = normalized.pendingWrites
    .map((pendingWrite) => ({
      ...pendingWrite,
      reconciliationMisses: pendingWrite.reconciliationMisses ?? 0
    }))
    .slice(-MAX_PENDING_WRITES);

  if (!normalized.firstSeenAt) {
    normalized.firstSeenAt = now.toISOString();
  }

  return enforceStateSizeLimit(normalized);
}

function hoursSince(isoTimestamp: string | undefined, now: Date): number | undefined {
  if (!isoTimestamp) {
    return undefined;
  }

  const timestamp = Date.parse(isoTimestamp);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  return (now.getTime() - timestamp) / 3_600_000;
}

export function isNewAgent(
  profileCreatedAt: string | undefined,
  state: OutreachAgentState,
  now = new Date()
): boolean {
  const createdHoursAgo =
    hoursSince(profileCreatedAt, now) ?? hoursSince(state.firstSeenAt, now) ?? Number.POSITIVE_INFINITY;
  return createdHoursAgo < 24;
}

export function commentCooldownMs(isNew: boolean): number {
  return (isNew ? 60 : 20) * 1_000;
}

export function commentLimitPerDay(isNew: boolean): number {
  return isNew ? 20 : 50;
}

export function postCooldownMs(isNew: boolean): number {
  return (isNew ? 120 : 30) * 60 * 1_000;
}

export function canCreatePost(
  state: OutreachAgentState,
  isNew: boolean,
  now = new Date()
): boolean {
  const sinceLastPostHours = hoursSince(state.lastPostAt, now);
  if (sinceLastPostHours === undefined) {
    return true;
  }

  return sinceLastPostHours * 3_600_000 >= postCooldownMs(isNew);
}

export function canComment(
  state: OutreachAgentState,
  isNew: boolean,
  now = new Date()
): boolean {
  if (state.dailyCommentCount >= commentLimitPerDay(isNew)) {
    return false;
  }

  const sinceLastCommentMs = (hoursSince(state.lastCommentAt, now) ?? Number.POSITIVE_INFINITY) * 3_600_000;
  return sinceLastCommentMs >= commentCooldownMs(isNew);
}

function scorePost(post: MoltbookPost): number {
  const haystack = `${post.title} ${post.content ?? ""} ${post.content_preview ?? ""}`.toLowerCase();
  const weightedTerms: Array<[string, number]> = [
    ["private", 3],
    ["privacy", 3],
    ["message", 2],
    ["messaging", 2],
    ["inbox", 2],
    ["coordination", 3],
    ["collaboration", 2],
    ["agent", 2],
    ["agents", 2],
    ["mcp", 3],
    ["sdk", 2],
    ["integration", 2],
    ["workflow", 2],
    ["reward", 1],
    ["rewards", 1],
    ["coti", 2]
  ];

  return weightedTerms.reduce((score, [term, weight]) => {
    return haystack.includes(term) ? score + weight : score;
  }, 0);
}

function normalizeFingerprint(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function planHeartbeatActions(input: {
  home: MoltbookHomeResponse;
  followingFeed?: MoltbookFeedResponse;
  exploreFeed?: MoltbookFeedResponse;
  state: OutreachAgentState;
  factSheet: ProductFactSheet;
  profileCreatedAt?: string;
  now?: Date;
}): PlannedAction[] {
  const now = input.now ?? new Date();
  const state = normalizeState(input.state, now);
  const actions: PlannedAction[] = [];
  const newAgent = isNewAgent(input.profileCreatedAt, state, now);
  const pendingCommentPostIds = new Set(
    state.pendingWrites.filter((entry) => entry.type === "comment" && entry.postId).map((entry) => entry.postId!)
  );
  const hasPendingPost = state.pendingWrites.some((entry) => entry.type === "post");

  if (input.home.activity_on_your_posts.length > 0) {
    for (const activity of input.home.activity_on_your_posts.slice(0, 3)) {
      actions.push({
        type: "reply_to_activity",
        activity,
        reason: "Replying to engagement on our own posts is the highest-value action."
      });
    }
  }

  if ((input.home.your_direct_messages?.pending_request_count ?? 0) > 0) {
    actions.push({
      type: "inspect_dms",
      reason: "There are pending direct-message requests that deserve review."
    });
  }

  const candidatePosts = [
    ...(input.home.posts_from_accounts_you_follow?.posts ?? []),
    ...(input.followingFeed?.posts ?? []),
    ...(input.exploreFeed?.posts ?? [])
  ];

  for (const post of candidatePosts) {
    const postId = post.post_id ?? post.id;
    if (!postId || state.upvotedPostIds.includes(postId)) {
      continue;
    }

    if (scorePost(post) < 3) {
      continue;
    }

    actions.push({
      type: "upvote_post",
      post,
      reason: "This post matches our topic space and is worth rewarding."
    });

    if (post.author_name && !state.followedAgentNames.includes(post.author_name) && scorePost(post) >= 5) {
      actions.push({
        type: "follow_agent",
        agentName: post.author_name,
        reason: "The author is posting repeatedly on topics we care about."
      });
    }

    if (actions.filter((action) => action.type === "upvote_post").length >= 2) {
      break;
    }
  }

  const commentTargets = candidatePosts.filter((post) => {
    const postId = post.post_id ?? post.id;
    return (
      Boolean(postId) &&
      !pendingCommentPostIds.has(postId!) &&
      scorePost(post) >= 4 &&
      canComment(state, newAgent, now)
    );
  });

  for (const commentTarget of commentTargets.slice(0, 3)) {
    actions.push({
      type: "comment_on_post",
      post: commentTarget,
      reason: "This discussion is close enough to private messaging that we can add value."
    });
  }

  if (
    input.home.activity_on_your_posts.length === 0 &&
    canCreatePost(state, newAgent, now) &&
    state.createdPostFingerprints.length < 50 &&
    !hasPendingPost
  ) {
    actions.push({
      type: "create_post",
      reason: "No urgent replies are waiting and we have room for one substantive outreach post."
    });
  }

  if (actions.length === 0) {
    return [
      {
        type: "noop",
        reason: "Nothing valuable to do right now without forcing low-signal activity."
      }
    ];
  }

  return actions;
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

function commentAuthorName(comment: MoltbookComment): string | undefined {
  return comment.author_name ?? comment.author?.name;
}

function tokenizeReplyText(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 4 && !REPLY_OVERLAP_STOP_WORDS.has(token));
}

function overlapCount(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const rightTokens = new Set(right);
  return left.reduce((count, token) => count + (rightTokens.has(token) ? 1 : 0), 0);
}

function isReplyWorthyComment(comment: MoltbookComment, postTitle: string): boolean {
  const content = comment.content.trim();
  if (!content) {
    return false;
  }

  if (REPLY_SPAM_PATTERNS.some((pattern) => pattern.test(content))) {
    return false;
  }

  const normalized = content.toLowerCase();
  const hasQuestion = normalized.includes("?");
  const wordCount = tokenizeReplyText(content).length;
  const titleOverlap = overlapCount(tokenizeReplyText(content), tokenizeReplyText(postTitle));
  const hasGenericPraise = REPLY_GENERIC_PRAISE_PATTERNS.some((pattern) => pattern.test(content));
  const hasMeaningfulLength = content.length >= 45 || wordCount >= 6;

  if (hasGenericPraise && !hasQuestion && titleOverlap === 0) {
    return false;
  }

  if (!hasQuestion && !hasMeaningfulLength) {
    return false;
  }

  if (!hasQuestion && titleOverlap === 0 && wordCount < 8) {
    return false;
  }

  return true;
}

export function listReplyTargets(input: {
  postId: string;
  postTitle: string;
  comments: readonly MoltbookComment[];
  state: OutreachAgentState;
  agentName: string;
}): ReplyTarget[] {
  const pendingReplyTargetIds = new Set(
    input.state.pendingWrites
      .filter((entry) => entry.type === "reply" && entry.targetCommentId)
      .map((entry) => entry.targetCommentId!)
  );
  return flattenComments(input.comments)
    .filter((comment) => {
      const author = commentAuthorName(comment);
      if (author && author === input.agentName) {
        return false;
      }

      return (
        !input.state.repliedCommentIds.includes(comment.id) &&
        !pendingReplyTargetIds.has(comment.id) &&
        isReplyWorthyComment(comment, input.postTitle)
      );
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.created_at ?? "") || 0;
      const rightTime = Date.parse(right.created_at ?? "") || 0;
      return rightTime - leftTime;
    })
    .map((target) => ({
      commentId: target.id,
      postId: input.postId,
      authorName: commentAuthorName(target),
      content: target.content
    }));
}

export function chooseReplyTarget(input: {
  postId: string;
  postTitle: string;
  comments: readonly MoltbookComment[];
  state: OutreachAgentState;
  agentName: string;
}): ReplyTarget | undefined {
  return listReplyTargets(input)[0];
}

export function applyActionResult(
  state: OutreachAgentState,
  action:
    | {
        type: "create_post";
        fingerprint: string;
        title: string;
        content: string;
      }
    | {
        type: "comment";
        commentId: string;
        content: string;
        targetSummary?: string;
        replyToAuthor?: string;
      }
    | { type: "upvote_post"; postId: string }
    | { type: "follow_agent"; agentName: string },
  now = new Date()
): OutreachAgentState {
  const nextState = normalizeState(state, now);
  nextState.lastHeartbeatAt = now.toISOString();

  switch (action.type) {
    case "create_post":
      nextState.lastPostAt = now.toISOString();
      nextState.createdPostFingerprints = uniqueRecent(
        [...nextState.createdPostFingerprints, action.fingerprint],
        MAX_CREATED_POST_FINGERPRINTS
      );
      const artifact: RecentGeneratedArtifact = {
        id: `post:${action.fingerprint}`,
        type: "post",
        title: action.title,
        content: action.content,
        createdAt: now.toISOString()
      };
      nextState.recentGeneratedArtifacts = [
        ...nextState.recentGeneratedArtifacts,
        artifact
      ].slice(-MAX_RECENT_GENERATED_ARTIFACTS);
      return nextState;
    case "comment":
      nextState.lastCommentAt = now.toISOString();
      nextState.dailyCommentCount += 1;
      nextState.repliedCommentIds = uniqueRecent(
        [...nextState.repliedCommentIds, action.commentId],
        MAX_REPLIED_COMMENT_IDS
      );
      const commentArtifact: RecentGeneratedArtifact = {
        id: action.commentId,
        type: action.replyToAuthor ? "reply" : "comment",
        content: action.content,
        targetId: action.commentId,
        targetSummary: action.targetSummary,
        createdAt: now.toISOString()
      };
      nextState.recentGeneratedArtifacts = [
        ...nextState.recentGeneratedArtifacts,
        commentArtifact
      ].slice(-MAX_RECENT_GENERATED_ARTIFACTS);
      return nextState;
    case "upvote_post":
      nextState.upvotedPostIds = uniqueRecent(
        [...nextState.upvotedPostIds, action.postId],
        MAX_UPVOTED_POST_IDS
      );
      return nextState;
    case "follow_agent":
      nextState.followedAgentNames = uniqueRecent(
        [...nextState.followedAgentNames, action.agentName],
        MAX_FOLLOWED_AGENT_NAMES
      );
      return nextState;
  }
}

export function contentFingerprint(value: string): string {
  return normalizeFingerprint(value).slice(0, 160);
}

