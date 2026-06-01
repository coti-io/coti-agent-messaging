import { buildMainLlmProvider, type MoltbookRuntimeConfig } from "./config.js";
import type { JsonLlmProvider } from "./llm-client.js";
import {
  hasAgentMessagingTopicMatch,
  hasExplicitHelpIntent,
  redditSourceReviewId,
  scoreRedditSourceRelevance,
  type RedditOutreachTargeting,
  type RedditSourceItem,
  type RedditSourceTriageResult,
  type RedditTriageHelpIntent,
  type RedditTriageTopicalFit
} from "./reddit-outreach.js";

export type { RedditSourceTriageResult, RedditTriageHelpIntent, RedditTriageTopicalFit };

export interface RedditTriageBatchResult {
  byItemId: Map<string, RedditSourceTriageResult>;
  triagedCount: number;
  skippedCount: number;
  providerLabel?: string;
}

const TRIAGE_CHUNK_SIZE = 12;
const BODY_PREVIEW_CHARS = 480;

interface RedditTriageLlmRow {
  id: string;
  relevant: boolean;
  helpIntent: RedditTriageHelpIntent;
  topicalFit: RedditTriageTopicalFit;
  hostileOrBait: boolean;
  worthPublicReply: boolean;
  confidence?: number;
  reason?: string;
}

interface RedditTriageLlmResponse {
  results: RedditTriageLlmRow[];
}

