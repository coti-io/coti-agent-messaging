import {
  resolvePromptProfile,
  validateDraftAgainstPromptProfile,
  validatePromptProfile,
  type LayoutVariant,
  type PromptParameterSet,
  type PromptProfile
} from "./prompt-profile.js";

export type RedditRiskLevel = "low" | "medium" | "high" | "blocked";

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
}

export interface RedditOutboundMemoryEntry {
  id: string;
  subreddit: string;
  kind: "post" | "comment" | "reply";
  content: string;
  createdAt: string;
  targetId?: string;
  targetSummary?: string;
  status?:
    | "drafted"
    | "approved"
    | "posted"
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

export interface RedditOutcomeSummary {
  generatedAt: string;
  totalOutbound: number;
  postedFirstReplies: number;
  removals: number;
  modWarnings: number;
  spamAccusations: number;
  bans: number;
  firstReplyPromotionViolations: number;
  removalOrWarningRate: number;
  killReasons: string[];
  successSignals: string[];
}

export interface RedditReadOnlyClientConfig {
  accessToken: string;
  userAgent: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_FIRST_REPLIES_PER_SUBREDDIT_PER_DAY = 2;
const DEFAULT_MAX_FIRST_REPLIES_GLOBAL_PER_DAY = 8;
const SIMILARITY_BLOCK_THRESHOLD = 0.58;

const EXPLICIT_HELP_PATTERNS = [
  /\?/,
  /\bhow (?:do|would|can|should|to)\b/i,
  /\bwhat (?:is|are|would|should|can)\b/i,
  /\bwhy (?:is|are|would|does|do)\b/i,
  /\bany (?:advice|recommendations?|tools?|examples?|ideas?)\b/i,
  /\blooking for\b/i,
  /\btrying to\b/i,
  /\bstruggling with\b/i,
  /\bneed (?:a|an|some|help)\b/i
] as const;

const LOW_INTENT_PATTERNS = [
  /\bairdrop\b/i,
  /\bgiveaway\b/i,
  /\bprice\b/i,
  /\bmoon\b/i,
  /\bshill\b/i,
  /\breferral\b/i,
  /\bpromo(?:tion)?\b/i
] as const;

const CTA_PATTERNS = [
  /\b(?:dm|pm) me\b/i,
  /\bmessage me\b/i,
  /\bcheck (?:out )?(?:my|our)\b/i,
  /\bvisit (?:my|our)\b/i,
  /\bsign up\b/i,
  /\bbook (?:a )?(?:demo|call)\b/i,
  /\bjoin (?:our|my)\b/i
] as const;

const URL_PATTERN = /https?:\/\/|www\./i;

export const DEFAULT_REDDIT_TARGETING: RedditOutreachTargeting = {
  productName: "COTI agent private messaging",
  targetAudience:
    "developers and operators building AI agents, MCP tools, wallet-backed automation, and privacy-sensitive agent coordination flows",
  productAliases: [
    "coti",
    "coti-agent-messaging",
    "coti agent messaging",
    "coti private messaging",
    "web4"
  ],
  targetSubreddits: [
    {
      name: "AI_Agents",
      audience: "agent builders and operators",
      rationale: "Direct fit for agent coordination, tool use, and autonomous workflows.",
      priority: "primary"
    },
    {
      name: "LocalLLaMA",
      audience: "hands-on AI builders",
      rationale: "Good fit when threads discuss agent runtimes, tools, and local orchestration.",
      priority: "primary"
    },
    {
      name: "LangChain",
      audience: "agent framework developers",
      rationale: "Relevant for MCP/tooling questions and agent communication patterns.",
      priority: "primary"
    },
    {
      name: "MachineLearning",
      audience: "technical ML community",
      rationale: "Only viable for architecture-level agent infrastructure discussions.",
      priority: "secondary"
    },
    {
      name: "ArtificialInteligence",
      audience: "general AI practitioners",
      rationale: "Broad but useful for agent coordination and privacy questions.",
      priority: "secondary"
    },
    {
      name: "ethdev",
      audience: "Ethereum and wallet-backed app developers",
      rationale: "Relevant when threads discuss wallet signing, onchain messaging, or privacy.",
      priority: "primary"
    },
    {
      name: "solidity",
      audience: "smart contract developers",
      rationale: "Useful for contract-level privacy, metadata, and reward-accounting discussions.",
      priority: "secondary"
    },
    {
      name: "web3",
      audience: "web3 builders",
      rationale: "Relevant only for technical privacy and agent-use cases, not token promotion.",
      priority: "secondary"
    },
    {
      name: "CryptoTechnology",
      audience: "technical crypto readers",
      rationale: "Better fit than trading subreddits for privacy and infrastructure explanations.",
      priority: "primary"
    },
    {
      name: "privacy",
      audience: "privacy-focused technical users",
      rationale: "Relevant when discussion is about encrypted communication tradeoffs.",
      priority: "experimental"
    },
    {
      name: "selfhosted",
      audience: "operators of private infrastructure",
      rationale: "Possible fit for agent messaging architecture, but avoid web3 framing unless asked.",
      priority: "experimental"
    },
    {
      name: "devops",
      audience: "infrastructure operators",
      rationale: "Only viable for operational coordination and automation reliability threads.",
      priority: "experimental"
    },
    {
      name: "mcp",
      audience: "MCP tool builders",
      rationale: "Direct fit if the community is active and rules allow technical answers.",
      priority: "primary"
    }
  ]
};

export const DEFAULT_REDDIT_RULES_REGISTRY: RedditRulesRegistry = {
  generatedAt: "2026-05-07T00:00:00.000Z",
  rules: DEFAULT_REDDIT_TARGETING.targetSubreddits.map((target) => ({
    name: target.name,
    risk:
      target.priority === "primary"
        ? "medium"
        : target.priority === "secondary"
          ? "high"
          : "high",
    allowedTopics: [
      "direct answers to technical questions",
      "architecture tradeoffs",
      "privacy and coordination explanations",
      "MCP, SDK, and agent-runtime implementation details"
    ],
    disallowedTopics: [
      "token promotion",
      "price talk",
      "airdrop or giveaway content",
      "unsolicited product links",
      "first-reply product mentions",
      "requests to DM unless the Redditor explicitly asks"
    ],
    selfPromotionPolicy: "strict",
    linkPolicy: "none_in_first_reply",
    flairRequirements: "Check the live subreddit rules before approving a draft.",
    modContactNotes:
      "If the first useful answer would require naming COTI or linking to owned resources, contact mods or wait for explicit user interest.",
    requiresManualRuleCheck: true
  }))
};

export function assertTargetingIsViable(targeting = DEFAULT_REDDIT_TARGETING): void {
  const count = targeting.targetSubreddits.length;
  if (count < 10 || count > 30) {
    throw new Error(`Reddit outreach requires 10-30 candidate subreddits; got ${count}.`);
  }

  const duplicate = findDuplicate(
    targeting.targetSubreddits.map((subreddit) => subreddit.name.toLowerCase())
  );
  if (duplicate) {
    throw new Error(`Duplicate target subreddit configured: ${duplicate}.`);
  }
}

export function assertRulesRegistryCoversTargets(
  targeting = DEFAULT_REDDIT_TARGETING,
  registry = DEFAULT_REDDIT_RULES_REGISTRY
): void {
  const ruleNames = new Set(registry.rules.map((rule) => rule.name.toLowerCase()));
  const missing = targeting.targetSubreddits.filter(
    (target) => !ruleNames.has(target.name.toLowerCase())
  );
  if (missing.length > 0) {
    throw new Error(
      `Rules registry is missing target subreddits: ${missing.map((target) => target.name).join(", ")}.`
    );
  }
}

export function buildRedditReviewQueue(input: {
  items: readonly RedditSourceItem[];
  history?: readonly RedditOutboundMemoryEntry[];
  targeting?: RedditOutreachTargeting;
  registry?: RedditRulesRegistry;
  promptProfile?: PromptProfile;
  promptProfileId?: string;
  now?: Date;
}): RedditReviewQueue {
  const targeting = input.targeting ?? DEFAULT_REDDIT_TARGETING;
  const registry = input.registry ?? DEFAULT_REDDIT_RULES_REGISTRY;
  const history = input.history ?? [];
  const now = input.now ?? new Date();

  assertTargetingIsViable(targeting);
  assertRulesRegistryCoversTargets(targeting, registry);

  const targetNames = new Set(
    targeting.targetSubreddits.map((target) => target.name.toLowerCase())
  );
  const ranked = input.items
    .filter((item) => targetNames.has(item.subreddit.toLowerCase()))
    .map((item) =>
      buildReviewItem(item, targeting, registry, history, now, input.promptProfile, input.promptProfileId)
    )
    .sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === "needs_human_review" ? -1 : 1;
      }
      return right.relevanceScore - left.relevanceScore || left.riskScore - right.riskScore;
    });

  return {
    generatedAt: now.toISOString(),
    targeting,
    items: ranked.filter((item) => item.status === "needs_human_review"),
    ignored: ranked.filter((item) => item.status === "blocked")
  };
}

