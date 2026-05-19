import { getOutreachAgentConfig, getRedditControllerConfig, type MoltbookRuntimeConfig } from "./config.js";
import {
  RedditBrowserController,
  type RedditConversationSnapshot,
  type RedditSearchResult,
  type RedditThreadState
} from "./reddit-controller.js";
import {
  RedditReadOnlyClient,
  type RedditOutboundMemoryEntry,
  type RedditSourceItem
} from "./reddit-outreach.js";

export const DEFAULT_REDDIT_OPERATING_SUBREDDITS = [
  "sales",
  "SaaS",
  "CustomerSuccess",
  "DigitalMarketing"
] as const;

export const DEFAULT_REDDIT_OPERATING_QUERIES = [
  "CRM messy data",
  "sales handoff broken",
  "manual workflow",
  "customer success workflow",
  "automation failed",
  "duplicate CRM records",
  "SaaS ops process",
  "marketing ops data quality"
] as const;

export interface RedditIngestionInput {
  config: MoltbookRuntimeConfig;
  subreddits?: readonly string[];
  queries?: readonly string[];
  history?: readonly RedditOutboundMemoryEntry[];
  limitPerSubreddit?: number;
  source?: "browser" | "api" | "auto";
}

export interface RedditIngestionResult {
  capturedAt: string;
  snapshots: RedditConversationSnapshot[];
  sourceItems: RedditSourceItem[];
  skipped: string[];
}

export async function ingestRedditState(input: RedditIngestionInput): Promise<RedditIngestionResult> {
  const capturedAt = new Date().toISOString();
  const subreddits = input.subreddits?.length
    ? [...input.subreddits]
    : defaultSubreddits(input.config);
  const queries = input.queries?.length ? [...input.queries] : [...DEFAULT_REDDIT_OPERATING_QUERIES];
  const source = input.source ?? "auto";
  const limit = input.limitPerSubreddit ?? 8;
  const skipped: string[] = [];

  const snapshots =
    source === "browser" || (source === "auto" && getRedditControllerConfig(input.config).controller === "browser")
      ? await ingestViaBrowser(input.config, subreddits, queries, limit, skipped)
      : await ingestViaApi(input.config, subreddits, queries, limit, skipped);

  const deduped = dedupeSnapshots(snapshots);
  return {
    capturedAt,
    snapshots: deduped,
    sourceItems: snapshotsToSourceItems(deduped, input.history ?? []),
    skipped
  };
}

function defaultSubreddits(config: MoltbookRuntimeConfig): string[] {
  const agent = getOutreachAgentConfig(config);
  return agent.allowedSurfaces.length > 0
    ? agent.allowedSurfaces
    : [...DEFAULT_REDDIT_OPERATING_SUBREDDITS];
}

async function ingestViaBrowser(
  config: MoltbookRuntimeConfig,
  subreddits: readonly string[],
  queries: readonly string[],
  limit: number,
  skipped: string[]
): Promise<RedditConversationSnapshot[]> {
  const agent = getOutreachAgentConfig(config);
  const controller = new RedditBrowserController(config);
  const context = {
    mode: agent.mode,
    allowedSurfaces: agent.allowedSurfaces,
    venueAccountId: agent.venueAccountId
  };
  const results: RedditSearchResult[] = [];

  for (const subreddit of subreddits) {
    try {
      const hotListed = await controller.readAction({
        id: `list:${subreddit}:hot`,
        type: "list_subreddit_posts",
        subreddit,
        sort: "hot",
        limit
      }, context);
      if (hotListed.type === "list_subreddit_posts") {
        results.push(...hotListed.items);
      }
    } catch (error) {
      skipped.push(`browser list r/${subreddit} hot: ${formatError(error)}`);
    }

    try {
      const listed = await controller.readAction({
        id: `list:${subreddit}:new`,
        type: "list_subreddit_posts",
        subreddit,
        sort: "new",
        limit
      }, context);
      if (listed.type === "list_subreddit_posts") {
        results.push(...listed.items);
      }
    } catch (error) {
      skipped.push(`browser list r/${subreddit}: ${formatError(error)}`);
    }

    for (const query of queries.slice(0, 3)) {
      try {
        const searched = await controller.readAction({
          id: `search:${subreddit}:${query}`,
          type: "search_subreddit",
          subreddit,
          query,
          sort: "new",
          time: "month",
          limit: Math.max(3, Math.floor(limit / 2))
        }, context);
        if (searched.type === "search_subreddit") {
          results.push(...searched.items);
        }
      } catch (error) {
        skipped.push(`browser search r/${subreddit} "${query}": ${formatError(error)}`);
      }
    }
  }

  const snapshots: RedditConversationSnapshot[] = [];
  for (const result of dedupeSearchResults(results).slice(0, subreddits.length * limit)) {
    try {
      const read = await controller.readAction({
        id: `thread:${result.id}`,
        type: "read_thread",
        url: result.url ?? result.permalink,
        postId: result.id,
        subreddit: result.subreddit,
        limit: 35
      }, context);
      if (read.type === "read_thread") {
        snapshots.push({
          thread: read.thread,
          source: "browser",
          capturedAt: new Date().toISOString()
        });
      }
    } catch (error) {
      skipped.push(`browser read ${result.id}: ${formatError(error)}`);
    }
  }
  return snapshots;
}

async function ingestViaApi(
  config: MoltbookRuntimeConfig,
  subreddits: readonly string[],
  queries: readonly string[],
  limit: number,
  skipped: string[]
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
  const items: RedditSourceItem[] = [];
  for (const subreddit of subreddits) {
    try {
      items.push(...await client.getHotPosts(subreddit, limit));
    } catch (error) {
      skipped.push(`api hot r/${subreddit}: ${formatError(error)}`);
    }
    try {
      items.push(...await client.getNewPosts(subreddit, limit));
    } catch (error) {
      skipped.push(`api new r/${subreddit}: ${formatError(error)}`);
    }
    for (const query of queries.slice(0, 3)) {
      try {
        items.push(...await client.searchSubreddit(subreddit, query, Math.max(3, Math.floor(limit / 2))));
      } catch (error) {
        skipped.push(`api search r/${subreddit} "${query}": ${formatError(error)}`);
      }
    }
  }
  return dedupeSourceItems(items).map((item) => ({
    thread: sourceItemToThreadState(item),
    source: "api",
    capturedAt: new Date().toISOString()
  }));
}

export function snapshotsToSourceItems(
  snapshots: readonly RedditConversationSnapshot[],
  history: readonly RedditOutboundMemoryEntry[] = []
): RedditSourceItem[] {
  const alreadyTouched = new Set(history.map((entry) => entry.targetId).filter(Boolean));
  const items: RedditSourceItem[] = [];
  for (const snapshot of snapshots) {
    const thread = snapshot.thread;
    for (const comment of flattenComments(thread.comments)) {
      if (alreadyTouched.has(comment.id) || comment.body.length < 40) {
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
        commentCount: thread.commentCount
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
        commentCount: thread.commentCount
      });
    }
  }
  return dedupeSourceItems(items);
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
