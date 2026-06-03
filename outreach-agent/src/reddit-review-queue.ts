import {
  canUseProductSpecificFollowUp,
  resolvePromptProfile,
  validateDraftAgainstPromptProfile,
  validatePromptProfile,
  type PromptProfile
} from "./prompt-profile.js";
import { assessPrivateMessageEscalation, type PrivateMessageEscalationAssessment } from "./policy.js";
import { redditMemoryEntryConsumesTarget } from "./reddit-evaluation.js";
import {
  CTA_PATTERNS,
  DEFAULT_MAX_FIRST_REPLIES_GLOBAL_PER_DAY,
  DEFAULT_MAX_FIRST_REPLIES_PER_SUBREDDIT_PER_DAY,
  DISCOVERY_MIN_RELEVANCE_SCORE,
  LOW_INTENT_PATTERNS,
  SAME_THREAD_SIMILARITY_BLOCK_THRESHOLD,
  SIMILARITY_BLOCK_THRESHOLD,
  THREAD_COMMENT_SIMILARITY_BLOCK_THRESHOLD,
  URL_PATTERN
} from "./reddit-outreach-patterns.js";
import type {
  RedditOutboundMemoryEntry,
  RedditOutreachTargeting,
  RedditReviewGate,
  RedditReviewItem,
  RedditReviewQueue,
  RedditRulesRegistry,
  RedditSourceItem,
  RedditSourceTriageResult,
  RedditSubredditRule
} from "./reddit-outreach-types.js";
import {
  assertRulesRegistryCoversTargets,
  assertTargetingIsViable,
  DEFAULT_REDDIT_RULES_REGISTRY
} from "./reddit-rules.js";
import { DEFAULT_REDDIT_TARGETING } from "./reddit-targeting.js";
import {
  buildRedditTriageSignals,
  hasArgumentativeConflict,
  hasExplicitHelpIntent,
  hasExplicitProductInterest,
  scoreRisk,
  sourceText,
  textSimilarity,
  buildExplanatoryDraft,
  explainRelevance,
  findMostSimilarOutbound,
  countRecentFirstReplies,
  containsProductMention
} from "./reddit-source-heuristics.js";

function findRule(
  registry: RedditRulesRegistry,
  subreddit: string
): RedditSubredditRule | undefined {
  return registry.rules.find((rule) => rule.name.toLowerCase() === subreddit.toLowerCase());
}

export type RedditDuplicateCheckPolicy = "block_all_outbound" | "block_posted_only";

