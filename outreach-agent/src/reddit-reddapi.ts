import { readFile } from "node:fs/promises";

import { resolveRedditBrowserStorageStatePath } from "./config.js";
import type {
  RedditCommentState,
  RedditPublishResult,
  RedditSearchResult,
  RedditThreadState
} from "./reddit-controller.js";
import { parseRedditThreadUrl } from "./reddit-ingestion.js";

const DEFAULT_RAPIDAPI_HOST = "reddapi.p.rapidapi.com";
const PUBLIC_REDDIT_BASE_URL = "https://www.reddit.com";

export interface ReddapiRuntimeConfig {
  rapidApiKey: string;
  proxy: string;
  storageStatePath: string;
  rapidApiHost?: string;
  bearerOverride?: string;
}

export class ReddapiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReddapiConfigurationError";
  }
}

export class ReddapiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload?: unknown
  ) {
    super(message);
    this.name = "ReddapiRequestError";
  }
}

interface ReddapiScrapedComment {
  comment?: string;
  author?: string;
  user_id?: string;
  score?: number;
}

interface ReddapiSearchPost {
  id?: string;
  title?: string;
  author?: string;
  subreddit?: string;
  score?: number;
  num_comments?: number;
  created_utc?: number;
  permalink?: string;
  url?: string;
}

export function buildReddapiRuntimeConfig(packageRoot: string): ReddapiRuntimeConfig | undefined {
  const rapidApiKey = process.env.RAPIDAPI_REDDAPI_KEY?.trim();
  const proxy = process.env.REDDAPI_PROXY?.trim();
  if (!rapidApiKey || !proxy) {
    return undefined;
  }
  return {
    rapidApiKey,
    proxy,
    storageStatePath: resolveRedditBrowserStorageStatePath(
      process.env.OUTREACH_REDDIT_BROWSER_STORAGE_STATE_PATH
    ),
    rapidApiHost: process.env.RAPIDAPI_REDDAPI_HOST?.trim() || DEFAULT_RAPIDAPI_HOST,
    bearerOverride: process.env.REDDAPI_BEARER?.trim()
  };
}

function jwtExpired(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as {
      exp?: number;
    };
    return typeof payload.exp === "number" && Date.now() > payload.exp * 1000;
  } catch {
    return true;
  }
}

export async function loadReddapiBearer(config: ReddapiRuntimeConfig): Promise<string> {
  if (config.bearerOverride) {
    return config.bearerOverride;
  }
  const raw = await readFile(config.storageStatePath, "utf8");
  const state = JSON.parse(raw) as { cookies?: Array<{ name?: string; value?: string }> };
  const token = state.cookies?.find((cookie) => cookie.name === "token_v2")?.value?.trim();
  if (!token || jwtExpired(token)) {
    throw new ReddapiConfigurationError(
      "token_v2 missing or expired in reddit storage state — run reddit:login."
    );
  }
  return token;
}

export function buildPublicRedditThreadUrl(subreddit: string, postId: string): string {
  return new URL(
    `/r/${encodeURIComponent(subreddit)}/comments/${encodeURIComponent(postId)}/`,
    PUBLIC_REDDIT_BASE_URL
  ).toString();
}

export function reddapiScrapeToThreadState(input: {
  postUrl: string;
  subreddit?: string;
  postId?: string;
  title?: string;
  body?: string;
  comments: readonly ReddapiScrapedComment[];
}): RedditThreadState {
  const parsed = parseRedditThreadUrl(input.postUrl);
  const postId = input.postId ?? parsed?.postId ?? "unknown";
  const subreddit = input.subreddit ?? parsed?.subreddit ?? "unknown";
  const flatComments: RedditCommentState[] = input.comments.map((entry, index) => ({
    id: `reddapi-${postId}-${index}`,
    body: entry.comment ?? "",
    author: entry.author,
    score: entry.score,
    depth: 0
  }));

  return {
    id: postId,
    subreddit,
    title: input.title ?? "",
    body: input.body,
    url: input.postUrl,
    permalink: new URL(input.postUrl).pathname,
    comments: flatComments,
    commentCount: flatComments.length
  };
}

export function reddapiSearchPostsToResults(
  posts: readonly ReddapiSearchPost[],
  targetSubreddit?: string
): RedditSearchResult[] {
  const normalizedTarget = targetSubreddit?.toLowerCase();
  const results: RedditSearchResult[] = [];
  for (const post of posts) {
    if (!post.id || !post.subreddit || !post.title) {
      continue;
    }
    if (normalizedTarget && post.subreddit.toLowerCase() !== normalizedTarget) {
      continue;
    }
    const permalink =
      post.permalink?.trim() ||
      `/r/${encodeURIComponent(post.subreddit)}/comments/${encodeURIComponent(post.id)}/`;
    results.push({
      id: post.id.replace(/^t[0-9]_/, ""),
      subreddit: post.subreddit,
      title: post.title,
      author: post.author,
      permalink,
      url: buildPublicRedditThreadUrl(post.subreddit, post.id.replace(/^t[0-9]_/, "")),
      score: post.score,
      commentCount: post.num_comments,
      createdUtc: post.created_utc
    });
  }
  return results;
}

