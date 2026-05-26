import {
  buildRedditReviewQueue,
  redditMemoryEntryConsumesTarget,
  type RedditOutboundMemoryEntry,
  type RedditOutreachTargeting,
  type RedditReviewItem,
  type RedditRulesRegistry,
  type RedditSourceItem
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

export interface RedditPlannerResult {
  action?: RedditPlannedAction;
  plannedCandidates: RedditPlannedAction[];
  skipped: string[];
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

export function planRedditAction(input: {
  items: readonly RedditSourceItem[];
  history?: readonly RedditOutboundMemoryEntry[];
  targeting?: RedditOutreachTargeting;
  registry?: RedditRulesRegistry;
  now?: Date;
  rng?: () => number;
  config?: Partial<RedditPlannerConfig>;
}): RedditPlannerResult {
  const now = input.now ?? new Date();
  const config = { ...DEFAULT_REDDIT_PLANNER_CONFIG, ...input.config };
  const queue = buildRedditReviewQueue({
    items: input.items,
    history: input.history ?? [],
    targeting: input.targeting ?? DEFAULT_REDDIT_OPERATING_TARGETING,
    registry: input.registry ?? DEFAULT_REDDIT_OPERATING_RULES,
    now
  });
  const skipped = [
    ...queue.ignored.map((item) => `${item.id}: blocked by ${blockedGateIds(item).join(",")}`),
    ...queue.items
      .filter((item) => item.action !== "answer_publicly")
      .map((item) => `${item.id}: requires ${item.action.replaceAll("_", " ")}`)
  ];
  const ranked = queue.items
    .filter((item) => item.action === "answer_publicly")
    .filter((item) => item.draft)
    .filter((item) => !alreadyTouched(item, input.history ?? []))
    .map((item) => {
      const type = item.source.kind === "comment" ? "reply_to_comment" as const : "comment_on_post" as const;
      const score = scoreCandidate(item, config);
      return {
        id: item.id,
        type,
        item,
        score,
        reason: `${type === "reply_to_comment" ? "reply-worthy comment" : "thread comment"}; ${item.whyRelevant}`
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
    candidates: ranked.map((candidate) => ({
      id: candidate.id,
      type: candidate.type,
      score: candidate.score,
      reason: candidate.reason
    }))
  };
}

export function jitterDelayMs(config: RedditPlannerConfig, rng: () => number): number {
  const min = Math.max(1, config.minDelayMinutes) * 60_000;
  const max = Math.max(config.minDelayMinutes, config.maxDelayMinutes) * 60_000;
  return Math.floor(min + (max - min) * Math.min(0.999, Math.max(0, rng())));
}

function scoreCandidate(item: RedditReviewItem, config: RedditPlannerConfig): number {
  const ownThreadBoost =
    item.source.onOwnThread && item.source.kind === "comment"
      ? 120
      : item.source.onOwnThread
        ? 40
        : 0;
  const commentBoost = config.preferComments && item.source.kind === "comment" ? 20 : 0;
  const activityBoost = Math.min(15, item.source.commentCount ?? 0);
  return ownThreadBoost + commentBoost + activityBoost + item.relevanceScore * 3 - item.riskScore;
}

function alreadyTouched(item: RedditReviewItem, history: readonly RedditOutboundMemoryEntry[]): boolean {
  return history.some((entry) => {
    if (!redditMemoryEntryConsumesTarget(entry)) {
      return false;
    }
    return (
      entry.targetId === item.source.id ||
      entry.id === item.source.id ||
      (entry.targetSummary && item.source.body && entry.targetSummary.includes(item.source.body.slice(0, 80)))
    );
  });
}

function blockedGateIds(item: RedditReviewItem): string[] {
  return item.gates.filter((gate) => gate.severity === "block" && !gate.passed).map((gate) => gate.id);
}