function buildReviewItem(
  source: RedditSourceItem,
  targeting: RedditOutreachTargeting,
  registry: RedditRulesRegistry,
  history: readonly RedditOutboundMemoryEntry[],
  now: Date,
  promptProfile: PromptProfile | undefined,
  promptProfileId: string | undefined
): RedditReviewItem {
  const rule = findRule(registry, source.subreddit);
  const text = sourceText(source);
  const resolvedPromptProfile = resolvePromptProfile({
    venue: "reddit",
    actionType: source.kind === "post" ? "comment_on_post" : "reply_to_activity",
    profile: promptProfile,
    profileId: promptProfileId
  });
  validatePromptProfile(resolvedPromptProfile);
  const relevanceScore = scoreRelevance(text);
  const riskScore = scoreRisk(source, rule, text);
  const hasExplicitIntent = hasExplicitHelpIntent(text);
  const draft =
    relevanceScore >= 5 && hasExplicitIntent
      ? buildExplanatoryDraft(source)
      : undefined;
  const gates = buildGates(
    source,
    draft,
    targeting,
    rule,
    history,
    now,
    hasExplicitIntent,
    resolvedPromptProfile
  );
  const blocked = gates.some((gate) => gate.severity === "block" && !gate.passed);

  return {
    id: `${source.kind}:${source.subreddit}:${source.id}`,
    source,
    action: chooseAction(source, relevanceScore, hasExplicitIntent, rule),
    status: blocked ? "blocked" : "needs_human_review",
    relevanceScore,
    riskScore,
    draft,
    promptProfileId: resolvedPromptProfile.id,
    promptParameters: resolvedPromptProfile.parameters,
    layout: resolvedPromptProfile.parameters.layout,
    whyRelevant: explainRelevance(text, relevanceScore, hasExplicitIntent),
    gates,
    approvalRequired: true,
    approvalChecklist: [
      "Confirm the live subreddit rules still allow this kind of technical answer.",
      "Confirm the first reply contains no product name, owned link, CTA, demo offer, or DM prompt.",
      "Confirm the answer still helps if every company/product reference is removed.",
      "Confirm the draft does not repeat recent outbound wording or answer structure.",
      "Approve manually; do not auto-post during MVP."
    ]
  };
}