export class RedditReddapiClient {
  private bearerCache?: Promise<string>;

  constructor(
    private readonly config: ReddapiRuntimeConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async getBearer(): Promise<string> {
    if (!this.bearerCache) {
      this.bearerCache = loadReddapiBearer(this.config);
    }
    return this.bearerCache;
  }

  async request<T = Record<string, unknown>>(
    route: string,
    options: { method?: "GET" | "POST"; query?: Record<string, string | number | undefined>; body?: Record<string, unknown> } = {}
  ): Promise<T> {
    const url = new URL(`https://${this.config.rapidApiHost ?? DEFAULT_RAPIDAPI_HOST}${route}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }
    const response = await this.fetchImpl(url, {
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        "x-rapidapi-host": this.config.rapidApiHost ?? DEFAULT_RAPIDAPI_HOST,
        "x-rapidapi-key": this.config.rapidApiKey
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const text = await response.text();
    let payload: Record<string, unknown>;
    try {
      payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new ReddapiRequestError(`ReddAPI returned non-JSON (${response.status}).`, response.status, text);
    }
    if (!response.ok) {
      throw new ReddapiRequestError(
        `ReddAPI ${route} failed with ${response.status}: ${payload.message ?? text}`,
        response.status,
        payload
      );
    }
    return payload as T;
  }

  async scrapeThread(postUrl: string): Promise<RedditThreadState> {
    const [post, comments] = await Promise.all([
      this.request<{ success?: boolean; data?: { subreddit?: string; title?: string; text?: string } }>(
        "/api/scrape_post",
        { query: { post_url: postUrl } }
      ),
      this.request<{ success?: boolean; comments?: ReddapiScrapedComment[] }>("/api/scrape_post_comments", {
        query: { post_url: postUrl }
      })
    ]);
    const parsed = parseRedditThreadUrl(postUrl);
    return reddapiScrapeToThreadState({
      postUrl,
      subreddit: post.data?.subreddit?.replace(/^r\//, "") ?? parsed?.subreddit,
      postId: parsed?.postId,
      title: post.data?.title,
      body: post.data?.text,
      comments: comments.comments ?? []
    });
  }

  async searchPosts(
    query: string,
    input: { subreddit?: string; limit?: number } = {}
  ): Promise<RedditSearchResult[]> {
    const payload = await this.request<{ success?: boolean; posts?: ReddapiSearchPost[] }>(
      "/api/v2/search/posts",
      {
        query: {
          query,
          subreddit: input.subreddit,
          limit: input.limit ?? 10
        }
      }
    );
    return reddapiSearchPostsToResults(payload.posts ?? [], input.subreddit);
  }

  async postComment(postUrl: string, text: string): Promise<RedditPublishResult> {
    const bearer = await this.getBearer();
    const payload = await this.request<{
      success?: boolean;
      reddit_status_code?: number;
      message?: string;
    }>("/api/comment", {
      method: "POST",
      body: {
        post_url: postUrl,
        text,
        bearer,
        proxy: this.config.proxy
      }
    });
    if (payload.success !== true) {
      throw new ReddapiRequestError(
        payload.message ?? "ReddAPI comment request failed.",
        payload.reddit_status_code ?? 500,
        payload
      );
    }
    return {
      remoteContentUrl: postUrl,
      raw: payload
    };
  }
}

export function resolveReddapiPostUrl(input: {
  raw?: unknown;
  surface?: string;
  parentId?: string;
  candidateId?: string;
  type: "comment_on_post" | "reply_to_comment";
}): string {
  const record = isRecord(input.raw) ? input.raw : undefined;
  const permalink = stringValue(record?.permalink);
  const url = stringValue(record?.url);
  if (permalink) {
    return normalizePublicRedditUrl(permalink);
  }
  if (url) {
    return normalizePublicRedditUrl(url);
  }
  if (input.type === "comment_on_post" && input.parentId && input.surface) {
    return buildPublicRedditThreadUrl(input.surface, input.parentId.replace(/^t[0-9]_/, ""));
  }
  if (input.type === "reply_to_comment" && input.parentId && input.surface) {
    return buildPublicRedditThreadUrl(input.surface, input.parentId.replace(/^t[0-9]_/, ""));
  }
  throw new ReddapiConfigurationError(
    "ReddAPI publish requires action.raw permalink/url or subreddit + parent post id."
  );
}

function normalizePublicRedditUrl(value: string): string {
  const url = value.startsWith("http") ? new URL(value) : new URL(value, PUBLIC_REDDIT_BASE_URL);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
