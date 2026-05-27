import {
  getOutreachAgentConfig,
  getRedditControllerConfig,
  getRedditOperatingAgentConfig,
  type MoltbookRuntimeConfig
} from "./config.js";
import {
  RedditBrowserController,
  type RedditControllerContext,
  type RedditConversationSnapshot,
  type RedditSearchResult,
  type RedditThreadState
} from "./reddit-controller.js";
import {
  getDefaultRedditDiscoverySubredditNames,
  RedditReadOnlyClient,
  redditMemoryEntryConsumesTarget,
  redditMemoryEntryCountsTowardPublishedLimits,
  type RedditOutboundMemoryEntry,
  type RedditSourceItem
} from "./reddit-outreach.js";

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

const MIN_COMMENT_BODY_DISCOVERY = 40;
const MIN_COMMENT_BODY_OWN_THREAD = 12;

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
  queries?: readonly string[];
  history?: readonly RedditOutboundMemoryEntry[];
  limitPerSubreddit?: number;
  maxThreadReads?: number;
  maxOwnThreadReads?: number;
  maxDiscoveryThreadReads?: number;
  maxSearchesPerSubreddit?: number;
  threadCommentLimit?: number;
  ownThreadCommentLimit?: number;
  source?: "browser" | "api" | "auto";
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
  subreddits: string[];
  discoverySearchQueries: string[];
  discoveryListingSorts: RedditIngestionListingSortRecord[];
  excludedThreadPostIds: string[];
  discoveryPickStrategy: DiscoveryPickStrategy;
  browserHeadless: boolean;
  readViaBrowser: boolean;
}

export interface RedditIngestionResult {
  capturedAt: string;
  snapshots: RedditConversationSnapshot[];
  sourceItems: RedditSourceItem[];
  skipped: string[];
  ownThreadTargets: number;
  ownThreadSnapshots: number;
  discoveryThreadSnapshots: number;
  diagnostics: RedditIngestionDiagnostics;
}

export async function ingestRedditState(input: RedditIngestionInput): Promise<RedditIngestionResult> {
  const capturedAt = new Date().toISOString();
  const subreddits = input.subreddits?.length
    ? [...input.subreddits]
    : defaultSubreddits(input.config);
  const operating = getRedditOperatingAgentConfig(input.config);
  const queries = input.queries ?? operating.searchQueries;
  const source = input.source ?? "auto";
  const history = input.history ?? [];
  const limits = resolveIngestionLimits(input, operating);
  const skipped: string[] = [];
  const ownThreadTargets = collectOwnThreadTargets(history);

  const discoveryRng = createDiscoveryRng(input.discoverySeed);
  const discoveryExcludePostIds = collectDiscoveryExcludePostIds(history);
  const discoveryPickStrategy = input.discoveryPickStrategy ?? "stochastic";
  const diagnostics: RedditIngestionDiagnostics = {
    subreddits: [...subreddits],
    discoverySearchQueries: [],
    discoveryListingSorts: [],
    excludedThreadPostIds: [...discoveryExcludePostIds],
    discoveryPickStrategy,
    browserHeadless: isRedditBrowserHeadless(),
    readViaBrowser: false
  };

  const usedBrowser =
    source === "browser" ||
    (source === "auto" && getRedditControllerConfig(input.config).controller === "browser");
  diagnostics.readViaBrowser = usedBrowser;
  const discoveryOptions: DiscoveryIngestionOptions = {
    random: discoveryRng,
    excludePostIds: discoveryExcludePostIds,
    pickStrategy: discoveryPickStrategy,
    diagnostics
  };
  const snapshots = usedBrowser
      ? await ingestViaBrowser(
          input.config,
          subreddits,
          queries,
          limits,
          ownThreadTargets,
          skipped,
          discoveryOptions
        )
      : await ingestViaApi(
          input.config,
          subreddits,
          queries,
          limits,
          ownThreadTargets,
          skipped,
          discoveryOptions
        );

  const deduped = dedupeSnapshots(snapshots);
  const agent = getOutreachAgentConfig(input.config);
  const discoveryThreadSnapshots = deduped.filter((snapshot) => !snapshot.ownThread).length;
  appendHeadlessDiscoveryWarning(skipped, {
    usedBrowser,
    headless: isRedditBrowserHeadless(),
    maxDiscoveryThreadReads: limits.maxDiscoveryThreadReads,
    subredditCount: subreddits.length,
    discoveryThreadSnapshots
  });
  return {
    capturedAt,
    snapshots: deduped,
    sourceItems: snapshotsToSourceItems(deduped, history, { venueAccountId: agent.venueAccountId }),
    skipped,
    ownThreadTargets: ownThreadTargets.length,
    ownThreadSnapshots: deduped.filter((snapshot) => snapshot.ownThread).length,
    discoveryThreadSnapshots,
    diagnostics
  };
}