export async function triageRedditSourceItems(input: {
  config: MoltbookRuntimeConfig;
  items: readonly RedditSourceItem[];
  targeting: RedditOutreachTargeting;
  activeSubredditNames?: readonly string[];
  maxItems: number;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<RedditTriageBatchResult> {
  const now = input.now ?? new Date();
  const active = new Set(
    (input.activeSubredditNames ?? input.targeting.targetSubreddits.map((entry) => entry.name)).map((name) =>
      name.toLowerCase()
    )
  );
  const eligible = input.items
    .filter((item) => active.has(item.subreddit.toLowerCase()))
    .map((item) => ({
      item,
      id: redditSourceReviewId(item),
      score: scoreRedditSourceRelevance(
        item,
        [item.parentTitle, item.title, item.body].filter(Boolean).join("\n"),
        now
      )
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(0, input.maxItems));

  const byItemId = new Map<string, RedditSourceTriageResult>();
  if (eligible.length === 0) {
    return { byItemId, triagedCount: 0, skippedCount: input.items.length };
  }

  const llmProvider = buildMainLlmProvider(input.config, input.fetchImpl);
  if (!llmProvider) {
    for (const entry of eligible) {
      byItemId.set(entry.id, regexFallbackTriage(entry.item, now));
    }
    return {
      byItemId,
      triagedCount: eligible.length,
      skippedCount: input.items.length - eligible.length,
      providerLabel: "regex_fallback"
    };
  }

  for (const chunk of chunkArray(eligible, TRIAGE_CHUNK_SIZE)) {
    try {
      const response = await requestTriageChunk({
        llmProvider,
        targeting: input.targeting,
        chunk
      });
      for (const row of response) {
        byItemId.set(row.id, normalizeTriageRow(row));
      }
    } catch {
      for (const entry of chunk) {
        byItemId.set(entry.id, regexFallbackTriage(entry.item, now));
      }
    }
  }

  return {
    byItemId,
    triagedCount: byItemId.size,
    skippedCount: input.items.length - eligible.length,
    providerLabel: llmProvider.label
  };
}

async function requestTriageChunk(input: {
  llmProvider: JsonLlmProvider;
  targeting: RedditOutreachTargeting;
  chunk: Array<{ id: string; item: RedditSourceItem; score: number }>;
}): Promise<RedditTriageLlmRow[]> {
  const response = await input.llmProvider.createJsonCompletion<RedditTriageLlmResponse>([
    {
      role: "system",
      content: [
        "You triage Reddit posts/comments for a technical outreach agent focused on:",
        "AI agents, MCP, private agent messaging, agent coordination, encrypted channels, and wallet-backed automation.",
        "Product: zero marketing in public replies — triage only, do not draft a reply.",
        "Mark worthPublicReply=true only when a helpful public comment would be welcome, on-topic, and not spammy.",
        "helpIntent:",
        "- explicit_question: clear ask for help, how-to, or tool choice",
        "- operational_pain: broken workflow, failure, manual ops pain",
        "- discussion: substantive technical discussion without a direct question",
        "- none: rant, meme, off-topic, low-signal, or engagement bait",
        "topicalFit: strong | weak | none relative to agent messaging infrastructure.",
        "hostileOrBait: true for flamewars, insults, change-my-mind bait, obvious shill fights.",
        "Return strict JSON: { results: [{ id, relevant, helpIntent, topicalFit, hostileOrBait, worthPublicReply, confidence, reason }] }",
        "Include every input id exactly once."
      ].join(" ")
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          audience: input.targeting.targetAudience,
          productFocus: input.targeting.productName,
          items: input.chunk.map((entry) => ({
            id: entry.id,
            kind: entry.item.kind,
            subreddit: entry.item.subreddit,
            onOwnThread: entry.item.onOwnThread === true,
            replyToOurComment: entry.item.replyToOurComment === true,
            title: entry.item.title,
            body: truncate(entry.item.body ?? "", BODY_PREVIEW_CHARS),
            regexRelevanceScore: entry.score
          }))
        },
        null,
        2
      )
    }
  ]);

  const rows = Array.isArray(response.results) ? response.results : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return input.chunk.map((entry) => {
    const row = byId.get(entry.id);
    if (row) {
      return row;
    }
    return {
      id: entry.id,
      relevant: false,
      helpIntent: "none" as const,
      topicalFit: "none" as const,
      hostileOrBait: false,
      worthPublicReply: false,
      confidence: 0,
      reason: "Missing from LLM triage response."
    };
  });
}

function normalizeTriageRow(row: RedditTriageLlmRow): RedditSourceTriageResult {
  return {
    relevant: Boolean(row.relevant),
    helpIntent: normalizeHelpIntent(row.helpIntent),
    topicalFit: normalizeTopicalFit(row.topicalFit),
    hostileOrBait: Boolean(row.hostileOrBait),
    worthPublicReply: Boolean(row.worthPublicReply),
    confidence: clampConfidence(row.confidence),
    reason: row.reason?.trim() || "LLM triage.",
    source: "llm"
  };
}

function regexFallbackTriage(item: RedditSourceItem, now: Date): RedditSourceTriageResult {
  const text = [item.parentTitle, item.title, item.body].filter(Boolean).join("\n");
  const hostileOrBait = /\b(change my mind|fight me|unpopular opinion|idiot|astroturf)\b/i.test(text);
  const topicalMatch = hasAgentMessagingTopicMatch(text);
  const helpIntent = hasExplicitHelpIntent(item)
    ? "explicit_question"
    : /\b(broken|manual|failing|messy|duplicate|incident)\b/i.test(text)
      ? "operational_pain"
      : topicalMatch && (item.body?.length ?? 0) >= 48
        ? "discussion"
        : "none";
  const relevant = topicalMatch || scoreRedditSourceRelevance(item, text, now) >= 6;
  const worthPublicReply =
    relevant &&
    !hostileOrBait &&
    helpIntent !== "none" &&
    (item.onOwnThread === true || item.replyToOurComment === true || topicalMatch);

  return {
    relevant,
    helpIntent,
    topicalFit: topicalMatch ? "strong" : relevant ? "weak" : "none",
    hostileOrBait,
    worthPublicReply,
    confidence: 0.35,
    reason: "Regex fallback triage.",
    source: "regex_fallback"
  };
}

function normalizeHelpIntent(value: string | undefined): RedditTriageHelpIntent {
  if (
    value === "explicit_question" ||
    value === "operational_pain" ||
    value === "discussion" ||
    value === "none"
  ) {
    return value;
  }
  return "none";
}

function normalizeTopicalFit(value: string | undefined): RedditTriageTopicalFit {
  if (value === "strong" || value === "weak" || value === "none") {
    return value;
  }
  return "none";
}

function clampConfidence(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}…`;
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
