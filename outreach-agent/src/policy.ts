import type {
  MoltbookActivityItem,
  MoltbookComment,
  MoltbookFeedResponse,
  MoltbookHomeResponse,
  MoltbookPost
} from "./moltbook-api.js";
import type { MoltbookOutreachPolicyConfig } from "./config.js";
import type { ProductFactSheet } from "./product-facts.js";
import type { OutreachRef } from "./outreach-attribution.js";
import type { LayoutVariant, PromptParameterSet } from "./prompt-profile.js";

export interface RecentGeneratedArtifact {
  id: string;
  type: "post" | "comment" | "reply";
  title?: string;
  content: string;
  targetId?: string;
  targetSummary?: string;
  promptProfileId?: string;
  promptParameters?: PromptParameterSet;
  layout?: LayoutVariant;
  ctaUrl?: string;
  outreachRef?: OutreachRef;
  structuralFingerprint?: string;
  clickCount?: number;
  privateMessageCount?: number;
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
  promptProfileId?: string;
  promptParameters?: PromptParameterSet;
  layout?: LayoutVariant;
  ctaUrl?: string;
  outreachRef?: OutreachRef;
  structuralFingerprint?: string;
  createdAt: string;
}

export type EngagementEventType = "post" | "comment" | "reply" | "upvote" | "follow";

export interface EngagementCounts {
  posts: number;
  comments: number;
  replies: number;
  upvotes: number;
  follows: number;
  total: number;
}

export interface EngagementEvent {
  id: string;
  type: EngagementEventType;
  createdAt: string;
  targetId?: string;
  targetSummary?: string;
}

export interface EngagementSummary {
  generatedAt: string;
  windows: {
    last2Hours: EngagementCounts;
    lastDay: EngagementCounts;
    lastWeek: EngagementCounts;
  };
  total: EngagementCounts;
}

export interface OutreachAgentState {
  agentId?: string;
  firstSeenAt?: string;
  lastHeartbeatAt?: string;
  lastPostAt?: string;
  lastCommentAt?: string;
  dailyPostDate?: string;
  dailyPostCount: number;
  dailyCommentDate?: string;
  dailyCommentCount: number;
  dailyTopLevelCommentCount: number;
  dailyReplyCount: number;
  upvotedPostIds: string[];
  followedAgentNames: string[];
  repliedCommentIds: string[];
  createdPostFingerprints: string[];
  recentGeneratedArtifacts: RecentGeneratedArtifact[];
  pendingWrites: PendingWrite[];
  engagementEvents: EngagementEvent[];
  engagementTotals: EngagementCounts;
}

export type PrivateMessageEscalationReason =
  | "user_requested"
  | "credentials_or_secrets"
  | "privacy_sensitive"
  | "account_specific"
  | "complex_troubleshooting";

export interface PrivateMessageEscalationAssessment {
  shouldEscalate: boolean;
  reason?: PrivateMessageEscalationReason;
  requiresPublicReplyFirst: boolean;
  explanation: string;
}

