import {
  buildRedditReviewQueue,
  DEFAULT_REDDIT_RULES_REGISTRY,
  DEFAULT_REDDIT_TARGETING,
  type RedditDuplicateCheckPolicy,
  redditMemoryEntryConsumesTarget,
  type RedditOutboundMemoryEntry,
  type RedditOutreachTargeting,
  type RedditReviewItem,
  type RedditRulesRegistry,
  type RedditSourceItem,
  mergeRulesRegistries,
  resolveRulesRegistryForSubreddits,
  resolveSourceThreadPostId
} from "./reddit-outreach.js";

export interface RedditPlannerConfig {
  maxActionsPerSession: number;
  minDelayMinutes: number;
  maxDelayMinutes: number;
  preferComments: boolean;
}

export interface RedditPlannedAction {
  type: "reply_to_comment" | "comment_on_post";
  item: RedditReviewItem;
  reason: string;
  score: number;
  nextEligibleAt: string;
}

export interface RedditPlannerFilterGateCount {
  gate: string;
  count: number;
  category: RedditFilterGateCategory;
}

export type RedditFilterGateCategory =
  | "topical_validation"
  | "intent_validation"
  | "draft_generation"
  | "draft_validation"
  | "duplicate_check"
  | "rate_limit"
  | "subreddit_config"
  | "other";

export interface RedditPlannerFilterSummary {
  sourceItemCount: number;
  inTargetSubredditCount: number;
  outOfTargetSubredditCount: number;
  reviewedCount: number;
  blockedCount: number;
  needsReviewCount: number;
  plannedCandidateCount: number;
  blockedByGate: RedditPlannerFilterGateCount[];
  nonPublicActionCounts: Array<{ action: string; count: number }>;
}

export interface RedditPlannerResult {
  action?: RedditPlannedAction;
  plannedCandidates: RedditPlannedAction[];
  skipped: string[];
  filterSummary: RedditPlannerFilterSummary;
  candidates: Array<{
    id: string;
    type: "reply_to_comment" | "comment_on_post";
    score: number;
    reason: string;
  }>;
}

export const DEFAULT_REDDIT_PLANNER_CONFIG: RedditPlannerConfig = {
  maxActionsPerSession: 1,
  minDelayMinutes: 18,
  maxDelayMinutes: 67,
  preferComments: true
};

export const DEFAULT_REDDIT_OPERATING_TARGETING: RedditOutreachTargeting = {
  productName: "private workflow automation",
  targetAudience: "operators solving CRM, customer success, sales, SaaS, and marketing workflow problems",
  productAliases: [
    "coti",
    "enso",
    "coti-agent-messaging",
    "coti private messaging",
    "web4"
  ],
  targetSubreddits: [
    { name: "sales", audience: "sales operators", rationale: "CRM and handoff pain.", priority: "primary" },
    { name: "SaaS", audience: "SaaS operators", rationale: "Process and growth operations.", priority: "primary" },
    { name: "CustomerSuccess", audience: "CS operators", rationale: "Customer workflow and retention pain.", priority: "primary" },
    { name: "DigitalMarketing", audience: "marketing operators", rationale: "Marketing ops and attribution problems.", priority: "primary" },
    { name: "marketing", audience: "marketers", rationale: "Operational campaign execution pain.", priority: "secondary" },
    { name: "Entrepreneur", audience: "founders", rationale: "Small business workflow pain.", priority: "secondary" },
    { name: "smallbusiness", audience: "small business owners", rationale: "Manual operations pain.", priority: "secondary" },
    { name: "startups", audience: "startup operators", rationale: "Early workflow and CRM pain.", priority: "secondary" },
    { name: "devops", audience: "operators", rationale: "Automation failure and reliability threads.", priority: "experimental" },
    { name: "operations", audience: "operations teams", rationale: "Direct process improvement discussions.", priority: "experimental" }
  ]
};

