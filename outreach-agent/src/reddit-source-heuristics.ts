import type { LayoutVariant } from "./prompt-profile.js";
import { redditMemoryEntryCountsTowardPublishedLimits } from "./reddit-evaluation.js";
import {
  AGENT_MESSAGING_TOPIC_PATTERNS,
  ARGUMENT_OR_HOSTILITY_PATTERNS,
  CTA_PATTERNS,
  DISCOVERY_MIN_RELEVANCE_SCORE,
  EXPLICIT_HELP_PATTERNS,
  LOW_INTENT_PATTERNS,
  OPERATIONAL_PAIN_PATTERNS,
  PRODUCT_INTEREST_PATTERNS,
  RHETORICAL_TITLE_PATTERNS,
  SAME_THREAD_SIMILARITY_BLOCK_THRESHOLD,
  SIMILARITY_BLOCK_THRESHOLD,
  SUBSTANTIVE_DISCUSSION_PATTERNS
} from "./reddit-outreach-patterns.js";

const PRIVATE_MESSAGE_PROMPT_PATTERNS = [/\b(?:dm|pm) me\b/i, /\bmessage me\b/i] as const;
import type {
  RedditOutboundMemoryEntry,
  RedditRulesRegistry,
  RedditSourceItem,
  RedditSourceTriageResult,
  RedditSubredditRule
} from "./reddit-outreach-types.js";

export function redditSourceReviewId(source: Pick<RedditSourceItem, "kind" | "subreddit" | "id">): string {
  return `${source.kind}:${source.subreddit}:${source.id}`;
}

export function buildRedditTriageSignals(input: {
  source: RedditSourceItem;
  triage?: RedditSourceTriageResult;
  now: Date;
}): {
  hasExplicitIntent: boolean;
  hasPainSignal: boolean;
  topicalMatch: boolean;
  passesDiscoveryFit: boolean;
  relevanceScore: number;
} {
  const text = sourceText(input.source);
  const discoveryThread = input.source.onOwnThread !== true;
  let hasExplicitIntent = hasExplicitHelpIntent(input.source);
  let hasPainSignal = hasOperationalPain(text);
  let topicalMatch = hasAgentMessagingTopicMatch(text);
  const relevanceScore = scoreRedditSourceRelevance(input.source, text, input.now);
  let passesDiscoveryFit =
    !discoveryThread || topicalMatch || relevanceScore >= DISCOVERY_MIN_RELEVANCE_SCORE;

  if (!input.triage) {
    return { hasExplicitIntent, hasPainSignal, topicalMatch, passesDiscoveryFit, relevanceScore };
  }

  if (input.triage.hostileOrBait || !input.triage.relevant || !input.triage.worthPublicReply) {
    return {
      hasExplicitIntent: false,
      hasPainSignal: false,
      topicalMatch: false,
      passesDiscoveryFit: false,
      relevanceScore
    };
  }

  if (input.triage.helpIntent === "explicit_question" || input.triage.helpIntent === "discussion") {
    hasExplicitIntent = true;
  }
  if (input.triage.helpIntent === "operational_pain") {
    hasPainSignal = true;
  }
  if (input.triage.topicalFit === "strong" || input.triage.topicalFit === "weak") {
    topicalMatch = true;
  }
  if (!discoveryThread || input.triage.topicalFit !== "none") {
    passesDiscoveryFit = true;
  }

  return { hasExplicitIntent, hasPainSignal, topicalMatch, passesDiscoveryFit, relevanceScore };
}

export function scoreRedditSourceRelevance(source: RedditSourceItem, text: string, now: Date): number {
  const terms: Array<[RegExp, number]> = [
    [/\bai agents?\b/i, 4],
    [/\bagents?\b/i, 2],
    [/\bmcp\b/i, 4],
    [/\blangchain\b/i, 3],
    [/\bollama\b/i, 2],
    [/\bsdk\b/i, 3],
    [/\bprivacy\b/i, 3],
    [/\bprivate\b/i, 3],
    [/\bencrypt(?:ed|ion)?\b/i, 3],
    [/\bmessage|messaging|inbox\b/i, 2],
    [/\bcoordination|coordinate\b/i, 3],
    [/\borchestrat(?:e|ion|ing)\b/i, 2],
    [/\btool[- ]?call(?:ing)?\b/i, 2],
    [/\bwallet|signing|onchain|smart contract\b/i, 2],
    [/\btool(?:ing|s)?\b/i, 1],
    [/\bruntime|workflow|automation\b/i, 1],
    [/\bmulti[- ]?agent\b/i, 2]
  ];

  const positive = terms.reduce((score, [pattern, weight]) => {
    return pattern.test(text) ? score + weight : score;
  }, 0);
  const negative = LOW_INTENT_PATTERNS.reduce((score, pattern) => {
    return pattern.test(text) ? score + 4 : score;
  }, 0);
  const helpBoost = hasExplicitHelpIntent(source) ? 2 : 0;
  const painBoost = OPERATIONAL_PAIN_PATTERNS.some((pattern) => pattern.test(text)) ? 2 : 0;
  const freshness = freshnessBoost(source, now);
  const activity = conversationActivityBoost(source);
  const argumentPenalty = hasArgumentativeConflict(text) ? 4 : 0;

  return Math.max(0, positive + helpBoost + painBoost + freshness + activity - negative - argumentPenalty);
}

