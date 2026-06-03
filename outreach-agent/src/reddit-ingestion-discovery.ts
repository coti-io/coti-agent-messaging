import {
  getOutreachAgentConfig,
  getRedditControllerConfig,
  getRedditOperatingAgentConfig,
  type MoltbookRuntimeConfig
} from "./config.js";
import { DEFAULT_REDDIT_DISCOVERY_POOL } from "./reddit-outreach.js";
import { redditMemoryEntryCountsTowardPublishedLimits } from "./reddit-evaluation.js";
import type { RedditOutboundMemoryEntry, RedditSourceItem } from "./reddit-outreach-types.js";
import type { RedditSearchResult } from "./reddit-controller.js";
import {
  getScanLedgerEntry,
  shouldSkipColdDiscoveryRead,
  type RedditScanLedgerEntry
} from "./reddit-scan-ledger.js";
import {
  DEFAULT_REDDIT_INGESTION_DISCOVERY_COMMENT_LIMIT,
  DEFAULT_REDDIT_INGESTION_OWN_THREAD_COMMENT_LIMIT,
  type DiscoveryListingSort,
  type DiscoveryPickStrategy,
  type PickThreadReadCandidatesOptions,
  type RedditIngestionDiagnostics,
  type RedditIngestionInput,
  type RedditOwnThreadTarget
} from "./reddit-ingestion-types.js";
import {
  dedupeSearchResults,
  weightedSampleWithoutReplacement
} from "./reddit-ingestion-utils.js";