export function buildRedditReviewQueue(input: {
  items: readonly RedditSourceItem[];
  history?: readonly RedditOutboundMemoryEntry[];
  targeting?: RedditOutreachTargeting;
  registry?: RedditRulesRegistry;
  promptProfile?: PromptProfile;
  promptProfileId?: string;
  duplicateCheckPolicy?: RedditDuplicateCheckPolicy;
  triageByItemId?: ReadonlyMap<string, RedditSourceTriageResult>;
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
      buildReviewItem(
        item,
        targeting,
        registry,
        history,
        now,
        input.promptProfile,
        input.promptProfileId,
        input.items,
        input.duplicateCheckPolicy ?? "block_posted_only",
        input.triageByItemId?.get(`${item.kind}:${item.subreddit}:${item.id}`)
      )
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

export function outboundHistoryForSimilarityCheck(
  history: readonly RedditOutboundMemoryEntry[],
  policy: RedditDuplicateCheckPolicy = "block_posted_only"
): readonly RedditOutboundMemoryEntry[] {
  const withContent = history.filter((entry) => Boolean(entry.content?.trim()));
  if (policy === "block_all_outbound") {
    return withContent;
  }
  return withContent.filter((entry) => redditMemoryEntryConsumesTarget(entry));
}

export function collectPeerThreadCommentBodies(
  source: RedditSourceItem,
  items: readonly RedditSourceItem[]
): string[] {
  const threadPostId = resolveSourceThreadPostId(source);
  if (!threadPostId) {
    return [];
  }

  return items
    .filter(
      (item) =>
        item.id !== source.id &&
        resolveSourceThreadPostId(item) === threadPostId &&
        item.kind === "comment" &&
        Boolean(item.body?.trim())
    )
    .map((item) => item.body!.trim());
}

export function resolveSourceThreadPostId(source: RedditSourceItem): string | undefined {
  if (source.threadPostId) {
    return source.threadPostId;
  }
  if (source.kind === "post") {
    return source.id;
  }
  if (source.permalink) {
    return parseRedditThreadUrlFromPath(source.permalink);
  }
  if (source.url) {
    return parseRedditThreadUrlFromPath(source.url);
  }
  return undefined;
}

function parseRedditThreadUrlFromPath(input: string): string | undefined {
  try {
    const url = input.startsWith("http") ? new URL(input) : new URL(input, "https://www.reddit.com");
    const match = url.pathname.match(/\/r\/[^/]+\/comments\/([^/]+)/i);
    return match?.[1]?.replace(/^t[0-9]_/, "");
  } catch {
    return undefined;
  }
}

function buildReviewItem(
  source: RedditSourceItem,
  targeting: RedditOutreachTargeting,
  registry: RedditRulesRegistry,
  history: readonly RedditOutboundMemoryEntry[],
  now: Date,
  promptProfile: PromptProfile | undefined,
  promptProfileId: string | undefined,
  allItems: readonly RedditSourceItem[],
  duplicateCheckPolicy: RedditDuplicateCheckPolicy,
  triage?: RedditSourceTriageResult
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
  const signals = buildRedditTriageSignals({ source, triage, now });
  const hasPainSignal = signals.hasPainSignal;
  const hasExplicitIntent = signals.hasExplicitIntent;
  const needsHelp = hasExplicitIntent || hasPainSignal;
  const explicitProductInterest = hasExplicitProductInterest(text, targeting.productAliases);
  const privateMessageAssessment = assessPrivateMessageEscalation({ text });
  const publicValueDeliveredFirst = false;
  const productSpecificFollowUp = canUseProductSpecificFollowUp({
    venue: "reddit",
    explicitInterest: explicitProductInterest,
    publicValueDeliveredFirst
  });
  const relevanceScore = signals.relevanceScore;
  const riskScore = scoreRisk(source, rule, text, now);
  const topicalMatch = signals.topicalMatch;
  const discoveryThread = source.onOwnThread !== true;
  const passesDiscoveryFit = signals.passesDiscoveryFit;
  const draft =
    relevanceScore >= 5 && needsHelp && passesDiscoveryFit
      ? buildExplanatoryDraft(source, resolvedPromptProfile.parameters.layout)
      : undefined;
  const gates = buildGates(
    source,
    draft,
    targeting,
    rule,
    history,
    now,
    hasExplicitIntent,
    hasPainSignal,
    explicitProductInterest,
    privateMessageAssessment,
    productSpecificFollowUp.reason,
    resolvedPromptProfile,
    collectPeerThreadCommentBodies(source, allItems),
    duplicateCheckPolicy,
    {
      discoveryThread,
      topicalMatch,
      relevanceScore,
      passesDiscoveryFit
    },
    triage
  );
  const blocked = gates.some((gate) => gate.severity === "block" && !gate.passed);

  return {
    id: `${source.kind}:${source.subreddit}:${source.id}`,
    source,
    action: chooseAction(source, relevanceScore, hasExplicitIntent, hasPainSignal, topicalMatch, rule),
    status: blocked ? "blocked" : "needs_human_review",
    relevanceScore,
    riskScore,
    draft,
    promptProfileId: resolvedPromptProfile.id,
    promptParameters: resolvedPromptProfile.parameters,
    layout: resolvedPromptProfile.parameters.layout,
    explicitProductInterest,
    privateMessageAssessment,
    publicValueDeliveredFirst,
    whyRelevant: explainRelevance(source, text, relevanceScore, hasExplicitIntent, hasPainSignal, now),
    gates,
    approvalRequired: true,
    approvalChecklist: [
      "Confirm the live subreddit rules still allow this kind of technical answer.",
      "Confirm the first reply contains no product name, owned link, CTA, demo offer, or DM prompt.",
      explicitProductInterest
        ? "Only mention product-specific details because the user explicitly asked after receiving a useful answer."
        : "Keep any follow-up generic until the user explicitly asks for product/tool specifics.",
      privateMessageAssessment.shouldEscalate
        ? privateMessageAssessment.requiresPublicReplyFirst
          ? `If private follow-up is needed, answer publicly first and move private only for ${privateMessageAssessment.reason?.replaceAll("_", " ")}.`
          : `Do not keep sensitive details in-thread; ${privateMessageAssessment.reason?.replaceAll("_", " ")} can justify private follow-up.`
        : "Do not suggest PMs here; the public thread should stay the main help surface.",
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
  hasPainSignal: boolean,
  topicalMatch: boolean,
  rule: RedditSubredditRule | undefined
): RedditReviewItem["action"] {
  if (!rule || rule.risk === "blocked") {
    return "ignore";
  }

  if (relevanceScore < 5) {
    return "ignore";
  }

  const canAnswerPublicly =
    hasExplicitIntent ||
    hasPainSignal ||
    (topicalMatch && relevanceScore >= DISCOVERY_MIN_RELEVANCE_SCORE);
  if (!canAnswerPublicly) {
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
  hasPainSignal: boolean,
  explicitProductInterest: boolean,
  privateMessageAssessment: PrivateMessageEscalationAssessment,
  productSpecificFollowUpReason: string,
  resolvedPromptProfile: ReturnType<typeof resolvePromptProfile>,
  peerThreadComments: readonly string[] = [],
  duplicateCheckPolicy: RedditDuplicateCheckPolicy = "block_posted_only",
  discoveryContext: {
    discoveryThread: boolean;
    topicalMatch: boolean;
    relevanceScore: number;
    passesDiscoveryFit: boolean;
  } = {
    discoveryThread: false,
    topicalMatch: false,
    relevanceScore: 0,
    passesDiscoveryFit: true
  },
  triage?: RedditSourceTriageResult
): RedditReviewGate[] {
  const threadPostId = resolveSourceThreadPostId(source);
  const similar = draft
    ? findMostSimilarOutbound(
        draft,
        outboundHistoryForSimilarityCheck(history, duplicateCheckPolicy),
        threadPostId
      )
    : undefined;
  const similarThreadCommentScore =
    draft && peerThreadComments.length > 0
      ? peerThreadComments.reduce(
          (best, body) => Math.max(best, textSimilarity(draft, body)),
          0
        )
      : 0;
  const duplicateThreshold = similar?.threshold ?? SIMILARITY_BLOCK_THRESHOLD;
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
      id: "clear_user_need",
      passed: (hasExplicitIntent || hasPainSignal) && discoveryContext.passesDiscoveryFit,
      severity: "block",
      reason:
        !(hasExplicitIntent || hasPainSignal)
          ? "No explicit help intent or operational pain; public replies would still be unsolicited."
          : !discoveryContext.passesDiscoveryFit
            ? "Discovery thread lacks agent-messaging topical fit and relevance is below the cold-thread threshold."
            : "The source shows explicit help intent or clear operational pain."
    },
    {
      id: "discovery_topical_fit",
      passed: discoveryContext.passesDiscoveryFit,
      severity: "block",
      reason: discoveryContext.discoveryThread
        ? discoveryContext.passesDiscoveryFit
          ? discoveryContext.topicalMatch
            ? `Discovery thread matches agent-messaging topics (relevance ${discoveryContext.relevanceScore}).`
            : `Discovery thread cleared on high relevance (${discoveryContext.relevanceScore} >= ${DISCOVERY_MIN_RELEVANCE_SCORE}).`
          : `Discovery thread needs agent-messaging topics or relevance >= ${DISCOVERY_MIN_RELEVANCE_SCORE}; got ${discoveryContext.relevanceScore}.`
        : "Own-thread follow-up; discovery topical gate not applied."
    },
    {
      id: "low_spam_topic_risk",
      passed: !LOW_INTENT_PATTERNS.some((pattern) => pattern.test(sourceText(source))),
      severity: "block",
      reason: "Reject price, giveaway, airdrop, referral, and shill-adjacent threads."
    },
    {
      id: "low_argument_risk",
      passed: triage ? !triage.hostileOrBait : !hasArgumentativeConflict(sourceText(source)),
      severity: "block",
      reason: triage?.hostileOrBait
        ? "LLM triage flagged hostile or bait thread."
        : "Skip hostile, bait, rant, or accusation-heavy threads."
    },
    ...(triage
      ? [
          {
            id: "reddit_llm_triage",
            passed: triage.worthPublicReply && triage.relevant,
            severity: "block" as const,
            reason: triage.reason
          }
        ]
      : []),
    {
      id: "safe_draft_generated",
      passed: Boolean(draft),
      severity: "block",
      reason: draft
        ? "Safe explanatory draft generated."
        : "No safe explanatory draft could be generated."
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
        id: "product_follow_up_requires_explicit_interest",
        passed: explicitProductInterest,
        severity: "info",
        reason: productSpecificFollowUpReason
      },
      {
        id: "pm_only_when_needed",
        passed: !privateMessageAssessment.shouldEscalate,
        severity: privateMessageAssessment.shouldEscalate ? "warning" : "info",
        reason: privateMessageAssessment.shouldEscalate
          ? `${privateMessageAssessment.explanation} Keep the initial answer public unless sensitive details are already exposed.`
          : privateMessageAssessment.explanation
      },
      {
        id: "not_near_duplicate",
        passed: !similar || similar.score < duplicateThreshold,
        severity: "block",
        reason: similar
          ? `Most similar prior outbound score ${similar.score.toFixed(2)} from ${similar.entry.id} (threshold ${duplicateThreshold.toFixed(2)}).`
          : "No similar prior outbound content found."
      },
      {
        id: "not_redundant_with_thread",
        passed: similarThreadCommentScore < THREAD_COMMENT_SIMILARITY_BLOCK_THRESHOLD,
        severity: "block",
        reason:
          similarThreadCommentScore >= THREAD_COMMENT_SIMILARITY_BLOCK_THRESHOLD
            ? `Draft overlaps an existing thread comment (score ${similarThreadCommentScore.toFixed(2)}).`
            : peerThreadComments.length > 0
              ? "Draft is sufficiently distinct from visible thread comments."
              : "No peer thread comments were ingested for comparison."
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