export function scoreRisk(
  source: RedditSourceItem,
  rule: RedditSubredditRule | undefined,
  text: string,
  now: Date
): number {
  const ruleRisk = rule?.risk === "low" ? 1 : rule?.risk === "medium" ? 3 : rule?.risk === "high" ? 6 : 10;
  const promotionRisk = LOW_INTENT_PATTERNS.some((pattern) => pattern.test(text)) ? 6 : 0;
  const noQuestionRisk = hasExplicitHelpIntent(source) ? 0 : 3;
  const externalUrlRisk = source.url && !source.url.includes("reddit.com") ? 1 : 0;
  const argumentRisk = ARGUMENT_OR_HOSTILITY_PATTERNS.some((pattern) => pattern.test(text)) ? 5 : 0;
  const staleRisk = freshnessBoost(source, now) === 0 ? 2 : 0;
  return ruleRisk + promotionRisk + noQuestionRisk + externalUrlRisk + argumentRisk + staleRisk;
}

export function buildExplanatoryDraft(source: RedditSourceItem, layout: LayoutVariant): string {
  const text = sourceText(source).toLowerCase();
  let sentences: string[];
  if (/\bmcp\b|\bsdk\b|\btool/.test(text)) {
    sentences = [
      "Separate the agent policy from the transport layer.",
      "The agent should decide when a message is worth sending; the tool surface should only handle identity, encryption, delivery, retries, and readable history.",
      "That keeps the integration testable instead of turning every agent decision into infrastructure glue."
    ];
  } else if (/\bprivacy\b|\bprivate\b|\bencrypt/.test(text)) {
    sentences = [
      "Use public routing and private payloads.",
      "You still need enough metadata to deliver, query, and debug messages, but the actual coordination details should not live in the public thread.",
      "That tradeoff is less pure than total opacity, but it is much easier to operate."
    ];
  } else if (/\bwallet\b|\bonchain\b|\bcontract\b|\breward/.test(text)) {
    sentences = [
      "Keep incentives separate from the core communication path.",
      "First make the message flow useful without rewards; then let rewards measure meaningful usage, not raw activity count.",
      "Otherwise the system optimizes for noisy transactions instead of useful coordination."
    ];
  } else {
    sentences = [
      "The failure mode is trying to solve coordination with one generic channel.",
      "Agents usually need a narrower contract: who can send, who can read, what metadata stays public, and how the receiving side audits history.",
      "Once those boundaries are explicit, the implementation gets much less hand-wavy."
    ];
  }

  if (layout === "question_answer") {
    return [`Short answer: ${sentences[0]}`, sentences[1], sentences[2]].join(" ");
  }
  if (layout === "problem_solution") {
    return [`Problem: ${sentences[0]}`, `Solution: ${sentences[1]}`, sentences[2]].join(" ");
  }
  if (layout === "short_hook_then_detail") {
    return `Fair point. ${sentences.join(" ")}`;
  }
  return sentences.join(" ");
}

export function explainRelevance(
  source: RedditSourceItem,
  text: string,
  score: number,
  hasExplicitIntent: boolean,
  hasPainSignal: boolean,
  now: Date
): string {
  const matched: string[] = [];
  if (/\bagents?\b/i.test(text)) matched.push("agent workflow");
  if (/\bmcp\b|\bsdk\b/i.test(text)) matched.push("integration surface");
  if (/\bprivacy\b|\bprivate\b|\bencrypt/i.test(text)) matched.push("privacy tradeoff");
  if (/\bcoordination|message|messaging|inbox/i.test(text)) matched.push("coordination/messaging");
  if (hasPainSignal) matched.push("operational pain");
  const freshness = freshnessBoost(source, now);
  if (freshness > 0) matched.push(freshness >= 2 ? "fresh thread" : "active thread");

  if (matched.length === 0) {
    return `Low relevance (${score}); no core target topic matched.`;
  }

  return `${hasExplicitIntent ? "Explicit help intent" : hasPainSignal ? "Clear operational pain" : "No explicit help intent"} with ${matched.join(", ")} relevance (${score}).`;
}

export function sourceText(source: RedditSourceItem): string {
  return [source.parentTitle, source.title, source.body].filter(Boolean).join("\n");
}