export const MAX_OUTREACH_STATE_BYTES = 64 * 1024;
const MAX_UPVOTED_POST_IDS = 250;
const MAX_FOLLOWED_AGENT_NAMES = 100;
const MAX_REPLIED_COMMENT_IDS = 500;
const MAX_CREATED_POST_FINGERPRINTS = 50;
const MAX_RECENT_GENERATED_ARTIFACTS = 20;
const MAX_PENDING_WRITES = 10;
const MAX_ENGAGEMENT_EVENTS = 1_000;
const ENGAGEMENT_EVENT_RETENTION_MS = 8 * 24 * 60 * 60 * 1_000;
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
const PM_USER_REQUEST_PATTERNS = [
  /\b(?:dm|pm|message)\b.{0,16}\b(?:me|you)\b/i,
  /\btake (?:this|it) (?:to|into) (?:dm|pm|message)s?\b/i,
  /\bcan (?:i|we) (?:dm|pm|message)\b/i
] as const;
const PM_CREDENTIAL_OR_SECRET_PATTERNS = [
  /\bapi[- ]?key\b/i,
  /\bprivate key\b/i,
  /\bseed phrase\b/i,
  /\bmnemonic\b/i,
  /\bsecret\b/i,
  /\btoken\b.{0,16}\bleak|leaked\b/i,
  /\bcredential(?:s)?\b/i
] as const;
const PM_PRIVACY_PATTERNS = [
  /\bprivacy-sensitive\b/i,
  /\bprivate\b.{0,24}\bdetails?\b/i,
  /\bconfidential\b/i,
  /\bsecurity incident\b/i,
  /\bbreach\b/i,
  /\bwallet address\b/i,
  /\bpii\b/i
] as const;
const PM_ACCOUNT_SPECIFIC_PATTERNS = [
  /\bmy account\b/i,
  /\bour account\b/i,
  /\btenant\b/i,
  /\bworkspace\b/i,
  /\buser id\b/i,
  /\binstall id\b/i,
  /\bsession id\b/i,
  /\btx hash\b/i,
  /\border id\b/i
] as const;
const PM_COMPLEX_TROUBLESHOOTING_PATTERNS = [
  /\bdebug\b/i,
  /\btroubleshoot(?:ing)?\b/i,
  /\blog(?:s)?\b/i,
  /\bstack trace\b/i,
  /\brepro(?:duction)?\b/i,
  /\bconfig(?:uration)?\b/i,
  /\btrace\b/i,
  /\berror\b/i,
  /\bfailing\b/i,
  /\bdoes not work\b/i
] as const;

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

export function assessPrivateMessageEscalation(input: {
  text: string;
  userRequestedPrivateReply?: boolean;
}): PrivateMessageEscalationAssessment {
  const text = input.text.trim();
  const userRequestedPrivateReply =
    input.userRequestedPrivateReply ?? PM_USER_REQUEST_PATTERNS.some((pattern) => pattern.test(text));
  if (userRequestedPrivateReply) {
    return {
      shouldEscalate: true,
      reason: "user_requested",
      requiresPublicReplyFirst: false,
      explanation: "The user explicitly asked to move the conversation into a private channel."
    };
  }

  if (PM_CREDENTIAL_OR_SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      shouldEscalate: true,
      reason: "credentials_or_secrets",
      requiresPublicReplyFirst: false,
      explanation: "The thread references credentials, secrets, or other details that should not stay public."
    };
  }

  if (PM_ACCOUNT_SPECIFIC_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      shouldEscalate: true,
      reason: "account_specific",
      requiresPublicReplyFirst: true,
      explanation: "The user appears to need account-specific investigation rather than a generic public answer."
    };
  }

  const troubleshootingSignals = PM_COMPLEX_TROUBLESHOOTING_PATTERNS.filter((pattern) => pattern.test(text)).length;
  if (troubleshootingSignals >= 2) {
    return {
      shouldEscalate: true,
      reason: "complex_troubleshooting",
      requiresPublicReplyFirst: true,
      explanation: "The thread looks like multi-step troubleshooting that may need logs or iterative debugging."
    };
  }

  if (PM_PRIVACY_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      shouldEscalate: true,
      reason: "privacy_sensitive",
      requiresPublicReplyFirst: true,
      explanation: "The user is asking about sensitive details that are safer to handle privately after a useful public answer."
    };
  }

  return {
    shouldEscalate: false,
    requiresPublicReplyFirst: true,
    explanation: "A public answer should come first because the thread does not show a clear private-message need."
  };
}

export interface ReplyTarget {
  commentId: string;
  postId: string;
  authorName?: string;
  content: string;
}

export function createInitialState(): OutreachAgentState {
  return {
    dailyPostCount: 0,
    dailyCommentCount: 0,
    dailyTopLevelCommentCount: 0,
    dailyReplyCount: 0,
    upvotedPostIds: [],
    followedAgentNames: [],
    repliedCommentIds: [],
    createdPostFingerprints: [],
    recentGeneratedArtifacts: [],
    pendingWrites: [],
    engagementEvents: [],
    engagementTotals: createEmptyEngagementCounts()
  };
}