function chooseAction(
  source: RedditSourceItem,
  relevanceScore: number,
  hasExplicitIntent: boolean,
  rule: RedditSubredditRule | undefined
): RedditReviewItem["action"] {
  if (!rule || rule.risk === "blocked") {
    return "ignore";
  }

  if (relevanceScore < 5) {
    return "ignore";
  }

  if (!hasExplicitIntent) {
    return "ask_clarifying_question";
  }

  if (rule.requiresManualRuleCheck && rule.risk === "high") {
    return "contact_mods";
  }

  return "answer_publicly";
}

function buildGates(
  source: RedditSourceItem,
  draft: string | undefined,
  targeting: RedditOutreachTargeting,
  rule: RedditSubredditRule | undefined,
  history: readonly RedditOutboundMemoryEntry[],
  now: Date,
  hasExplicitIntent: boolean,
  resolvedPromptProfile: ReturnType<typeof resolvePromptProfile>
): RedditReviewGate[] {
  const similar = draft ? findMostSimilarOutbound(draft, history) : undefined;
  const dailySubredditCount = countRecentFirstReplies(history, now, source.subreddit);
  const dailyGlobalCount = countRecentFirstReplies(history, now);
  const gates: RedditReviewGate[] = [
    {
      id: "subreddit_rules_registered",
      passed: Boolean(rule),
      severity: "block",
      reason: rule
        ? `Rules registry found for r/${source.subreddit}.`
        : `No rules registry entry for r/${source.subreddit}.`
    },
    {
      id: "subreddit_not_blocked",
      passed: rule?.risk !== "blocked",
      severity: "block",
      reason:
        rule?.risk === "blocked"
          ? `r/${source.subreddit} is blocked for outreach.`
          : `r/${source.subreddit} is not blocked.`
    },
    {
      id: "explicit_help_intent",
      passed: hasExplicitIntent,
      severity: "block",
      reason: hasExplicitIntent
        ? "The source asks for help, explanation, advice, or implementation detail."
        : "No explicit help intent; public replies would still be unsolicited."
    },
    {
      id: "low_spam_topic_risk",
      passed: !LOW_INTENT_PATTERNS.some((pattern) => pattern.test(sourceText(source))),
      severity: "block",
      reason: "Reject price, giveaway, airdrop, referral, and shill-adjacent threads."
    },
    {
      id: "draft_exists",
      passed: Boolean(draft),
      severity: "block",
      reason: draft ? "A non-promotional explanatory draft was generated." : "No safe draft generated."
    }
  ];

  if (draft) {
    try {
      validateDraftAgainstPromptProfile(resolvedPromptProfile, draft);
    } catch (error) {
      gates.push({
        id: "prompt_profile_safety",
        passed: false,
        severity: "block",
        reason: error instanceof Error ? error.message : String(error)
      });
    }

    gates.push(
      {
        id: "no_product_or_company_mention",
        passed: !containsProductMention(draft, targeting.productAliases),
        severity: "block",
        reason: "First replies/comments must not name the product, company, or owned resources."
      },
      {
        id: "no_links",
        passed: !URL_PATTERN.test(draft),
        severity: "block",
        reason: "First replies/comments must not contain links."
      },
      {
        id: "no_cta_or_dm_prompt",
        passed: !CTA_PATTERNS.some((pattern) => pattern.test(draft)),
        severity: "block",
        reason: "First replies/comments must not include CTAs, demo offers, or DM prompts."
      },
      {
        id: "reddit_cta_forbidden",
        passed:
          resolvedPromptProfile.cta.requirement === "forbidden" &&
          resolvedPromptProfile.parameters.ctaStyle === "none",
        severity: "block",
        reason: "Reddit first replies force CTA links off regardless of prompt profile."
      },
      {
        id: "not_near_duplicate",
        passed: !similar || similar.score < SIMILARITY_BLOCK_THRESHOLD,
        severity: "block",
        reason: similar
          ? `Most similar prior outbound score ${similar.score.toFixed(2)} from ${similar.entry.id}.`
          : "No similar prior outbound content found."
      }
    );
  }

  gates.push(
    {
      id: "subreddit_daily_limit",
      passed: dailySubredditCount < DEFAULT_MAX_FIRST_REPLIES_PER_SUBREDDIT_PER_DAY,
      severity: "block",
      reason: `r/${source.subreddit} first replies today: ${dailySubredditCount}/${DEFAULT_MAX_FIRST_REPLIES_PER_SUBREDDIT_PER_DAY}.`
    },
    {
      id: "global_daily_limit",
      passed: dailyGlobalCount < DEFAULT_MAX_FIRST_REPLIES_GLOBAL_PER_DAY,
      severity: "block",
      reason: `Global first replies today: ${dailyGlobalCount}/${DEFAULT_MAX_FIRST_REPLIES_GLOBAL_PER_DAY}.`
    },
    {
      id: "human_review_required",
      passed: false,
      severity: "warning",
      reason: "MVP requires human approval before any public reply/comment."
    }
  );

  return gates;
}