export function hasAgentMessagingTopicMatch(text: string): boolean {
  return AGENT_MESSAGING_TOPIC_PATTERNS.some((pattern) => pattern.test(text));
}

export function passesDiscoveryTopicalFit(input: {
  discoveryThread: boolean;
  topicalMatch: boolean;
  relevanceScore: number;
}): boolean {
  if (!input.discoveryThread) {
    return true;
  }
  return input.topicalMatch || input.relevanceScore >= DISCOVERY_MIN_RELEVANCE_SCORE;
}

export function hasExplicitHelpIntent(source: RedditSourceItem): boolean {
  const title = source.title?.trim() ?? "";
  const body = source.body?.trim() ?? "";

  if (body.length > 0) {
    if (EXPLICIT_HELP_PATTERNS.some((pattern) => pattern.test(body))) {
      return true;
    }
    if (/\?/.test(body)) {
      return true;
    }
    if (
      body.length >= 48 &&
      (hasAgentMessagingTopicMatch(body) || hasOperationalPain(body))
    ) {
      return true;
    }
    if (body.length >= 72 && SUBSTANTIVE_DISCUSSION_PATTERNS.some((pattern) => pattern.test(body))) {
      return true;
    }
    return false;
  }

  if (!title) {
    return false;
  }

  if (RHETORICAL_TITLE_PATTERNS.some((pattern) => pattern.test(title))) {
    return false;
  }

  if (EXPLICIT_HELP_PATTERNS.some((pattern) => pattern.test(title))) {
    return true;
  }

  return /\?/.test(title) && /\b(how|what|why|should|can|recommend|advice)\b/i.test(title);
}

function hasOperationalPain(text: string): boolean {
  return OPERATIONAL_PAIN_PATTERNS.some((pattern) => pattern.test(text));
}

export function hasArgumentativeConflict(text: string): boolean {
  return ARGUMENT_OR_HOSTILITY_PATTERNS.some((pattern) => pattern.test(text));
}

export function hasExplicitProductInterest(text: string, aliases: readonly string[]): boolean {
  return (
    PRODUCT_INTEREST_PATTERNS.some((pattern) => pattern.test(text)) ||
    aliases.some((alias) => new RegExp(`\\b${escapeRegex(alias)}\\b`, "i").test(text))
  );
}

export function containsProductMention(content: string, aliases: readonly string[]): boolean {
  const normalized = content.toLowerCase();
  return aliases.some((alias) => normalized.includes(alias.toLowerCase()));
}

function containsAnyCta(content: string): boolean {
  return CTA_PATTERNS.some((pattern) => pattern.test(content));
}

function containsPrivateMessagePrompt(content: string): boolean {
  return PRIVATE_MESSAGE_PROMPT_PATTERNS.some((pattern) => pattern.test(content));
}

export function findMostSimilarOutbound(
  content: string,
  history: readonly RedditOutboundMemoryEntry[],
  threadPostId?: string
): { entry: RedditOutboundMemoryEntry; score: number; threshold: number } | undefined {
  return history.reduce<
    { entry: RedditOutboundMemoryEntry; score: number; threshold: number } | undefined
  >((best, entry) => {
    const score = textSimilarity(content, entry.content);
    const threshold =
      threadPostId && entry.threadPostId === threadPostId
        ? SAME_THREAD_SIMILARITY_BLOCK_THRESHOLD
        : SIMILARITY_BLOCK_THRESHOLD;
    if (!best || score > best.score) {
      return { entry, score, threshold };
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

export function countRecentFirstReplies(
  history: readonly RedditOutboundMemoryEntry[],
  now: Date,
  subreddit?: string
): number {
  const cutoff = now.getTime() - 24 * 60 * 60 * 1_000;
  return history.filter((entry) => {
    const createdAt = Date.parse(entry.createdAt);
    if (
      Number.isNaN(createdAt) ||
      createdAt < cutoff ||
      !entry.firstReply ||
      !redditMemoryEntryCountsTowardPublishedLimits(entry)
    ) {
      return false;
    }

    return subreddit ? entry.subreddit.toLowerCase() === subreddit.toLowerCase() : true;
  }).length;
}

function freshnessBoost(source: RedditSourceItem, now: Date): number {
  if (!source.createdUtc) {
    return 0;
  }
  const ageHours = (now.getTime() - source.createdUtc * 1_000) / (60 * 60 * 1_000);
  if (ageHours <= 12) {
    return 2;
  }
  if (ageHours <= 36) {
    return 1;
  }
  return 0;
}

function conversationActivityBoost(source: RedditSourceItem): number {
  const commentCount = source.commentCount ?? 0;
  if (commentCount >= 20) {
    return 2;
  }
  if (commentCount >= 8) {
    return 1;
  }
  return 0;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