export const DEFAULT_REDDIT_OPERATING_RULES: RedditRulesRegistry = {
  generatedAt: "2026-05-19T00:00:00.000Z",
  rules: DEFAULT_REDDIT_OPERATING_TARGETING.targetSubreddits.map((target) => ({
    name: target.name,
    risk: target.priority === "primary" ? "medium" : "high",
    allowedTopics: [
      "practical operational advice",
      "CRM data quality",
      "workflow reliability",
      "automation failure modes",
      "customer success and sales handoff problems"
    ],
    disallowedTopics: [
      "direct marketing",
      "product links",
      "demo offers",
      "DM requests",
      "generic AI slogans",
      "price or token talk"
    ],
    selfPromotionPolicy: "strict",
    linkPolicy: "none_in_first_reply",
    requiresManualRuleCheck: false
  }))
};

export function emptyRedditFilterSummary(): RedditPlannerFilterSummary {
  return {
    sourceItemCount: 0,
    inTargetSubredditCount: 0,
    outOfTargetSubredditCount: 0,
    reviewedCount: 0,
    blockedCount: 0,
    needsReviewCount: 0,
    plannedCandidateCount: 0,
    blockedByGate: [],
    nonPublicActionCounts: []
  };
}

export function resolveRedditPlannerContext(targetSubreddits: readonly string[]): {
  targeting: RedditOutreachTargeting;
  registry: RedditRulesRegistry;
  activeSubreddits: readonly string[];
} {
  if (targetSubreddits.length === 0) {
    return {
      targeting: DEFAULT_REDDIT_TARGETING,
      registry: DEFAULT_REDDIT_RULES_REGISTRY,
      activeSubreddits: []
    };
  }

  const configured = targetSubreddits.map((entry) => entry.toLowerCase());
  const operatingNames = new Set(
    DEFAULT_REDDIT_OPERATING_TARGETING.targetSubreddits.map((entry) => entry.name.toLowerCase())
  );
  const useOperatingProfile = configured.every((name) => operatingNames.has(name));
  const baseTargeting = useOperatingProfile ? DEFAULT_REDDIT_OPERATING_TARGETING : DEFAULT_REDDIT_TARGETING;
  const baseRegistry = useOperatingProfile ? DEFAULT_REDDIT_OPERATING_RULES : DEFAULT_REDDIT_RULES_REGISTRY;
  const missingFromBase = targetSubreddits.filter(
    (name) => !baseRegistry.rules.some((rule) => rule.name.toLowerCase() === name.toLowerCase())
  );
  const registry =
    missingFromBase.length > 0
      ? mergeRulesRegistries(
          baseRegistry,
          resolveRulesRegistryForSubreddits(missingFromBase, DEFAULT_REDDIT_RULES_REGISTRY, DEFAULT_REDDIT_OPERATING_RULES)
        )
      : baseRegistry;

  return {
    targeting: baseTargeting,
    registry,
    activeSubreddits: targetSubreddits
  };
}

export function categorizeRedditFilterGate(gateId: string): RedditFilterGateCategory {
  switch (gateId) {
    case "discovery_topical_fit":
      return "topical_validation";
    case "clear_user_need":
      return "intent_validation";
    case "safe_draft_generated":
      return "draft_generation";
    case "prompt_profile_safety":
    case "no_product_or_company_mention":
    case "no_links":
    case "no_cta_or_dm_prompt":
    case "reddit_cta_forbidden":
      return "draft_validation";
    case "not_near_duplicate":
    case "not_redundant_with_thread":
      return "duplicate_check";
    case "subreddit_daily_limit":
    case "global_daily_limit":
      return "rate_limit";
    case "subreddit_rules_registered":
    case "subreddit_not_blocked":
    case "low_spam_topic_risk":
    case "low_argument_risk":
      return "subreddit_config";
    default:
      return "other";
  }
}