export function sampleDiscoverySubreddits(
  pool: readonly string[],
  count: number,
  random: () => number = Math.random
): string[] {
  const unique = [...new Set(pool.map((entry) => entry.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return [];
  }
  return shuffleWithRng(unique, random).slice(0, Math.min(Math.max(0, count), unique.length));
}

/** Weighted toward newest listings: page 0 = 55%, page 1 = 30%, page 2 = 15%. */
export function pickListingPageIndex(random: () => number = Math.random): number {
  const roll = random();
  if (roll < 0.55) {
    return 0;
  }
  if (roll < 0.85) {
    return 1;
  }
  return 2;
}

function defaultSubreddits(config: MoltbookRuntimeConfig): string[] {
  const agent = getOutreachAgentConfig(config);
  if (agent.allowedSurfaces.length > 0) {
    return agent.allowedSurfaces;
  }
  const operating = getRedditOperatingAgentConfig(config);
  const pool =
    operating.discoverySubredditPool.length > 0
      ? operating.discoverySubredditPool
      : [...DEFAULT_REDDIT_DISCOVERY_POOL];
  return sampleDiscoverySubreddits(pool, operating.discoverySubsPerRun, Math.random);
}

function isRedditBrowserHeadless(): boolean {
  const value = process.env.OUTREACH_REDDIT_BROWSER_HEADLESS;
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function appendHeadlessDiscoveryWarning(
  skipped: string[],
  input: {
    usedBrowser: boolean;
    headless: boolean;
    maxDiscoveryThreadReads: number;
    subredditCount: number;
    discoveryThreadSnapshots: number;
  }
): void {
  if (
    !input.headless ||
    !input.usedBrowser ||
    input.maxDiscoveryThreadReads <= 0 ||
    input.subredditCount <= 0 ||
    input.discoveryThreadSnapshots > 0
  ) {
    return;
  }
  skipped.push(
    "discovery_warning: headless browser returned zero discovery snapshots; Reddit often blocks headless — run a headed worker (npm run reddit:browser-worker)"
  );
}

export interface RedditIngestionLimits {
  listLimit: number;
  maxOwnThreadReads: number;
  maxDiscoveryThreadReads: number;
  maxSearchesPerSubreddit: number;
  ownThreadCommentLimit: number;
  discoveryCommentLimit: number;
}

export function resolveIngestionLimits(
  input: RedditIngestionInput,
  operating: ReturnType<typeof getRedditOperatingAgentConfig>
): RedditIngestionLimits {
  const discoveryCap =
    input.maxDiscoveryThreadReads ??
    input.maxThreadReads ??
    operating.ingestionMaxDiscoveryThreadReads;
  return {
    listLimit: input.limitPerSubreddit ?? operating.ingestionListLimit,
    maxOwnThreadReads: input.maxOwnThreadReads ?? operating.ingestionMaxOwnThreadReads,
    maxDiscoveryThreadReads: Math.max(0, discoveryCap),
    maxSearchesPerSubreddit:
      input.maxSearchesPerSubreddit ?? operating.ingestionMaxSearchesPerSubreddit,
    ownThreadCommentLimit:
      input.ownThreadCommentLimit ??
      operating.ingestionOwnThreadCommentLimit ??
      DEFAULT_REDDIT_INGESTION_OWN_THREAD_COMMENT_LIMIT,
    discoveryCommentLimit: input.threadCommentLimit ?? DEFAULT_REDDIT_INGESTION_DISCOVERY_COMMENT_LIMIT
  };
}

export function resolveRedditTargetUrl(
  source: Pick<RedditSourceItem, "url" | "permalink" | "subreddit" | "id" | "kind">
): string | undefined {
  const fromUrl = source.url?.trim();
  if (fromUrl && fromUrl.includes("reddit.com")) {
    try {
      const url = new URL(fromUrl);
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return fromUrl;
    }
  }

  const permalink = source.permalink?.trim();
  if (permalink) {
    const path = permalink.startsWith("/") ? permalink : `/${permalink}`;
    return new URL(path, "https://www.reddit.com").toString();
  }

  if (source.kind === "post" && source.subreddit && source.id) {
    return `https://www.reddit.com/r/${encodeURIComponent(source.subreddit)}/comments/${source.id}/`;
  }

  return undefined;
}

export function resolveRedditTargetTitle(
  source: Pick<RedditSourceItem, "title" | "parentTitle">
): string | undefined {
  const title = source.title?.trim();
  if (title) {
    return title;
  }
  return source.parentTitle?.trim() || undefined;
}

export function parseRedditThreadUrl(
  input: string
): { subreddit: string; postId: string } | undefined {
  try {
    const url = input.startsWith("http") ? new URL(input) : new URL(input, "https://www.reddit.com");
    const match = url.pathname.match(/\/r\/([^/]+)\/comments\/([^/]+)/i);
    if (match?.[1] && match[2]) {
      return {
        subreddit: decodeURIComponent(match[1]),
        postId: normalizeRedditId(match[2])
      };
    }
    const short = url.pathname.match(/\/comments\/([^/]+)/i);
    if (short?.[1]) {
      return { subreddit: "", postId: normalizeRedditId(short[1]) };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function normalizeRedditId(id: string): string {
  return id.replace(/^t[0-9]_/, "");
}

export function collectOwnThreadTargets(
  history: readonly RedditOutboundMemoryEntry[]
): RedditOwnThreadTarget[] {
  const byKey = new Map<string, RedditOwnThreadTarget>();

  for (const entry of history) {
    if (!qualifiesForOwnThreadParticipation(entry)) {
      continue;
    }

    const threadReference = entry.remoteContentUrl ?? entry.targetUrl;
    const parsedUrl = threadReference ? parseRedditThreadUrl(threadReference) : undefined;
    const postId = normalizeRedditId(entry.threadPostId ?? parsedUrl?.postId ?? "");
    const subreddit = (parsedUrl?.subreddit || entry.subreddit || "").trim();
    if (!postId || !subreddit) {
      if (entry.kind === "post" && entry.targetId && entry.subreddit) {
        registerOwnThreadTarget(byKey, {
          postId: normalizeRedditId(entry.targetId),
          subreddit: entry.subreddit,
          url: threadReference,
          lastTouchedAt: entry.createdAt
        });
      }
      continue;
    }

    registerOwnThreadTarget(byKey, {
      postId,
      subreddit,
      url: threadReference,
      permalink: parsedUrl ? `/r/${subreddit}/comments/${postId}/` : undefined,
      lastTouchedAt: entry.createdAt
    });
  }

  return [...byKey.values()].sort(
    (left, right) => Date.parse(right.lastTouchedAt) - Date.parse(left.lastTouchedAt)
  );
}

function registerOwnThreadTarget(
  byKey: Map<string, RedditOwnThreadTarget>,
  target: RedditOwnThreadTarget
): void {
  const key = `${target.subreddit.toLowerCase()}:${target.postId}`;
  const existing = byKey.get(key);
  if (!existing || Date.parse(target.lastTouchedAt) > Date.parse(existing.lastTouchedAt)) {
    byKey.set(key, target);
  }
}

export function createDiscoveryRng(seed?: number): () => number {
  if (seed === undefined) {
    return Math.random;
  }
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

export function shuffleWithRng<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = copy[index];
    copy[index] = copy[swapIndex]!;
    copy[swapIndex] = current!;
  }
  return copy;
}

export function selectDiscoverySearchQueries(
  queries: readonly string[],
  count: number,
  random: () => number = Math.random
): string[] {
  if (count <= 0 || queries.length === 0) {
    return [];
  }
  return shuffleWithRng(queries, random).slice(0, Math.min(count, queries.length));
}

const DISCOVERY_LISTING_SORTS: readonly DiscoveryListingSort[] = ["hot", "new", "rising"];

export function selectDiscoveryListingSort(random: () => number = Math.random): DiscoveryListingSort {
  const roll = random();
  if (roll < 0.4) {
    return DISCOVERY_LISTING_SORTS[0]!;
  }
  if (roll < 0.75) {
    return DISCOVERY_LISTING_SORTS[1]!;
  }
  return DISCOVERY_LISTING_SORTS[2]!;
}

/** Threads to skip when picking new posts from hot/search (not own-thread re-reads). */
export function collectDiscoveryExcludePostIds(
  history: readonly RedditOutboundMemoryEntry[]
): Set<string> {
  const ids = new Set<string>();
  for (const entry of history) {
    if (!qualifiesForOwnThreadParticipation(entry)) {
      continue;
    }
    if (entry.threadPostId) {
      ids.add(entry.threadPostId);
    }
    if (entry.kind === "post" && entry.targetId) {
      ids.add(entry.targetId);
    }
  }
  return ids;
}

/** Any thread we drafted on or posted in should be re-read for follow-up comments. */
export function qualifiesForOwnThreadParticipation(entry: RedditOutboundMemoryEntry): boolean {
  if (
    entry.status === "spam_filtered" ||
    entry.status === "removed" ||
    entry.status === "mod_warning" ||
    entry.status === "spam_accusation" ||
    entry.status === "banned"
  ) {
    return false;
  }
  if (entry.status === "posted") {
    return true;
  }
  if (entry.status === "drafted" && (entry.kind === "comment" || entry.kind === "reply")) {
    return true;
  }
  return entry.kind === "post" && redditMemoryEntryCountsTowardPublishedLimits(entry);
}

export function pickThreadReadCandidates(
  results: readonly RedditSearchResult[],
  maxThreadReads: number,
  options: PickThreadReadCandidatesOptions = {}
): RedditSearchResult[] {
  const cap = Math.max(0, maxThreadReads);
  if (cap === 0) {
    return [];
  }

  const exclude = options.excludePostIds ?? new Set<string>();
  const ranked = dedupeSearchResults(results)
    .filter((item) => !exclude.has(item.id))
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0));

  if (ranked.length <= cap) {
    return ranked;
  }

  const strategy = options.strategy ?? "stochastic";
  if (strategy === "top_score") {
    return ranked.slice(0, cap);
  }

  const random = options.random ?? Math.random;
  const poolSize = Math.min(ranked.length, Math.max(cap * 4, 12));
  return weightedSampleWithoutReplacement(ranked.slice(0, poolSize), cap, random);
}

export interface DiscoveryIngestionOptions {
  random: () => number;
  excludePostIds: ReadonlySet<string>;
  pickStrategy: DiscoveryPickStrategy;
  diagnostics: RedditIngestionDiagnostics;
  scanLedgerMap: ReadonlyMap<string, RedditScanLedgerEntry>;
  scanLedgerTtlHours: number;
  now: Date;
}

export function shouldSkipDiscoveryThreadScrape(
  result: RedditSearchResult,
  discovery: DiscoveryIngestionOptions
): boolean {
  const entry = getScanLedgerEntry(discovery.scanLedgerMap, result.subreddit, result.id);
  return shouldSkipColdDiscoveryRead(entry, discovery.now, discovery.scanLedgerTtlHours, result.commentCount);
}

export function resolveIngestionBackend(
  source: RedditIngestionInput["source"] | undefined,
  config: MoltbookRuntimeConfig,
  operating: ReturnType<typeof getRedditOperatingAgentConfig>
): "browser" | "api" | "reddapi" | "unofficial" {
  if (source && source !== "auto") {
    return source;
  }
  const readController = operating.readController;
  if (readController === "auto") {
    const publishController = getRedditControllerConfig(config).controller;
    if (publishController === "reddapi") {
      return "reddapi";
    }
    if (publishController === "unofficial") {
      return "unofficial";
    }
    if (publishController === "browser") {
      return "browser";
    }
    return "api";
  }
  return readController;
}