export function topLevelCommentParentKey(postId: string): string {
  return `post:${postId}`;
}

export function replyParentKey(commentId: string): string {
  return `comment:${commentId}`;
}

function hasHandledTopLevelCommentParent(handledParentIds: readonly string[], postId: string): boolean {
  return handledParentIds.includes(topLevelCommentParentKey(postId));
}

function hasHandledReplyParent(handledParentIds: readonly string[], commentId: string): boolean {
  return handledParentIds.includes(replyParentKey(commentId)) || handledParentIds.includes(commentId);
}

function createEmptyEngagementCounts(): EngagementCounts {
  return {
    posts: 0,
    comments: 0,
    replies: 0,
    upvotes: 0,
    follows: 0,
    total: 0
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

function normalizeEngagementCounts(counts: Partial<EngagementCounts> | undefined): EngagementCounts {
  const normalized = {
    ...createEmptyEngagementCounts(),
    ...counts
  };
  normalized.total =
    normalized.posts +
    normalized.comments +
    normalized.replies +
    normalized.upvotes +
    normalized.follows;
  return normalized;
}

function engagementCountKey(type: EngagementEventType): keyof Omit<EngagementCounts, "total"> {
  switch (type) {
    case "post":
      return "posts";
    case "comment":
      return "comments";
    case "reply":
      return "replies";
    case "upvote":
      return "upvotes";
    case "follow":
      return "follows";
  }
}

function countEngagements(events: readonly EngagementEvent[]): EngagementCounts {
  const counts = createEmptyEngagementCounts();
  for (const event of events) {
    counts[engagementCountKey(event.type)] += 1;
    counts.total += 1;
  }
  return counts;
}

function trimEngagementEvents(
  events: readonly EngagementEvent[],
  now = new Date()
): EngagementEvent[] {
  const cutoff = now.getTime() - ENGAGEMENT_EVENT_RETENTION_MS;
  return events
    .filter((event) => {
      const timestamp = Date.parse(event.createdAt);
      return !Number.isNaN(timestamp) && timestamp >= cutoff;
    })
    .slice(-MAX_ENGAGEMENT_EVENTS);
}

function recordEngagementEvent(
  state: OutreachAgentState,
  event: EngagementEvent,
  now = new Date()
): OutreachAgentState {
  if (state.engagementEvents.some((existing) => existing.id === event.id)) {
    return state;
  }

  const totals = normalizeEngagementCounts(state.engagementTotals);
  totals[engagementCountKey(event.type)] += 1;
  totals.total += 1;

  return {
    ...state,
    engagementEvents: trimEngagementEvents([...state.engagementEvents, event], now),
    engagementTotals: totals
  };
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
    }),
    (current) => ({
      ...current,
      engagementEvents: current.engagementEvents.slice(-500)
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
    agentId: state?.agentId,
    firstSeenAt: state?.firstSeenAt,
    lastHeartbeatAt: state?.lastHeartbeatAt,
    lastPostAt: state?.lastPostAt,
    lastCommentAt: state?.lastCommentAt,
    dailyPostDate: state?.dailyPostDate,
    dailyPostCount: state?.dailyPostCount ?? initial.dailyPostCount,
    dailyCommentDate: state?.dailyCommentDate,
    dailyCommentCount: state?.dailyCommentCount ?? initial.dailyCommentCount,
    dailyTopLevelCommentCount:
      state?.dailyTopLevelCommentCount ?? initial.dailyTopLevelCommentCount,
    dailyReplyCount: state?.dailyReplyCount ?? initial.dailyReplyCount,
    upvotedPostIds: state?.upvotedPostIds ?? initial.upvotedPostIds,
    followedAgentNames: state?.followedAgentNames ?? initial.followedAgentNames,
    repliedCommentIds: state?.repliedCommentIds ?? initial.repliedCommentIds,
    createdPostFingerprints: state?.createdPostFingerprints ?? initial.createdPostFingerprints,
    recentGeneratedArtifacts: state?.recentGeneratedArtifacts ?? initial.recentGeneratedArtifacts,
    pendingWrites: state?.pendingWrites ?? initial.pendingWrites,
    engagementEvents: state?.engagementEvents ?? initial.engagementEvents,
    engagementTotals: normalizeEngagementCounts(state?.engagementTotals)
  };

  const today = now.toISOString().slice(0, 10);
  if (normalized.dailyPostDate !== today) {
    normalized.dailyPostDate = today;
    normalized.dailyPostCount = 0;
  }

  if (normalized.dailyCommentDate !== today) {
    normalized.dailyCommentDate = today;
    normalized.dailyCommentCount = 0;
    normalized.dailyTopLevelCommentCount = 0;
    normalized.dailyReplyCount = 0;
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
  normalized.engagementEvents = trimEngagementEvents(
    normalized.engagementEvents.map((event) => ({
      ...event,
      targetSummary: clampText(event.targetSummary, MAX_STORED_ARTIFACT_TARGET_SUMMARY_LENGTH)
    })),
    now
  );

  if (!normalized.firstSeenAt) {
    normalized.firstSeenAt = now.toISOString();
  }

  return enforceStateSizeLimit(normalized);
}

export function getEngagementSummary(
  state: OutreachAgentState,
  now = new Date()
): EngagementSummary {
  const normalized = normalizeState(state, now);
  const timestamp = now.getTime();
  const eventsSince = (durationMs: number) =>
    normalized.engagementEvents.filter((event) => {
      const eventTimestamp = Date.parse(event.createdAt);
      return !Number.isNaN(eventTimestamp) && timestamp - eventTimestamp <= durationMs;
    });

  return {
    generatedAt: now.toISOString(),
    windows: {
      last2Hours: countEngagements(eventsSince(2 * 60 * 60 * 1_000)),
      lastDay: countEngagements(eventsSince(24 * 60 * 60 * 1_000)),
      lastWeek: countEngagements(eventsSince(7 * 24 * 60 * 60 * 1_000))
    },
    total: normalizeEngagementCounts(normalized.engagementTotals)
  };
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

function resolveOutreachPolicyConfig(
  policy?: Partial<MoltbookOutreachPolicyConfig>
): MoltbookOutreachPolicyConfig {
  return {
    commentLimitNewAgentPerDay:
      policy?.commentLimitNewAgentPerDay ?? DEFAULT_OUTREACH_POLICY_CONFIG.commentLimitNewAgentPerDay,
    commentLimitEstablishedPerDay:
      policy?.commentLimitEstablishedPerDay ??
      DEFAULT_OUTREACH_POLICY_CONFIG.commentLimitEstablishedPerDay,
    postLimitNewAgentPerDay:
      policy?.postLimitNewAgentPerDay ?? DEFAULT_OUTREACH_POLICY_CONFIG.postLimitNewAgentPerDay,
    postLimitEstablishedPerDay:
      policy?.postLimitEstablishedPerDay ?? DEFAULT_OUTREACH_POLICY_CONFIG.postLimitEstablishedPerDay
  };
}

export function commentLimitPerDay(
  isNew: boolean,
  policy?: Partial<MoltbookOutreachPolicyConfig>
): number {
  const resolved = resolveOutreachPolicyConfig(policy);
  return isNew ? resolved.commentLimitNewAgentPerDay : resolved.commentLimitEstablishedPerDay;
}

export function postLimitPerDay(
  isNew: boolean,
  policy?: Partial<MoltbookOutreachPolicyConfig>
): number | undefined {
  const resolved = resolveOutreachPolicyConfig(policy);
  return isNew ? resolved.postLimitNewAgentPerDay : resolved.postLimitEstablishedPerDay;
}

export interface CommentReadiness {
  allowed: boolean;
  reason?: "daily_limit" | "paced_cooldown";
  waitMs: number;
  minimumIntervalMs: number;
  limitPerDay: number;
  usedCount: number;
  remainingComments: number;
}

export interface DailyCommentBreakdown {
  total: number;
  topLevelComments: number;
  replies: number;
}

export interface PostReadiness {
  allowed: boolean;
  reason?: "daily_limit" | "cooldown";
  waitMs: number;
  cooldownMs: number;
  limitPerDay?: number;
  usedCount: number;
}

export const DEFAULT_OUTREACH_POLICY_CONFIG: MoltbookOutreachPolicyConfig = {
  commentLimitNewAgentPerDay: 20,
  commentLimitEstablishedPerDay: 50,
  postLimitNewAgentPerDay: undefined,
  postLimitEstablishedPerDay: undefined
};

export function postCooldownMs(isNew: boolean): number {
  return (isNew ? 120 : 30) * 60 * 1_000;
}

function msUntilNextUtcDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime();
}

export function commentMinimumIntervalMs(
  state: OutreachAgentState,
  isNew: boolean,
  policy?: Partial<MoltbookOutreachPolicyConfig>,
  now = new Date()
): number {
  const remainingComments = Math.max(commentLimitPerDay(isNew, policy) - state.dailyCommentCount, 0);
  if (remainingComments === 0) {
    return Number.POSITIVE_INFINITY;
  }

  const pacedIntervalMs = Math.ceil(msUntilNextUtcDay(now) / remainingComments);
  return Math.max(commentCooldownMs(isNew), pacedIntervalMs);
}

export function getCommentReadiness(
  state: OutreachAgentState,
  isNew: boolean,
  policy?: Partial<MoltbookOutreachPolicyConfig>,
  now = new Date()
): CommentReadiness {
  const limitPerDay = commentLimitPerDay(isNew, policy);
  const remainingComments = Math.max(limitPerDay - state.dailyCommentCount, 0);
  if (remainingComments === 0) {
    return {
      allowed: false,
      reason: "daily_limit",
      waitMs: msUntilNextUtcDay(now),
      minimumIntervalMs: Number.POSITIVE_INFINITY,
      limitPerDay,
      usedCount: state.dailyCommentCount,
      remainingComments
    };
  }

  const minimumIntervalMs = commentMinimumIntervalMs(state, isNew, policy, now);
  const sinceLastCommentMs =
    (hoursSince(state.lastCommentAt, now) ?? Number.POSITIVE_INFINITY) * 3_600_000;

  if (sinceLastCommentMs >= minimumIntervalMs) {
    return {
      allowed: true,
      waitMs: 0,
      minimumIntervalMs,
      limitPerDay,
      usedCount: state.dailyCommentCount,
      remainingComments
    };
  }

  return {
    allowed: false,
    reason: "paced_cooldown",
    waitMs: Math.max(minimumIntervalMs - sinceLastCommentMs, 0),
    minimumIntervalMs,
    limitPerDay,
    usedCount: state.dailyCommentCount,
    remainingComments
  };
}

export function getDailyCommentBreakdown(state: OutreachAgentState): DailyCommentBreakdown {
  return {
    total: state.dailyCommentCount,
    topLevelComments: state.dailyTopLevelCommentCount,
    replies: state.dailyReplyCount
  };
}

export function getPostReadiness(
  state: OutreachAgentState,
  isNew: boolean,
  policy?: Partial<MoltbookOutreachPolicyConfig>,
  now = new Date()
): PostReadiness {
  const limitPerDay = postLimitPerDay(isNew, policy);
  if (limitPerDay !== undefined && state.dailyPostCount >= limitPerDay) {
    return {
      allowed: false,
      reason: "daily_limit",
      waitMs: msUntilNextUtcDay(now),
      cooldownMs: postCooldownMs(isNew),
      limitPerDay,
      usedCount: state.dailyPostCount
    };
  }

  const sinceLastPostHours = hoursSince(state.lastPostAt, now);
  if (sinceLastPostHours === undefined) {
    return {
      allowed: true,
      waitMs: 0,
      cooldownMs: postCooldownMs(isNew),
      limitPerDay,
      usedCount: state.dailyPostCount
    };
  }

  const cooldownMs = postCooldownMs(isNew);
  const sinceLastPostMs = sinceLastPostHours * 3_600_000;
  if (sinceLastPostMs >= cooldownMs) {
    return {
      allowed: true,
      waitMs: 0,
      cooldownMs,
      limitPerDay,
      usedCount: state.dailyPostCount
    };
  }

  return {
    allowed: false,
    reason: "cooldown",
    waitMs: Math.max(cooldownMs - sinceLastPostMs, 0),
    cooldownMs,
    limitPerDay,
    usedCount: state.dailyPostCount
  };
}

export function canCreatePost(
  state: OutreachAgentState,
  isNew: boolean,
  policy?: Partial<MoltbookOutreachPolicyConfig>,
  now = new Date()
): boolean {
  return getPostReadiness(state, isNew, policy, now).allowed;
}

export function canComment(
  state: OutreachAgentState,
  isNew: boolean,
  policy?: Partial<MoltbookOutreachPolicyConfig>,
  now = new Date()
): boolean {
  return getCommentReadiness(state, isNew, policy, now).allowed;
}

const TOPIC_WEIGHTED_TERMS: ReadonlyArray<[string, number]> = [
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

function scoreTopicText(value: string): number {
  const haystack = value.toLowerCase();
  return TOPIC_WEIGHTED_TERMS.reduce((score, [term, weight]) => {
    return haystack.includes(term) ? score + weight : score;
  }, 0);
}

function scorePost(post: MoltbookPost): number {
  return scoreTopicText(`${post.title} ${post.content ?? ""} ${post.content_preview ?? ""}`);
}

export function scoreCommentForFollow(comment: MoltbookComment): number {
  return scoreTopicText(comment.content ?? "");
}

export function selectFollowCandidatesFromComments(input: {
  comments: readonly MoltbookComment[];
  state: OutreachAgentState;
  agentName: string;
  policy?: Partial<MoltbookOutreachPolicyConfig>;
  alreadyQueued?: ReadonlySet<string>;
  remainingBudget?: number;
}): Array<{ agentName: string; reason: string }> {
  if (input.policy?.followFromCommentAuthors === false) {
    return [];
  }

  const minScore = Math.max(1, input.policy?.followCommentMinScore ?? 3);
  const budget = Math.max(0, input.remainingBudget ?? Number.POSITIVE_INFINITY);
  if (budget === 0) {
    return [];
  }

  const queued = new Set(input.alreadyQueued ?? []);
  const seen = new Set<string>();
  const results: Array<{ agentName: string; reason: string }> = [];

  for (const comment of flattenComments(input.comments)) {
    if (results.length >= budget) {
      break;
    }

    const author = commentAuthorName(comment);
    if (!author || author === input.agentName) {
      continue;
    }
    if (seen.has(author) || queued.has(author)) {
      continue;
    }
    if (input.state.followedAgentNames.includes(author)) {
      continue;
    }
    if (scoreCommentForFollow(comment) < minScore) {
      continue;
    }

    seen.add(author);
    results.push({
      agentName: author,
      reason: "Comment author made a relevant point worth following."
    });
  }

  return results;
}

function normalizeFingerprint(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function planHeartbeatActions(input: {
  home: MoltbookHomeResponse;
  followingFeed?: MoltbookFeedResponse;
  exploreFeed?: MoltbookFeedResponse;
  state: OutreachAgentState;
  policy?: Partial<MoltbookOutreachPolicyConfig>;
  factSheet: ProductFactSheet;
  profileCreatedAt?: string;
  now?: Date;
}): PlannedAction[] {
  const now = input.now ?? new Date();
  const state = normalizeState(input.state, now);
  const actions: PlannedAction[] = [];
  const newAgent = isNewAgent(input.profileCreatedAt, state, now);
  const commentReadiness = getCommentReadiness(state, newAgent, input.policy, now);
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

  let upvoteCount = 0;
  for (const post of candidatePosts) {
    if (upvoteCount >= 2) {
      break;
    }

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
    upvoteCount += 1;
  }

  const followMinPostScore = Math.max(1, input.policy?.followMinPostScore ?? 3);
  const followMaxPerHeartbeat = Math.max(0, input.policy?.followMaxPerHeartbeat ?? 3);
  const queuedFollowNames = new Set<string>();
  let plannedFollowCount = 0;

  for (const post of candidatePosts) {
    if (plannedFollowCount >= followMaxPerHeartbeat) {
      break;
    }

    const author = post.author_name;
    if (!author) {
      continue;
    }

    if (state.followedAgentNames.includes(author) || queuedFollowNames.has(author)) {
      continue;
    }

    if (scorePost(post) < followMinPostScore) {
      continue;
    }

    actions.push({
      type: "follow_agent",
      agentName: author,
      reason: "The author is posting repeatedly on topics we care about."
    });
    queuedFollowNames.add(author);
    plannedFollowCount += 1;
  }

  const commentTargets = candidatePosts.filter((post) => {
    const postId = post.post_id ?? post.id;
    return (
      Boolean(postId) &&
      !pendingCommentPostIds.has(postId!) &&
      !hasHandledTopLevelCommentParent(state.repliedCommentIds, postId!) &&
      scorePost(post) >= 4 &&
      commentReadiness.allowed
    );
  });

  for (const commentTarget of commentTargets.slice(0, 3)) {
    actions.push({
      type: "comment_on_post",
      post: commentTarget,
      reason: "This discussion is close enough to private messaging that we can add value."
    });
  }

  const hasExternalNetworkOpportunity = actions.some(
    (action) =>
      action.type === "upvote_post" ||
      action.type === "follow_agent" ||
      action.type === "comment_on_post"
  );

  if (
    (
      input.home.activity_on_your_posts.length === 0 ||
      commentReadiness.reason === "daily_limit"
    ) &&
    canCreatePost(state, newAgent, input.policy, now) &&
    !hasPendingPost &&
    !hasExternalNetworkOpportunity
  ) {
    actions.push({
      type: "create_post",
      reason: commentReadiness.reason === "daily_limit"
        ? "Reply demand exists, but the daily comment budget is spent, so this heartbeat should keep outreach moving with one substantive post."
        : commentReadiness.allowed
        ? "No urgent replies are waiting and we have room for one substantive outreach post."
        : "No urgent replies are waiting and we have room for one substantive outreach post."
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
        !hasHandledReplyParent(input.state.repliedCommentIds, comment.id) &&
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
        promptProfileId?: string;
        promptParameters?: PromptParameterSet;
        layout?: LayoutVariant;
        ctaUrl?: string;
        outreachRef?: OutreachRef;
        structuralFingerprint?: string;
        createdAt?: string;
      }
    | {
        type: "comment";
        commentId: string;
        content: string;
        targetSummary?: string;
        replyToAuthor?: string;
        promptProfileId?: string;
        promptParameters?: PromptParameterSet;
        layout?: LayoutVariant;
        ctaUrl?: string;
        outreachRef?: OutreachRef;
        structuralFingerprint?: string;
        createdAt?: string;
      }
    | { type: "upvote_post"; postId: string }
    | { type: "follow_agent"; agentName: string },
  now = new Date()
): OutreachAgentState {
  const nextState = normalizeState(state, now);
  nextState.lastHeartbeatAt = now.toISOString();
  const actionTimestamp =
    "createdAt" in action && action.createdAt ? Date.parse(action.createdAt) : Number.NaN;
  const actionTime = Number.isNaN(actionTimestamp) ? now : new Date(actionTimestamp);
  const actionDay = actionTime.toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  const updateLastTimestamp = (
    currentValue: string | undefined,
    candidateValue: string
  ): string => {
    if (!currentValue) {
      return candidateValue;
    }

    const currentTimestamp = Date.parse(currentValue);
    const candidateTimestamp = Date.parse(candidateValue);
    if (Number.isNaN(currentTimestamp) || Number.isNaN(candidateTimestamp)) {
      return candidateValue;
    }

    return candidateTimestamp > currentTimestamp ? candidateValue : currentValue;
  };

  switch (action.type) {
    case "create_post":
      nextState.lastPostAt = updateLastTimestamp(nextState.lastPostAt, actionTime.toISOString());
      if (actionDay === today) {
        nextState.dailyPostCount += 1;
      }
      nextState.createdPostFingerprints = uniqueRecent(
        [...nextState.createdPostFingerprints, action.fingerprint],
        MAX_CREATED_POST_FINGERPRINTS
      );
      const artifact: RecentGeneratedArtifact = {
        id: `post:${action.fingerprint}`,
        type: "post",
        title: action.title,
        content: action.content,
        promptProfileId: action.promptProfileId,
        promptParameters: action.promptParameters,
        layout: action.layout,
        ctaUrl: action.ctaUrl,
        outreachRef: action.outreachRef,
        structuralFingerprint: action.structuralFingerprint,
        createdAt: actionTime.toISOString()
      };
      nextState.recentGeneratedArtifacts = [
        ...nextState.recentGeneratedArtifacts,
        artifact
      ].slice(-MAX_RECENT_GENERATED_ARTIFACTS);
      return recordEngagementEvent(
        nextState,
        {
          id: `post:${action.fingerprint}`,
          type: "post",
          createdAt: actionTime.toISOString(),
          targetId: action.fingerprint,
          targetSummary: action.title
        },
        now
      );
    case "comment":
      nextState.lastCommentAt = updateLastTimestamp(nextState.lastCommentAt, actionTime.toISOString());
      if (actionDay === today) {
        nextState.dailyCommentCount += 1;
        if (action.replyToAuthor) {
          nextState.dailyReplyCount += 1;
        } else {
          nextState.dailyTopLevelCommentCount += 1;
        }
      }
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
        promptProfileId: action.promptProfileId,
        promptParameters: action.promptParameters,
        layout: action.layout,
        ctaUrl: action.ctaUrl,
        outreachRef: action.outreachRef,
        structuralFingerprint: action.structuralFingerprint,
        createdAt: actionTime.toISOString()
      };
      nextState.recentGeneratedArtifacts = [
        ...nextState.recentGeneratedArtifacts,
        commentArtifact
      ].slice(-MAX_RECENT_GENERATED_ARTIFACTS);
      return recordEngagementEvent(
        nextState,
        {
          id: `comment:${action.commentId}`,
          type: action.replyToAuthor ? "reply" : "comment",
          createdAt: actionTime.toISOString(),
          targetId: action.commentId,
          targetSummary: action.targetSummary
        },
        now
      );
    case "upvote_post":
      nextState.upvotedPostIds = uniqueRecent(
        [...nextState.upvotedPostIds, action.postId],
        MAX_UPVOTED_POST_IDS
      );
      return recordEngagementEvent(
        nextState,
        {
          id: `upvote:${action.postId}`,
          type: "upvote",
          createdAt: now.toISOString(),
          targetId: action.postId
        },
        now
      );
    case "follow_agent":
      nextState.followedAgentNames = uniqueRecent(
        [...nextState.followedAgentNames, action.agentName],
        MAX_FOLLOWED_AGENT_NAMES
      );
      return recordEngagementEvent(
        nextState,
        {
          id: `follow:${action.agentName}`,
          type: "follow",
          createdAt: now.toISOString(),
          targetId: action.agentName
        },
        now
      );
  }
}

export function contentFingerprint(value: string): string {
  return normalizeFingerprint(value).slice(0, 160);
}