function defaultSubreddits(config: MoltbookRuntimeConfig): string[] {
  const agent = getOutreachAgentConfig(config);
  if (agent.allowedSurfaces.length > 0) {
    return agent.allowedSurfaces;
  }
  const operating = getRedditOperatingAgentConfig(config);
  return operating.targetSubreddits.length > 0
    ? operating.targetSubreddits
    : getDefaultRedditDiscoverySubredditNames();
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

interface RedditIngestionLimits {
  listLimit: number;
  maxOwnThreadReads: number;
  maxDiscoveryThreadReads: number;
  maxSearchesPerSubreddit: number;
  ownThreadCommentLimit: number;
  discoveryCommentLimit: number;
}

function resolveIngestionLimits(
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
  if (entry.status === "posted") {
    return true;
  }
  if (entry.status === "drafted" && (entry.kind === "comment" || entry.kind === "reply")) {
    return true;
  }
  return redditMemoryEntryCountsTowardPublishedLimits(entry);
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

interface DiscoveryIngestionOptions {
  random: () => number;
  excludePostIds: ReadonlySet<string>;
  pickStrategy: DiscoveryPickStrategy;
  diagnostics: RedditIngestionDiagnostics;
}

async function ingestViaBrowser(
  config: MoltbookRuntimeConfig,
  subreddits: readonly string[],
  queries: readonly string[],
  limits: RedditIngestionLimits,
  ownThreadTargets: readonly RedditOwnThreadTarget[],
  skipped: string[],
  discovery: DiscoveryIngestionOptions
): Promise<RedditConversationSnapshot[]> {
  const agent = getOutreachAgentConfig(config);
  const controller = new RedditBrowserController(config);
  const context = {
    mode: agent.mode,
    allowedSurfaces: agent.allowedSurfaces,
    venueAccountId: agent.venueAccountId
  };
  const snapshots: RedditConversationSnapshot[] = [];
  const readPostIds = new Set<string>();

  for (const target of ownThreadTargets.slice(0, limits.maxOwnThreadReads)) {
    const key = `${target.subreddit}:${target.postId}`;
    if (readPostIds.has(key)) {
      continue;
    }
    readPostIds.add(key);
    const snapshot = await readThreadSnapshot(controller, context, {
      postId: target.postId,
      subreddit: target.subreddit,
      url: target.url,
      permalink: target.permalink,
      commentLimit: limits.ownThreadCommentLimit,
      ownThread: true,
      skipped
    });
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }

  if (limits.maxDiscoveryThreadReads <= 0) {
    return snapshots;
  }

  const results: RedditSearchResult[] = [];
  const searchQueries =
    limits.maxSearchesPerSubreddit > 0
      ? selectDiscoverySearchQueries(queries, limits.maxSearchesPerSubreddit, discovery.random)
      : [];
  discovery.diagnostics.discoverySearchQueries = [...searchQueries];

  for (const subreddit of shuffleWithRng(subreddits, discovery.random)) {
    const listingSort = selectDiscoveryListingSort(discovery.random);
    discovery.diagnostics.discoveryListingSorts.push({ subreddit, sort: listingSort });
    try {
      const listed = await controller.readAction({
        id: `list:${subreddit}:${listingSort}`,
        type: "list_subreddit_posts",
        subreddit,
        sort: listingSort,
        limit: limits.listLimit
      }, context);
      if (listed.type === "list_subreddit_posts") {
        results.push(...listed.items);
      }
    } catch (error) {
      skipped.push(`browser list r/${subreddit} ${listingSort}: ${formatError(error)}`);
    }

    for (const query of searchQueries) {
      try {
        const searched = await controller.readAction({
          id: `search:${subreddit}:${query}`,
          type: "search_subreddit",
          subreddit,
          query,
          sort: "new",
          time: "month",
          limit: Math.min(3, limits.listLimit)
        }, context);
        if (searched.type === "search_subreddit") {
          results.push(...searched.items);
        }
      } catch (error) {
        skipped.push(`browser search r/${subreddit} "${query}": ${formatError(error)}`);
      }
    }
  }

  for (const result of pickThreadReadCandidates(results, limits.maxDiscoveryThreadReads, {
    excludePostIds: discovery.excludePostIds,
    strategy: discovery.pickStrategy,
    random: discovery.random
  })) {
    const key = `${result.subreddit}:${result.id}`;
    if (readPostIds.has(key)) {
      continue;
    }
    readPostIds.add(key);
    const snapshot = await readThreadSnapshot(controller, context, {
      postId: result.id,
      subreddit: result.subreddit,
      url: result.url,
      permalink: result.permalink,
      commentLimit: limits.discoveryCommentLimit,
      ownThread: false,
      skipped
    });
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }

  return snapshots;
}

async function readThreadSnapshot(
  controller: RedditBrowserController,
  context: RedditControllerContext,
  input: {
    postId: string;
    subreddit: string;
    url?: string;
    permalink?: string;
    commentLimit: number;
    ownThread: boolean;
    skipped: string[];
  }
): Promise<RedditConversationSnapshot | undefined> {
  try {
    const read = await controller.readAction({
      id: `thread:${input.postId}`,
      type: "read_thread",
      url: input.url ?? input.permalink,
      postId: input.postId,
      subreddit: input.subreddit,
      limit: input.commentLimit
    }, context);
    if (read.type !== "read_thread") {
      return undefined;
    }
    return {
      thread: read.thread,
      source: "browser",
      capturedAt: new Date().toISOString(),
      ownThread: input.ownThread
    };
  } catch (error) {
    input.skipped.push(`browser read ${input.postId}: ${formatError(error)}`);
    return undefined;
  }
}

async function ingestViaApi(
  config: MoltbookRuntimeConfig,
  subreddits: readonly string[],
  queries: readonly string[],
  limits: RedditIngestionLimits,
  ownThreadTargets: readonly RedditOwnThreadTarget[],
  skipped: string[],
  discovery: DiscoveryIngestionOptions
): Promise<RedditConversationSnapshot[]> {
  const api = getRedditControllerConfig(config).api;
  if (!api.accessToken || !api.userAgent) {
    skipped.push("api ingestion skipped: REDDIT_ACCESS_TOKEN and REDDIT_USER_AGENT are required.");
    return [];
  }
  const client = new RedditReadOnlyClient({
    accessToken: api.accessToken,
    userAgent: api.userAgent,
    baseUrl: api.baseUrl
  });
  const snapshots: RedditConversationSnapshot[] = [];

  for (const target of ownThreadTargets.slice(0, limits.maxOwnThreadReads)) {
    try {
      const thread = await client.getThreadState(
        target.subreddit,
        target.postId,
        limits.ownThreadCommentLimit
      );
      if (thread) {
        snapshots.push({
          thread,
          source: "api",
          capturedAt: new Date().toISOString(),
          ownThread: true
        });
      }
    } catch (error) {
      skipped.push(`api own thread ${target.postId}: ${formatError(error)}`);
    }
  }

  if (limits.maxDiscoveryThreadReads <= 0) {
    return snapshots;
  }

  const items: RedditSourceItem[] = [];
  const searchQueries =
    limits.maxSearchesPerSubreddit > 0
      ? selectDiscoverySearchQueries(queries, limits.maxSearchesPerSubreddit, discovery.random)
      : [];
  discovery.diagnostics.discoverySearchQueries = [...searchQueries];

  for (const subreddit of shuffleWithRng(subreddits, discovery.random)) {
    discovery.diagnostics.discoveryListingSorts.push({ subreddit, sort: "hot" });
    try {
      items.push(...await client.getHotPosts(subreddit, limits.listLimit));
    } catch (error) {
      skipped.push(`api hot r/${subreddit}: ${formatError(error)}`);
    }
    for (const query of searchQueries) {
      try {
        items.push(...await client.searchSubreddit(subreddit, query, Math.min(3, limits.listLimit)));
      } catch (error) {
        skipped.push(`api search r/${subreddit} "${query}": ${formatError(error)}`);
      }
    }
  }

  const postItems = dedupeSourceItems(items).filter((item) => item.kind === "post");
  const picked = pickThreadReadCandidates(
    postItems.map((item) => ({
      id: item.id,
      subreddit: item.subreddit,
      title: item.title,
      score: item.score,
      url: item.url,
      permalink: item.permalink
    })),
    limits.maxDiscoveryThreadReads,
    {
      excludePostIds: discovery.excludePostIds,
      strategy: discovery.pickStrategy,
      random: discovery.random
    }
  );
  const pickedKeys = new Set(picked.map((result) => `${result.subreddit}:${result.id}`));
  const rankedPosts = postItems.filter((item) => pickedKeys.has(`${item.subreddit}:${item.id}`));

  for (const item of rankedPosts) {
    if (ownThreadTargets.some((target) => target.postId === item.id)) {
      continue;
    }
    snapshots.push({
      thread: sourceItemToThreadState(item),
      source: "api",
      capturedAt: new Date().toISOString(),
      ownThread: false
    });
  }

  return snapshots;
}

export function snapshotsToSourceItems(
  snapshots: readonly RedditConversationSnapshot[],
  history: readonly RedditOutboundMemoryEntry[] = [],
  options: { venueAccountId?: string } = {}
): RedditSourceItem[] {
  const alreadyTouched = new Set(
    history
      .filter((entry) => redditMemoryEntryConsumesTarget(entry))
      .map((entry) => entry.targetId)
      .filter(Boolean)
  );
  const ownThreadPostIds = new Set(
    collectOwnThreadTargets(history).map((target) => target.postId)
  );
  const ownAuthors = new Set(
    [options.venueAccountId]
      .filter(Boolean)
      .map((name) => name!.toLowerCase())
  );

  const items: RedditSourceItem[] = [];
  for (const snapshot of snapshots) {
    const thread = snapshot.thread;
    const onOwnThread = snapshot.ownThread === true || ownThreadPostIds.has(thread.id);
    const minCommentBody = onOwnThread ? MIN_COMMENT_BODY_OWN_THREAD : MIN_COMMENT_BODY_DISCOVERY;
    const commentById = indexCommentsById(thread.comments);

    for (const comment of flattenComments(thread.comments)) {
      if (alreadyTouched.has(comment.id)) {
        continue;
      }
      if (isOwnAuthoredComment(comment.author, ownAuthors)) {
        continue;
      }
      if (comment.body.length < minCommentBody) {
        continue;
      }
      items.push({
        id: comment.id,
        kind: "comment",
        subreddit: thread.subreddit,
        title: thread.title,
        parentTitle: thread.title,
        body: comment.body,
        author: comment.author,
        permalink: comment.permalink,
        createdUtc: comment.createdUtc,
        score: comment.score,
        commentCount: thread.commentCount,
        onOwnThread,
        threadPostId: thread.id,
        parentId: normalizeRedditParentId(comment.parentId),
        replyToOurComment: isDirectReplyToOurComment(comment, commentById, ownAuthors)
      });
    }

    if (!alreadyTouched.has(thread.id)) {
      items.push({
        id: thread.id,
        kind: "post",
        subreddit: thread.subreddit,
        title: thread.title,
        body: thread.body,
        author: thread.author,
        permalink: thread.permalink,
        url: thread.url,
        createdUtc: thread.createdUtc,
        score: thread.score,
        commentCount: thread.commentCount,
        onOwnThread,
        threadPostId: thread.id
      });
    }
  }
  return dedupeSourceItems(items);
}

function isOwnAuthoredComment(author: string | undefined, ownAuthors: ReadonlySet<string>): boolean {
  if (!author || ownAuthors.size === 0) {
    return false;
  }
  const normalized = author.replace(/^u\//i, "").toLowerCase();
  return ownAuthors.has(normalized);
}

function indexCommentsById(
  comments: readonly RedditThreadState["comments"][number][]
): Map<string, RedditThreadState["comments"][number]> {
  const byId = new Map<string, RedditThreadState["comments"][number]>();
  for (const comment of flattenComments(comments)) {
    byId.set(comment.id, comment);
    const normalizedId = normalizeRedditParentId(comment.id);
    if (normalizedId && normalizedId !== comment.id) {
      byId.set(normalizedId, comment);
    }
  }
  return byId;
}

function normalizeRedditParentId(parentId: string | undefined): string | undefined {
  if (!parentId) {
    return undefined;
  }
  return parentId.replace(/^t[0-9]_/, "");
}

function isDirectReplyToOurComment(
  comment: RedditThreadState["comments"][number],
  commentById: ReadonlyMap<string, RedditThreadState["comments"][number]>,
  ownAuthors: ReadonlySet<string>
): boolean {
  const parentKey = normalizeRedditParentId(comment.parentId);
  if (!parentKey) {
    return false;
  }
  const parent = commentById.get(parentKey);
  return parent ? isOwnAuthoredComment(parent.author, ownAuthors) : false;
}

function flattenComments(comments: readonly RedditThreadState["comments"][number][]): RedditThreadState["comments"] {
  const flattened: RedditThreadState["comments"] = [];
  for (const comment of comments) {
    flattened.push(comment);
    if (comment.replies?.length) {
      flattened.push(...flattenComments(comment.replies));
    }
  }
  return flattened;
}

function sourceItemToThreadState(item: RedditSourceItem): RedditThreadState {
  return {
    id: item.id,
    subreddit: item.subreddit,
    title: item.title,
    body: item.body,
    author: item.author,
    permalink: item.permalink,
    url: item.url,
    score: item.score,
    commentCount: item.commentCount,
    createdUtc: item.createdUtc,
    comments: []
  };
}

function dedupeSearchResults(items: readonly RedditSearchResult[]): RedditSearchResult[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.permalink ?? item.url ?? item.id;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeSourceItems(items: readonly RedditSourceItem[]): RedditSourceItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.subreddit}:${item.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeSnapshots(snapshots: readonly RedditConversationSnapshot[]): RedditConversationSnapshot[] {
  const seen = new Set<string>();
  return snapshots.filter((snapshot) => {
    const key = snapshot.thread.permalink ?? snapshot.thread.url ?? snapshot.thread.id;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function weightedSampleWithoutReplacement<T extends { score?: number }>(
  pool: readonly T[],
  count: number,
  random: () => number
): T[] {
  const remaining = [...pool];
  const picked: T[] = [];
  while (picked.length < count && remaining.length > 0) {
    const weights = remaining.map((item) => Math.max(1, item.score ?? 1));
    const totalWeight = weights.reduce((left, right) => left + right, 0);
    let roll = random() * totalWeight;
    let chosenIndex = remaining.length - 1;
    for (let index = 0; index < remaining.length; index += 1) {
      roll -= weights[index]!;
      if (roll <= 0) {
        chosenIndex = index;
        break;
      }
    }
    picked.push(remaining.splice(chosenIndex, 1)[0]!);
  }
  return picked;
}