export function evaluateRedditOutcomes(
  history: readonly RedditOutboundMemoryEntry[],
  now = new Date()
): RedditOutcomeSummary {
  const firstReplies = history.filter((entry) => entry.firstReply);
  const removals = history.filter((entry) => entry.status === "removed").length;
  const modWarnings = history.filter((entry) => entry.status === "mod_warning").length;
  const spamAccusations = history.filter((entry) => entry.status === "spam_accusation").length;
  const bans = history.filter((entry) => entry.status === "banned").length;
  const postedFirstReplies = firstReplies.filter((entry) =>
    ["posted", "removed", "mod_warning", "spam_accusation", "banned"].includes(entry.status ?? "")
  ).length;
  const firstReplyPromotionViolations = firstReplies.filter(
    (entry) => entry.productMentioned || entry.linkIncluded || containsAnyCta(entry.content)
  ).length;
  const removalOrWarningRate =
    postedFirstReplies === 0 ? 0 : (removals + modWarnings) / postedFirstReplies;
  const repeatedModRemovalSubreddits = subredditsWithAtLeast(
    history.filter((entry) => entry.status === "removed" || entry.status === "mod_warning"),
    2
  );
  const killReasons: string[] = [];

  if (bans > 0) {
    killReasons.push("An account, subreddit, or domain ban was recorded.");
  }
  if (repeatedModRemovalSubreddits.length > 0) {
    killReasons.push(`Repeated mod removals/warnings: ${repeatedModRemovalSubreddits.join(", ")}.`);
  }
  if (spamAccusations > 0) {
    killReasons.push("Users accused the account of spam, botting, or astroturfing.");
  }
  if (firstReplyPromotionViolations > 0) {
    killReasons.push("A first reply included product mention, link, CTA, or DM-style prompt.");
  }

  const successSignals: string[] = [];
  if (postedFirstReplies > 0 && removalOrWarningRate < 0.02) {
    successSignals.push("Removal/mod-warning rate is below 2%.");
  }
  if (firstReplyPromotionViolations === 0) {
    successSignals.push("No first-reply promotion violations recorded.");
  }

  return {
    generatedAt: now.toISOString(),
    totalOutbound: history.length,
    postedFirstReplies,
    removals,
    modWarnings,
    spamAccusations,
    bans,
    firstReplyPromotionViolations,
    removalOrWarningRate,
    killReasons,
    successSignals
  };
}