export function planRedditAction(input: {
  items: readonly RedditSourceItem[];
  history?: readonly RedditOutboundMemoryEntry[];
  targeting?: RedditOutreachTargeting;
  registry?: RedditRulesRegistry;
  activeSubreddits?: readonly string[];
  now?: Date;
  rng?: () => number;
  config?: Partial<RedditPlannerConfig>;
  duplicateCheckPolicy?: RedditDuplicateCheckPolicy;
}): RedditPlannerResult {
  const now = input.now ?? new Date();
  const config = { ...DEFAULT_REDDIT_PLANNER_CONFIG, ...input.config };
  const targeting = input.targeting ?? DEFAULT_REDDIT_OPERATING_TARGETING;
  const activeSubredditNames = new Set(
    (input.activeSubreddits?.length
      ? input.activeSubreddits
      : targeting.targetSubreddits.map((entry) => entry.name)
    ).map((entry) => entry.toLowerCase())
  );
  const itemsForQueue = input.items.filter((item) =>
    activeSubredditNames.has(item.subreddit.toLowerCase())
  );
  const inTargetSubredditCount = itemsForQueue.length;
  const queue = buildRedditReviewQueue({
    items: itemsForQueue,
    history: input.history ?? [],
    targeting,
    registry: input.registry ?? DEFAULT_REDDIT_OPERATING_RULES,
    duplicateCheckPolicy: input.duplicateCheckPolicy ?? "block_posted_only",
    now
  });
  const history = input.history ?? [];
  const skipped = [
    ...queue.items
      .filter((item) => item.action === "answer_publicly" && item.draft && alreadyTouched(item, history))
      .map((item) => `${item.id}: skipped prior draft or post in memory`),
    ...queue.ignored.map((item) => `${item.id}: blocked by ${blockedGateIds(item).join(",")}`),
    ...queue.items
      .filter((item) => item.action !== "answer_publicly")
      .map((item) => `${item.id}: requires ${item.action.replaceAll("_", " ")}`)
  ];
  const ranked = queue.items
    .filter((item) => item.action === "answer_publicly")
    .filter((item) => item.draft)
    .filter((item) => !alreadyTouched(item, history))
    .map((item) => {
      const type = item.source.kind === "comment" ? "reply_to_comment" as const : "comment_on_post" as const;
      const score = scoreCandidate(item, config);
      return {
        id: item.id,
        type,
        item,
        score,
        reason: [
          type === "reply_to_comment" ? "reply-worthy comment" : "thread comment",
          item.source.replyToOurComment ? "direct reply to our comment" : undefined,
          item.whyRelevant
        ]
          .filter(Boolean)
          .join("; ")
      };
    })
    .sort((left, right) => right.score - left.score);

  const nextEligibleAt = new Date(now.getTime() + jitterDelayMs(config, input.rng ?? Math.random)).toISOString();
  const plannedCandidates = ranked.map((candidate) => ({
    type: candidate.type,
    item: candidate.item,
    score: candidate.score,
    reason: candidate.reason,
    nextEligibleAt
  }));
  return {
    action: plannedCandidates[0],
    plannedCandidates,
    skipped,
    filterSummary: buildRedditPlannerFilterSummary({
      sourceItemCount: input.items.length,
      inTargetSubredditCount,
      queue,
      plannedCandidateCount: plannedCandidates.length
    }),
    candidates: ranked.map((candidate) => ({
      id: candidate.id,
      type: candidate.type,
      score: candidate.score,
      reason: candidate.reason
    }))
  };
}

