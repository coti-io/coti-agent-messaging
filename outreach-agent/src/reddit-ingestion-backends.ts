import {
  getOutreachAgentConfig,
  getRedditControllerConfig,
  getRedditOperatingAgentConfig,
  type MoltbookRuntimeConfig
} from "./config.js";
import { buildPublicRedditThreadUrl, RedditReddapiClient } from "./reddit-reddapi.js";
import { buildUnofficialRedditThreadUrl, RedditUnofficialClient } from "./reddit-unofficial.js";
import {
  RedditBrowserController,
  type RedditControllerContext,
  type RedditConversationSnapshot,
  type RedditSearchResult,
  type RedditThreadState
} from "./reddit-controller.js";
import { RedditReadOnlyClient, type RedditSourceItem } from "./reddit-outreach.js";
import {
  dedupeSearchResults,
  dedupeSourceItems,
  formatError
} from "./reddit-ingestion-utils.js";
import {
  pickListingPageIndex,
  pickThreadReadCandidates,
  selectDiscoveryListingSort,
  selectDiscoverySearchQueries,
  shouldSkipDiscoveryThreadScrape,
  shuffleWithRng,
  type DiscoveryIngestionOptions,
  type RedditIngestionLimits
} from "./reddit-ingestion-discovery.js";
import type { RedditOwnThreadTarget } from "./reddit-ingestion-types.js";
import { sourceItemToThreadState } from "./reddit-ingestion-snapshots.js";

