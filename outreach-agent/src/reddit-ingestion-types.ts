import type { MoltbookRuntimeConfig } from "./config.js";
import type { RedditConversationSnapshot } from "./reddit-controller.js";
import type { RedditScanLedgerEntry } from "./reddit-scan-ledger.js";
import type { RedditOutboundMemoryEntry, RedditSourceItem } from "./reddit-outreach-types.js";
import { getDefaultRedditDiscoverySubredditNames } from "./reddit-targeting.js";

export const MIN_COMMENT_BODY_DISCOVERY = 40;
export const MIN_COMMENT_BODY_OWN_THREAD = 12;

/** @deprecated Use getDefaultRedditDiscoverySubredditNames() */
export const DEFAULT_REDDIT_OPERATING_SUBREDDITS = getDefaultRedditDiscoverySubredditNames();

/** Default subreddit searches when OUTREACH_REDDIT_SEARCH_QUERIES is unset. */
export const DEFAULT_REDDIT_OPERATING_SEARCH_QUERIES = [
  "AI agent messaging",
  "MCP agent communication",
  "private agent channel",
  "agent coordination encrypted",
  "agent to agent messaging",
  "LLM agent inbox"
] as const;

/** @deprecated Use DEFAULT_REDDIT_OPERATING_SEARCH_QUERIES */
export const DEFAULT_REDDIT_OPERATING_QUERIES = DEFAULT_REDDIT_OPERATING_SEARCH_QUERIES;

/** Hot posts listed per subreddit when discovery is enabled. */
export const DEFAULT_REDDIT_INGESTION_LIST_LIMIT = 5;
/** Threads to fully re-read where we already participated (priority). */
export const DEFAULT_REDDIT_INGESTION_MAX_OWN_THREAD_READS = 25;
/** Cold threads from hot feeds per session (0 turns discovery off). */
export const DEFAULT_REDDIT_INGESTION_MAX_DISCOVERY_THREAD_READS = 4;
/** Subreddit searches per session; 0 keeps browsing to hot listings only. */
export const DEFAULT_REDDIT_INGESTION_MAX_SEARCHES_PER_SUBREDDIT = 1;
export const DEFAULT_REDDIT_INGESTION_OWN_THREAD_COMMENT_LIMIT = 100;
export const DEFAULT_REDDIT_INGESTION_DISCOVERY_COMMENT_LIMIT = 25;

export interface RedditOwnThreadTarget {
  postId: string;
  subreddit: string;
  url?: string;
  permalink?: string;
  lastTouchedAt: string;
}

export type DiscoveryListingSort = "hot" | "new" | "rising";
export type DiscoveryPickStrategy = "stochastic" | "top_score";

export interface RedditIngestionInput {
  config: MoltbookRuntimeConfig;
  subreddits?: readonly string[];
  /** When unset, samples discoverySubsPerRun from the operating pool. */
  subredditPool?: readonly string[];
  discoverySubsPerRun?: number;
  scanLedger?: readonly RedditScanLedgerEntry[];
  scanLedgerTtlHours?: number;
  scanLedgerMaxEntries?: number;
  queries?: readonly string[];
  history?: readonly RedditOutboundMemoryEntry[];
  limitPerSubreddit?: number;
  maxThreadReads?: number;
  maxOwnThreadReads?: number;
  maxDiscoveryThreadReads?: number;
  maxSearchesPerSubreddit?: number;
  threadCommentLimit?: number;
  ownThreadCommentLimit?: number;
  source?: "browser" | "api" | "reddapi" | "unofficial" | "auto";
  /** Optional seed for deterministic tests; omit for per-run randomness. */
  discoverySeed?: number;
  discoveryPickStrategy?: DiscoveryPickStrategy;
}

export interface PickThreadReadCandidatesOptions {
  excludePostIds?: ReadonlySet<string>;
  strategy?: DiscoveryPickStrategy;
  random?: () => number;
}

export interface RedditIngestionListingSortRecord {
  subreddit: string;
  sort: DiscoveryListingSort;
}

export interface RedditIngestionDiagnostics {
  discoverySubredditPool: string[];
  sampledSubreddits: string[];
  subreddits: string[];
  discoverySearchQueries: string[];
  discoveryListingSorts: RedditIngestionListingSortRecord[];
  discoveryListingPages: number[];
  discoverySearchPages: number[];
  excludedThreadPostIds: string[];
  scanLedgerSkippedScrapes: number;
  discoveryPickStrategy: DiscoveryPickStrategy;
  browserHeadless: boolean;
  readViaBrowser: boolean;
  readViaReddapi: boolean;
  readViaUnofficial?: boolean;
}

export interface RedditIngestionResult {
  capturedAt: string;
  snapshots: RedditConversationSnapshot[];
  sourceItems: RedditSourceItem[];
  skipped: string[];
  ownThreadTargets: number;
  ownThreadSnapshots: number;
  discoveryThreadSnapshots: number;
  sampledSubreddits: string[];
  scanLedger: RedditScanLedgerEntry[];
  diagnostics: RedditIngestionDiagnostics;
}
