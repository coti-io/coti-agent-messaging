import type { AttributionMode } from "./outreach-attribution.js";
import type { LayoutVariant, PromptParameterSet } from "./prompt-profile.js";
import type { PrivateMessageEscalationReason } from "./policy.js";
import type { PrivateMessageEscalationAssessment } from "./policy.js";

export type RedditRiskLevel = "low" | "medium" | "high" | "blocked";

export type RedditTriageHelpIntent =
  | "explicit_question"
  | "operational_pain"
  | "discussion"
  | "none";

export type RedditTriageTopicalFit = "strong" | "weak" | "none";

export interface RedditSourceTriageResult {
  relevant: boolean;
  helpIntent: RedditTriageHelpIntent;
  topicalFit: RedditTriageTopicalFit;
  hostileOrBait: boolean;
  worthPublicReply: boolean;
  confidence: number;
  reason: string;
  source: "llm" | "regex_fallback";
}

export interface RedditTargetSubreddit {
  name: string;
  audience: string;
  rationale: string;
  priority: "primary" | "secondary" | "experimental";
}

export interface RedditOutreachTargeting {
  productName: string;
  targetAudience: string;
  productAliases: string[];
  targetSubreddits: RedditTargetSubreddit[];
}

export interface RedditSubredditRule {
  name: string;
  risk: RedditRiskLevel;
  allowedTopics: string[];
  disallowedTopics: string[];
  selfPromotionPolicy: "none" | "strict" | "unknown";
  linkPolicy: "none_in_first_reply" | "only_when_requested" | "unknown";
  flairRequirements?: string;
  modContactNotes?: string;
  requiresManualRuleCheck: boolean;
}

export interface RedditRulesRegistry {
  generatedAt: string;
  rules: RedditSubredditRule[];
}

export interface RedditSourceItem {
  id: string;
  kind: "post" | "comment";
  subreddit: string;
  title: string;
  body?: string;
  author?: string;
  permalink?: string;
  url?: string;
  createdUtc?: number;
  score?: number;
  commentCount?: number;
  parentTitle?: string;
  /** Thread where we already posted or commented (from memory). */
  onOwnThread?: boolean;
  /** Root post id for comments and posts on a thread. */
  threadPostId?: string;
  /** Parent comment id when kind is comment. */
  parentId?: string;
  /** True when this comment is a direct reply to one of our comments. */
  replyToOurComment?: boolean;
}

export interface RedditOutboundMemoryEntry {
  id: string;
  /** Matches review item id (`post:sub:id` / `comment:sub:id`) when recorded from a session. */
  decisionId?: string;
  subreddit: string;
  kind: "post" | "comment" | "reply" | "upvote";
  content: string;
  createdAt: string;
  targetId?: string;
  /** Post or thread title for lookup in memory exports and dashboards. */
  targetTitle?: string;
  /** Canonical Reddit URL for the post or thread being engaged. */
  targetUrl?: string;
  /** Root post id for this participation (used to re-ingest replies). */
  threadPostId?: string;
  remoteContentUrl?: string;
  targetSummary?: string;
  nextEligibleAt?: string;
  status?:
    | "drafted"
    | "approved"
    | "posted"
    | "spam_filtered"
    | "removed"
    | "mod_warning"
    | "spam_accusation"
    | "banned";
  firstReply?: boolean;
  productMentioned?: boolean;
  linkIncluded?: boolean;
  promptProfileId?: string;
  promptParameters?: PromptParameterSet;
  layout?: LayoutVariant;
  ctaRefId?: string;
  attributionMode?: AttributionMode;
  publicValueDeliveredFirst?: boolean;
  privateMessageEscalationReason?: PrivateMessageEscalationReason;
  utm?: Record<string, string>;
  structuralFingerprint?: string;
  clickCount?: number;
  privateMessageCount?: number;
  embedding?: number[];
}

export interface RedditReviewGate {
  id: string;
  passed: boolean;
  severity: "info" | "warning" | "block";
  reason: string;
}

export interface RedditReviewItem {
  id: string;
  source: RedditSourceItem;
  action:
    | "answer_publicly"
    | "ask_clarifying_question"
    | "contact_mods"
    | "ignore";
  status: "needs_human_review" | "blocked";
  relevanceScore: number;
  riskScore: number;
  draft?: string;
  promptProfileId?: string;
  promptParameters?: PromptParameterSet;
  layout?: LayoutVariant;
  explicitProductInterest: boolean;
  privateMessageAssessment: PrivateMessageEscalationAssessment;
  publicValueDeliveredFirst: boolean;
  whyRelevant: string;
  gates: RedditReviewGate[];
  approvalRequired: true;
  approvalChecklist: string[];
}

export interface RedditReviewQueue {
  generatedAt: string;
  targeting: RedditOutreachTargeting;
  items: RedditReviewItem[];
  ignored: RedditReviewItem[];
}

export interface RedditReadOnlyClientConfig {
  accessToken: string;
  userAgent: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}