function buildRedditPlannerFilterSummary(input: {
  sourceItemCount: number;
  inTargetSubredditCount: number;
  queue: ReturnType<typeof buildRedditReviewQueue>;
  plannedCandidateCount: number;
}): RedditPlannerFilterSummary {
  const gateCounts = new Map<string, number>();
  for (const item of input.queue.ignored) {
    for (const gateId of blockedGateIds(item)) {
      gateCounts.set(gateId, (gateCounts.get(gateId) ?? 0) + 1);
    }
  }

  const nonPublicActionCounts = new Map<string, number>();
  for (const item of input.queue.items) {
    if (item.action === "answer_publicly") {
      continue;
    }
    nonPublicActionCounts.set(item.action, (nonPublicActionCounts.get(item.action) ?? 0) + 1);
  }

  return {
    sourceItemCount: input.sourceItemCount,
    inTargetSubredditCount: input.inTargetSubredditCount,
    outOfTargetSubredditCount: Math.max(0, input.sourceItemCount - input.inTargetSubredditCount),
    reviewedCount: input.queue.items.length + input.queue.ignored.length,
    blockedCount: input.queue.ignored.length,
    needsReviewCount: input.queue.items.length,
    plannedCandidateCount: input.plannedCandidateCount,
    blockedByGate: [...gateCounts.entries()]
      .map(([gate, count]) => ({
        gate,
        count,
        category: categorizeRedditFilterGate(gate)
      }))
      .sort((left, right) => right.count - left.count || left.gate.localeCompare(right.gate)),
    nonPublicActionCounts: [...nonPublicActionCounts.entries()]
      .map(([action, count]) => ({ action, count }))
      .sort((left, right) => right.count - left.count || left.action.localeCompare(right.action))
  };
}

export function jitterDelayMs(config: RedditPlannerConfig, rng: () => number): number {
  const min = Math.max(1, config.minDelayMinutes) * 60_000;
  const max = Math.max(config.minDelayMinutes, config.maxDelayMinutes) * 60_000;
  return Math.floor(min + (max - min) * Math.min(0.999, Math.max(0, rng())));
}

export function scoreRedditReviewItem(item: RedditReviewItem, config: RedditPlannerConfig): number {
  const ownThreadBoost =
    item.source.onOwnThread && item.source.kind === "comment"
      ? 120
      : item.source.onOwnThread
        ? 40
        : 0;
  const directReplyBoost = item.source.replyToOurComment ? 80 : 0;
  const commentBoost = config.preferComments && item.source.kind === "comment" ? 20 : 0;
  const activityBoost = Math.min(15, item.source.commentCount ?? 0);
  return (
    ownThreadBoost + directReplyBoost + commentBoost + activityBoost + item.relevanceScore * 3 - item.riskScore
  );
}

function scoreCandidate(item: RedditReviewItem, config: RedditPlannerConfig): number {
  return scoreRedditReviewItem(item, config);
}

function alreadyTouched(item: RedditReviewItem, history: readonly RedditOutboundMemoryEntry[]): boolean {
  return history.some((entry) => memoryEntryTouchesReviewItem(entry, item));
}

/** Treat dry-run drafts like posted targets so repeat sessions do not re-pick the same thread. */
export function memoryEntryTouchesReviewItem(
  entry: RedditOutboundMemoryEntry,
  item: RedditReviewItem
): boolean {
  if (entry.decisionId === item.id) {
    return true;
  }
  if (entry.targetId && entry.targetId === item.source.id) {
    return true;
  }
  const threadPostId = resolveSourceThreadPostId(item.source);
  if (
    threadPostId &&
    entry.threadPostId === threadPostId &&
    item.source.kind === "post" &&
    entry.firstReply &&
    (entry.status === "drafted" || redditMemoryEntryConsumesTarget(entry))
  ) {
    return true;
  }
  if (!redditMemoryEntryConsumesTarget(entry)) {
    return false;
  }
  return (
    entry.targetId === item.source.id ||
    entry.id === item.source.id ||
    Boolean(
      entry.targetSummary &&
        item.source.body &&
        entry.targetSummary.includes(item.source.body.slice(0, 80))
    )
  );
}

function blockedGateIds(item: RedditReviewItem): string[] {
  return item.gates.filter((gate) => gate.severity === "block" && !gate.passed).map((gate) => gate.id);
}