export class RedditReadOnlyClient {
  private readonly accessToken: string;
  private readonly userAgent: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: RedditReadOnlyClientConfig) {
    if (!config.accessToken) {
      throw new Error("Reddit read-only monitoring requires REDDIT_ACCESS_TOKEN.");
    }
    if (!config.userAgent) {
      throw new Error("Reddit read-only monitoring requires REDDIT_USER_AGENT.");
    }

    this.accessToken = config.accessToken;
    this.userAgent = config.userAgent;
    this.baseUrl = config.baseUrl ?? "https://oauth.reddit.com";
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async getNewPosts(subreddit: string, limit = 10): Promise<RedditSourceItem[]> {
    const url = new URL(`/r/${encodeURIComponent(subreddit)}/new.json`, this.baseUrl);
    url.searchParams.set("limit", String(limit));
    return parseRedditListing(await this.fetchJson(url));
  }

  async searchSubreddit(
    subreddit: string,
    query: string,
    limit = 10
  ): Promise<RedditSourceItem[]> {
    const url = new URL(`/r/${encodeURIComponent(subreddit)}/search.json`, this.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("restrict_sr", "1");
    url.searchParams.set("sort", "new");
    url.searchParams.set("limit", String(limit));
    return parseRedditListing(await this.fetchJson(url));
  }

  private async fetchJson(url: URL): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "User-Agent": this.userAgent,
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Reddit API request failed with ${response.status}: ${await response.text()}`);
    }

    return response.json();
  }
}

export function parseRedditListing(input: unknown): RedditSourceItem[] {
  if (Array.isArray(input)) {
    return input.flatMap((entry) => parseRedditListing(entry));
  }

  if (!isRecord(input)) {
    return [];
  }

  if (Array.isArray(input.items)) {
    return input.items.flatMap((entry) => parseRedditListing(entry));
  }

  if (Array.isArray(input.posts)) {
    return input.posts.flatMap((entry) => parseFlexibleSource(entry, "post"));
  }

  if (Array.isArray(input.comments)) {
    return input.comments.flatMap((entry) => parseFlexibleSource(entry, "comment"));
  }

  if (isRecord(input.data) && Array.isArray(input.data.children)) {
    return input.data.children.flatMap((child) => {
      if (!isRecord(child) || !isRecord(child.data)) {
        return [];
      }

      const kind = child.kind === "t1" ? "comment" : "post";
      return parseFlexibleSource(child.data, kind);
    });
  }

  return parseFlexibleSource(input, "post");
}

function parseFlexibleSource(input: unknown, fallbackKind: RedditSourceItem["kind"]): RedditSourceItem[] {
  if (!isRecord(input)) {
    return [];
  }

  const subreddit = stringValue(input.subreddit) ?? stringValue(input.subreddit_name_prefixed)?.replace(/^r\//, "");
  const id = stringValue(input.id) ?? stringValue(input.name);
  if (!subreddit || !id) {
    return [];
  }

  const kind =
    stringValue(input.kind) === "comment" || stringValue(input.kind) === "post"
      ? (input.kind as RedditSourceItem["kind"])
      : fallbackKind;
  const title =
    stringValue(input.title) ??
    stringValue(input.link_title) ??
    stringValue(input.parentTitle) ??
    "Comment thread";

  return [
    {
      id,
      kind,
      subreddit,
      title,
      body: stringValue(input.selftext) ?? stringValue(input.body) ?? stringValue(input.content),
      author: stringValue(input.author),
      permalink: stringValue(input.permalink),
      url: stringValue(input.url),
      createdUtc: numberValue(input.created_utc) ?? numberValue(input.createdUtc),
      score: numberValue(input.score),
      commentCount: numberValue(input.num_comments) ?? numberValue(input.commentCount),
      parentTitle: stringValue(input.link_title) ?? stringValue(input.parentTitle)
    }
  ];
}

function scoreRelevance(text: string): number {
  const terms: Array<[RegExp, number]> = [
    [/\bai agents?\b/i, 4],
    [/\bagents?\b/i, 2],
    [/\bmcp\b/i, 4],
    [/\bsdk\b/i, 3],
    [/\bprivacy\b/i, 3],
    [/\bprivate\b/i, 3],
    [/\bencrypt(?:ed|ion)?\b/i, 3],
    [/\bmessage|messaging|inbox\b/i, 2],
    [/\bcoordination|coordinate\b/i, 3],
    [/\bwallet|signing|onchain|smart contract\b/i, 2],
    [/\btool(?:ing|s)?\b/i, 1],
    [/\bruntime|workflow|automation\b/i, 1]
  ];

  const positive = terms.reduce((score, [pattern, weight]) => {
    return pattern.test(text) ? score + weight : score;
  }, 0);
  const negative = LOW_INTENT_PATTERNS.reduce((score, pattern) => {
    return pattern.test(text) ? score + 4 : score;
  }, 0);

  return Math.max(0, positive - negative);
}

function scoreRisk(
  source: RedditSourceItem,
  rule: RedditSubredditRule | undefined,
  text: string
): number {
  const ruleRisk = rule?.risk === "low" ? 1 : rule?.risk === "medium" ? 3 : rule?.risk === "high" ? 6 : 10;
  const promotionRisk = LOW_INTENT_PATTERNS.some((pattern) => pattern.test(text)) ? 6 : 0;
  const noQuestionRisk = hasExplicitHelpIntent(text) ? 0 : 3;
  const externalUrlRisk = source.url && !source.url.includes("reddit.com") ? 1 : 0;
  return ruleRisk + promotionRisk + noQuestionRisk + externalUrlRisk;
}

function buildExplanatoryDraft(source: RedditSourceItem): string {
  const text = sourceText(source).toLowerCase();

  if (/\bmcp\b|\bsdk\b|\btool/.test(text)) {
    return [
      "I would separate the agent policy from the transport layer.",
      "The agent should decide when a message is worth sending; the tool surface should only handle identity, encryption, delivery, retries, and readable history.",
      "That keeps the integration testable instead of turning every agent decision into infrastructure glue."
    ].join(" ");
  }

  if (/\bprivacy\b|\bprivate\b|\bencrypt/.test(text)) {
    return [
      "The practical split is usually public routing, private payload.",
      "You still need enough metadata to deliver, query, and debug messages, but the actual coordination details should not live in the public thread.",
      "That tradeoff is less pure than total opacity, but it is much easier to operate."
    ].join(" ");
  }

  if (/\bwallet\b|\bonchain\b|\bcontract\b|\breward/.test(text)) {
    return [
      "I would keep incentives separate from the core communication path.",
      "First make the message flow useful without rewards; then let rewards measure meaningful usage, not raw activity count.",
      "Otherwise the system optimizes for noisy transactions instead of useful coordination."
    ].join(" ");
  }

  return [
    "The failure mode is trying to solve coordination with one generic channel.",
    "Agents usually need a narrower contract: who can send, who can read, what metadata stays public, and how the receiving side audits history.",
    "Once those boundaries are explicit, the implementation gets much less hand-wavy."
  ].join(" ");
}

function explainRelevance(text: string, score: number, hasExplicitIntent: boolean): string {
  const matched: string[] = [];
  if (/\bagents?\b/i.test(text)) matched.push("agent workflow");
  if (/\bmcp\b|\bsdk\b/i.test(text)) matched.push("integration surface");
  if (/\bprivacy\b|\bprivate\b|\bencrypt/i.test(text)) matched.push("privacy tradeoff");
  if (/\bcoordination|message|messaging|inbox/i.test(text)) matched.push("coordination/messaging");

  if (matched.length === 0) {
    return `Low relevance (${score}); no core target topic matched.`;
  }

  return `${hasExplicitIntent ? "Explicit help intent" : "No explicit help intent"} with ${matched.join(", ")} relevance (${score}).`;
}

function sourceText(source: RedditSourceItem): string {
  return [source.parentTitle, source.title, source.body].filter(Boolean).join("\n");
}

function hasExplicitHelpIntent(text: string): boolean {
  return EXPLICIT_HELP_PATTERNS.some((pattern) => pattern.test(text));
}

function containsProductMention(content: string, aliases: readonly string[]): boolean {
  const normalized = content.toLowerCase();
  return aliases.some((alias) => normalized.includes(alias.toLowerCase()));
}

function containsAnyCta(content: string): boolean {
  return CTA_PATTERNS.some((pattern) => pattern.test(content));
}

function findMostSimilarOutbound(
  content: string,
  history: readonly RedditOutboundMemoryEntry[]
): { entry: RedditOutboundMemoryEntry; score: number } | undefined {
  return history.reduce<{ entry: RedditOutboundMemoryEntry; score: number } | undefined>((best, entry) => {
    const score = textSimilarity(content, entry.content);
    if (!best || score > best.score) {
      return { entry, score };
    }

    return best;
  }, undefined);
}

export function textSimilarity(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / (leftTokens.size + rightTokens.size - overlap);
}

function tokenSet(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter(
      (token) => !["that", "this", "with", "from", "they", "your", "what", "when"].includes(token)
    )
  );
}

function countRecentFirstReplies(
  history: readonly RedditOutboundMemoryEntry[],
  now: Date,
  subreddit?: string
): number {
  const cutoff = now.getTime() - 24 * 60 * 60 * 1_000;
  return history.filter((entry) => {
    const createdAt = Date.parse(entry.createdAt);
    if (Number.isNaN(createdAt) || createdAt < cutoff || !entry.firstReply) {
      return false;
    }

    return subreddit ? entry.subreddit.toLowerCase() === subreddit.toLowerCase() : true;
  }).length;
}

function findRule(
  registry: RedditRulesRegistry,
  subreddit: string
): RedditSubredditRule | undefined {
  return registry.rules.find((rule) => rule.name.toLowerCase() === subreddit.toLowerCase());
}

function findDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }

  return undefined;
}

function subredditsWithAtLeast(
  entries: readonly RedditOutboundMemoryEntry[],
  threshold: number
): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.subreddit, (counts.get(entry.subreddit) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= threshold)
    .map(([subreddit]) => subreddit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