export async function ingestViaReddapi(
  config: MoltbookRuntimeConfig,
  subreddits: readonly string[],
  queries: readonly string[],
  limits: RedditIngestionLimits,
  ownThreadTargets: readonly RedditOwnThreadTarget[],
  skipped: string[],
  discovery: DiscoveryIngestionOptions
): Promise<RedditConversationSnapshot[]> {
  const redditConfig = getRedditControllerConfig(config).reddapi;
  if (!redditConfig.rapidApiKey || !redditConfig.proxy) {
    skipped.push("reddapi ingestion skipped: RAPIDAPI_REDDAPI_KEY and REDDAPI_PROXY are required.");
    return [];
  }

  const client = new RedditReddapiClient({
    rapidApiKey: redditConfig.rapidApiKey,
    proxy: redditConfig.proxy,
    storageStatePath: redditConfig.storageStatePath,
    rapidApiHost: redditConfig.rapidApiHost,
    bearerOverride: redditConfig.bearerOverride
  });
  const snapshots: RedditConversationSnapshot[] = [];
  const capturedAt = new Date().toISOString();
  const readPostIds = new Set<string>();

  for (const target of ownThreadTargets.slice(0, limits.maxOwnThreadReads)) {
    const key = `${target.subreddit}:${target.postId}`;
    if (readPostIds.has(key)) {
      continue;
    }
    readPostIds.add(key);
    const postUrl =
      target.url ??
      (target.permalink?.startsWith("http")
        ? target.permalink
        : target.permalink
          ? new URL(target.permalink, "https://www.reddit.com").toString()
          : buildPublicRedditThreadUrl(target.subreddit, target.postId));
    try {
      const thread = await client.scrapeThread(postUrl);
      snapshots.push({
        thread,
        source: "reddapi",
        capturedAt,
        ownThread: true
      });
    } catch (error) {
      skipped.push(`reddapi own thread ${target.postId}: ${formatError(error)}`);
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
    for (const query of searchQueries) {
      try {
        results.push(
          ...(await client.searchPosts(query, {
            subreddit,
            limit: Math.max(limits.listLimit, 10)
          }))
        );
      } catch (error) {
        skipped.push(`reddapi search r/${subreddit} "${query}": ${formatError(error)}`);
      }
    }
  }

  for (const result of pickThreadReadCandidates(dedupeSearchResults(results), limits.maxDiscoveryThreadReads, {
    excludePostIds: discovery.excludePostIds,
    strategy: discovery.pickStrategy,
    random: discovery.random
  })) {
    const key = `${result.subreddit}:${result.id}`;
    if (readPostIds.has(key)) {
      continue;
    }
    if (shouldSkipDiscoveryThreadScrape(result, discovery)) {
      discovery.diagnostics.scanLedgerSkippedScrapes += 1;
      skipped.push(`scan ledger skip discovery ${result.id}`);
      continue;
    }
    readPostIds.add(key);
    const postUrl =
      result.url ??
      (result.permalink?.startsWith("http")
        ? result.permalink
        : result.permalink
          ? new URL(result.permalink, "https://www.reddit.com").toString()
          : buildPublicRedditThreadUrl(result.subreddit, result.id));
    try {
      const thread = await client.scrapeThread(postUrl);
      snapshots.push({
        thread,
        source: "reddapi",
        capturedAt,
        ownThread: false
      });
    } catch (error) {
      skipped.push(`reddapi read ${result.id}: ${formatError(error)}`);
    }
  }

  return snapshots;
}

export async function ingestViaUnofficial(
  config: MoltbookRuntimeConfig,
  subreddits: readonly string[],
  queries: readonly string[],
  limits: RedditIngestionLimits,
  ownThreadTargets: readonly RedditOwnThreadTarget[],
  skipped: string[],
  discovery: DiscoveryIngestionOptions
): Promise<RedditConversationSnapshot[]> {
  const redditConfig = getRedditControllerConfig(config).unofficial;
  if (!redditConfig) {
    skipped.push("unofficial ingestion skipped: unofficial Reddit config is missing.");
    return [];
  }
  const client = new RedditUnofficialClient({
    proxy: redditConfig.proxy,
    storageStatePath: redditConfig.storageStatePath,
    bearerOverride: redditConfig.bearerOverride,
    publicBaseUrl: redditConfig.publicBaseUrl,
    oauthBaseUrl: redditConfig.oauthBaseUrl,
    userAgent: redditConfig.userAgent
  });
  const snapshots: RedditConversationSnapshot[] = [];
  const capturedAt = new Date().toISOString();
  const readPostIds = new Set<string>();

  for (const target of ownThreadTargets.slice(0, limits.maxOwnThreadReads)) {
    const key = `${target.subreddit}:${target.postId}`;
    if (readPostIds.has(key)) {
      continue;
    }
    readPostIds.add(key);
    const postUrl =
      target.url ??
      (target.permalink?.startsWith("http")
        ? target.permalink
        : target.permalink
          ? new URL(target.permalink, "https://www.reddit.com").toString()
          : buildUnofficialRedditThreadUrl(target.subreddit, target.postId, redditConfig.publicBaseUrl));
    try {
      const thread = await client.scrapeThread(postUrl, limits.ownThreadCommentLimit);
      snapshots.push({
        thread,
        source: "unofficial",
        capturedAt,
        ownThread: true
      });
    } catch (error) {
      skipped.push(`unofficial own thread ${target.postId}: ${formatError(error)}`);
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
    const listingPage = pickListingPageIndex(discovery.random);
    discovery.diagnostics.discoveryListingSorts.push({ subreddit, sort: listingSort });
    discovery.diagnostics.discoveryListingPages.push(listingPage);
    try {
      results.push(
        ...(await client.listSubredditPosts(subreddit, {
          sort: listingSort,
          limit: limits.listLimit,
          pageIndex: listingPage
        }))
      );
    } catch (error) {
      skipped.push(`unofficial list r/${subreddit} ${listingSort}: ${formatError(error)}`);
    }

    for (const query of searchQueries) {
      const searchPage = pickListingPageIndex(discovery.random);
      discovery.diagnostics.discoverySearchPages.push(searchPage);
      try {
        results.push(
          ...(await client.searchPosts(query, {
            subreddit,
            limit: limits.listLimit,
            pageIndex: searchPage
          }))
        );
      } catch (error) {
        skipped.push(`unofficial search r/${subreddit} "${query}": ${formatError(error)}`);
      }
    }
  }

  for (const result of pickThreadReadCandidates(dedupeSearchResults(results), limits.maxDiscoveryThreadReads, {
    excludePostIds: discovery.excludePostIds,
    strategy: discovery.pickStrategy,
    random: discovery.random
  })) {
    const key = `${result.subreddit}:${result.id}`;
    if (readPostIds.has(key)) {
      continue;
    }
    if (shouldSkipDiscoveryThreadScrape(result, discovery)) {
      discovery.diagnostics.scanLedgerSkippedScrapes += 1;
      skipped.push(`scan ledger skip discovery ${result.id}`);
      continue;
    }
    readPostIds.add(key);
    const postUrl =
      result.url ??
      (result.permalink?.startsWith("http")
        ? result.permalink
        : result.permalink
          ? new URL(result.permalink, "https://www.reddit.com").toString()
          : buildUnofficialRedditThreadUrl(result.subreddit, result.id, redditConfig.publicBaseUrl));
    try {
      const thread = await client.scrapeThread(postUrl, limits.discoveryCommentLimit);
      snapshots.push({
        thread,
        source: "unofficial",
        capturedAt,
        ownThread: false
      });
    } catch (error) {
      skipped.push(`unofficial read ${result.id}: ${formatError(error)}`);
    }
  }

  return snapshots;
}

export async function ingestViaBrowser(
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
          limit: limits.listLimit
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
    if (shouldSkipDiscoveryThreadScrape(result, discovery)) {
      discovery.diagnostics.scanLedgerSkippedScrapes += 1;
      skipped.push(`scan ledger skip discovery ${result.id}`);
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

export async function ingestViaApi(
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
        items.push(...await client.searchSubreddit(subreddit, query, limits.listLimit));
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
    const candidate: RedditSearchResult = {
      id: item.id,
      subreddit: item.subreddit,
      title: item.title ?? "",
      commentCount: item.commentCount
    };
    if (shouldSkipDiscoveryThreadScrape(candidate, discovery)) {
      discovery.diagnostics.scanLedgerSkippedScrapes += 1;
      skipped.push(`scan ledger skip discovery ${item.id}`);
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
