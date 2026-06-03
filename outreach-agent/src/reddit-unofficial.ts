import { readFile } from "node:fs/promises";
import { ProxyAgent } from "undici";

import { resolveRedditBrowserStorageStatePath } from "./config.js";
import type {
  RedditCommentState,
  RedditPublishResult,
  RedditSearchResult,
  RedditThreadState
} from "./reddit-controller.js";
import { parseRedditThreadUrl } from "./reddit-ingestion.js";

const DEFAULT_PUBLIC_REDDIT_BASE_URL = "https://www.reddit.com";
const DEFAULT_OAUTH_REDDIT_BASE_URL = "https://oauth.reddit.com";
const DEFAULT_USER_AGENT = "coti-agent-messaging:reddit-unofficial-mvp:0.1";

export type RedditUnofficialListingSort = "hot" | "new" | "rising";

export interface RedditUnofficialRuntimeConfig {
  proxy?: string;
  storageStatePath: string;
  bearerOverride?: string;
  publicBaseUrl?: string;
  oauthBaseUrl?: string;
  userAgent?: string;
}

export class RedditUnofficialConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedditUnofficialConfigurationError";
  }
}

export class RedditUnofficialRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload?: unknown
  ) {
    super(message);
    this.name = "RedditUnofficialRequestError";
  }
}

interface RedditListingChild {
  kind?: string;
  data?: Record<string, unknown>;
}

interface RedditListing {
  data?: {
    children?: RedditListingChild[];
    after?: string | null;
  };
}

interface RedditJsonErrorPayload {
  json?: {
    errors?: unknown[];
    data?: Record<string, unknown>;
  };
}

export function buildUnofficialRedditRuntimeConfig(): RedditUnofficialRuntimeConfig {
  return {
    proxy: process.env.OUTREACH_REDDIT_UNOFFICIAL_PROXY?.trim() || process.env.REDDAPI_PROXY?.trim(),
    storageStatePath: resolveRedditBrowserStorageStatePath(
      process.env.OUTREACH_REDDIT_BROWSER_STORAGE_STATE_PATH
    ),
    bearerOverride:
      process.env.OUTREACH_REDDIT_UNOFFICIAL_BEARER?.trim() || process.env.REDDAPI_BEARER?.trim(),
    publicBaseUrl: process.env.OUTREACH_REDDIT_UNOFFICIAL_PUBLIC_BASE_URL?.trim() || DEFAULT_PUBLIC_REDDIT_BASE_URL,
    oauthBaseUrl: process.env.OUTREACH_REDDIT_UNOFFICIAL_OAUTH_BASE_URL?.trim() || DEFAULT_OAUTH_REDDIT_BASE_URL,
    userAgent: process.env.OUTREACH_REDDIT_UNOFFICIAL_USER_AGENT?.trim() || DEFAULT_USER_AGENT
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

export async function loadUnofficialRedditBearer(config: RedditUnofficialRuntimeConfig): Promise<string> {
  if (config.bearerOverride) {
    return config.bearerOverride;
  }
  const raw = await readFile(config.storageStatePath, "utf8");
  const state = JSON.parse(raw) as { cookies?: Array<{ name?: string; value?: string }> };
  const token = state.cookies?.find((cookie) => cookie.name === "token_v2")?.value?.trim();
  if (!token || jwtExpired(token)) {
    throw new RedditUnofficialConfigurationError(
      "token_v2 missing or expired in reddit storage state — run reddit:login."
    );
  }
  return token;
}

export function buildUnofficialRedditThreadUrl(
  subreddit: string,
  postId: string,
  publicBaseUrl = DEFAULT_PUBLIC_REDDIT_BASE_URL
): string {
  return new URL(
    `/r/${encodeURIComponent(subreddit)}/comments/${encodeURIComponent(stripThingPrefix(postId))}/`,
    publicBaseUrl
  ).toString();
}

export interface RedditUnofficialAccountHealth {
  status: "active" | "suspended" | "session_invalid" | "misconfigured";
  username?: string;
  reason: string;
}

export function formatRedditThingId(value: string, prefix: "t1" | "t3"): string {
  if (!value.trim()) {
    throw new RedditUnofficialConfigurationError(`Missing Reddit identifier for ${prefix}.`);
  }
  return value.startsWith(`${prefix}_`) ? value : `${prefix}_${value}`;
}

export type RedditVoteDirection = "up" | "down" | "clear";

export class RedditUnofficialClient {
  private bearerCache?: Promise<string>;
  private readonly proxyDispatcher?: ProxyAgent;

  constructor(
    private readonly config: RedditUnofficialRuntimeConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    if (config.proxy) {
      this.proxyDispatcher = new ProxyAgent(config.proxy);
    }
  }

  async getBearer(): Promise<string> {
    if (!this.bearerCache) {
      this.bearerCache = loadUnofficialRedditBearer(this.config);
    }
    return this.bearerCache;
  }

  async checkAccountHealth(expectedUsername?: string): Promise<RedditUnofficialAccountHealth> {
    try {
      await this.getBearer();
    } catch (error) {
      return {
        status: "session_invalid",
        reason: error instanceof Error ? error.message : String(error)
      };
    }

    try {
      const url = new URL("/api/v1/me", this.oauthBaseUrl());
      url.searchParams.set("raw_json", "1");
      const payload = await this.fetchAuthenticatedJson<Record<string, unknown>>(url);
      const account = extractMeAccount(payload);
      const username = stringValue(account?.name);
      const isSuspended = booleanValue(account?.is_suspended) === true;

      if (isSuspended) {
        return {
          status: "suspended",
          username,
          reason: username
            ? `Reddit account u/${username} is suspended.`
            : "Reddit account is suspended."
        };
      }

      if (!username) {
        return {
          status: "session_invalid",
          reason: "Reddit /api/v1/me did not return a username."
        };
      }

      if (
        expectedUsername &&
        username.toLowerCase() !== expectedUsername.replace(/^u\//i, "").toLowerCase()
      ) {
        return {
          status: "session_invalid",
          username,
          reason: `Reddit session is authenticated as u/${username}, expected u/${expectedUsername}.`
        };
      }

      return {
        status: "active",
        username,
        reason: `Reddit account u/${username} is active.`
      };
    } catch (error) {
      if (error instanceof RedditUnofficialRequestError) {
        if (error.status === 401 || error.status === 403) {
          const suspended = looksLikeSuspendedAccount(error.payload, error.status);
          return {
            status: suspended ? "suspended" : "session_invalid",
            reason: error.message
          };
        }
      }
      return {
        status: "session_invalid",
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async searchPosts(
    query: string,
    input: { subreddit?: string; limit?: number; pageIndex?: number } = {}
  ): Promise<RedditSearchResult[]> {
    const subreddit = input.subreddit?.trim();
    const url = subreddit
      ? new URL(`/r/${encodeURIComponent(subreddit)}/search`, this.oauthBaseUrl())
      : new URL("/search", this.oauthBaseUrl());
    url.searchParams.set("q", query);
    url.searchParams.set("sort", "new");
    if (subreddit) {
      url.searchParams.set("restrict_sr", "1");
    }
    return this.fetchListingAtPage(url, input.limit ?? 10, input.pageIndex ?? 0, subreddit);
  }

  async listSubredditPosts(
    subreddit: string,
    input: { sort?: RedditUnofficialListingSort; limit?: number; pageIndex?: number } = {}
  ): Promise<RedditSearchResult[]> {
    const sort = input.sort ?? "hot";
    const url = new URL(
      `/r/${encodeURIComponent(subreddit)}/${sort}`,
      this.oauthBaseUrl()
    );
    return this.fetchListingAtPage(url, input.limit ?? 10, input.pageIndex ?? 0, subreddit);
  }

  private async fetchListingAtPage(
    url: URL,
    limit: number,
    pageIndex: number,
    targetSubreddit?: string
  ): Promise<RedditSearchResult[]> {
    let after: string | undefined;
    let listing: RedditListing | undefined;
    for (let page = 0; page <= Math.max(0, pageIndex); page += 1) {
      const pageUrl = new URL(url);
      pageUrl.searchParams.set("limit", String(limit));
      pageUrl.searchParams.set("raw_json", "1");
      if (after) {
        pageUrl.searchParams.set("after", after);
      } else {
        pageUrl.searchParams.delete("after");
      }
      listing = await this.fetchAuthenticatedJson<RedditListing>(pageUrl);
      after = listing.data?.after ?? undefined;
      if (page === pageIndex || !after) {
        break;
      }
    }
    return redditListingToSearchResults(listing ?? { data: { children: [] } }, targetSubreddit);
  }

  async scrapeThread(postUrl: string, limit = 100): Promise<RedditThreadState> {
    const parsed = parseRedditThreadUrl(postUrl);
    if (!parsed) {
      throw new RedditUnofficialConfigurationError(`Invalid Reddit thread URL: ${postUrl}`);
    }
    const url = new URL(
      `/r/${encodeURIComponent(parsed.subreddit)}/comments/${encodeURIComponent(parsed.postId)}.json`,
      this.oauthBaseUrl()
    );
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("raw_json", "1");

    const payload = await this.fetchAuthenticatedJson<unknown>(url);
    return redditThreadJsonToState(payload, postUrl);
  }

  async postComment(input: { thingId: string; text: string }): Promise<RedditPublishResult> {
    const payload = await this.postOAuthForm("/api/comment", {
      api_type: "json",
      thing_id: input.thingId,
      text: input.text
    }, "comment");
    const thing = extractRedditThing(payload);
    return {
      remoteContentId: stringValue(thing?.id) ?? stringValue(thing?.name),
      remoteContentUrl: normalizeRedditUrl(
        stringValue(thing?.permalink) ??
          (Array.isArray(payload)
            ? undefined
            : stringValue((payload.json as Record<string, unknown> | undefined)?.data))
      ),
      raw: payload
    };
  }

  async voteOnThing(input: { thingId: string; direction: RedditVoteDirection }): Promise<RedditPublishResult> {
    const thingId = normalizeVoteThingId(input.thingId);
    const dir = input.direction === "up" ? "1" : input.direction === "down" ? "-1" : "0";
    const payload = await this.postOAuthForm(
      "/api/vote",
      {
        api_type: "json",
        id: thingId,
        dir
      },
      "vote"
    );
    return {
      remoteContentId: thingId,
      raw: payload
    };
  }

  async upvotePost(postId: string): Promise<RedditPublishResult> {
    return this.voteOnThing({ thingId: formatRedditThingId(postId, "t3"), direction: "up" });
  }

  async upvoteComment(commentId: string): Promise<RedditPublishResult> {
    return this.voteOnThing({ thingId: formatRedditThingId(commentId, "t1"), direction: "up" });
  }

  private async postOAuthForm(
    path: string,
    fields: Record<string, string>,
    operationLabel: string
  ): Promise<Record<string, unknown> | unknown[]> {
    const bearer = await this.getBearer();
    const response = await this.fetchWithProxy(new URL(path, this.oauthBaseUrl()), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "User-Agent": this.userAgent(),
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams(fields).toString()
    });
    const text = await response.text();
    const payload = parseJsonResponse(text, response.status);
    if (!response.ok) {
      throw new RedditUnofficialRequestError(
        `Reddit unofficial ${operationLabel} failed with ${response.status}: ${text}`,
        response.status,
        payload
      );
    }
    const errors = extractApiErrors(payload);
    if (errors.length > 0) {
      throw new RedditUnofficialRequestError(
        `Reddit unofficial ${operationLabel} rejected: ${errors.join("; ")}`,
        response.status,
        payload
      );
    }
    return payload;
  }

  private async fetchAuthenticatedJson<T>(url: URL): Promise<T> {
    const bearer = await this.getBearer();
    return this.fetchJson<T>(url, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        "User-Agent": this.userAgent(),
        Accept: "application/json"
      }
    });
  }

  private async fetchJson<T>(url: URL, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchWithProxy(url, init);
    const text = await response.text();
    const payload = parseJsonResponse(text, response.status);
    if (!response.ok) {
      throw new RedditUnofficialRequestError(
        `Reddit unofficial request failed with ${response.status}: ${text}`,
        response.status,
        payload
      );
    }
    return payload as T;
  }

  private fetchWithProxy(url: URL, init: RequestInit): Promise<Response> {
    const proxiedInit = this.proxyDispatcher
      ? ({ ...init, dispatcher: this.proxyDispatcher } as RequestInit & { dispatcher: ProxyAgent })
      : init;
    return this.fetchImpl(url, proxiedInit);
  }

  private publicBaseUrl(): string {
    return this.config.publicBaseUrl ?? DEFAULT_PUBLIC_REDDIT_BASE_URL;
  }

  private oauthBaseUrl(): string {
    return this.config.oauthBaseUrl ?? DEFAULT_OAUTH_REDDIT_BASE_URL;
  }

  private userAgent(): string {
    return this.config.userAgent ?? DEFAULT_USER_AGENT;
  }
}

export function redditListingToSearchResults(
  listing: RedditListing,
  targetSubreddit?: string
): RedditSearchResult[] {
  const normalizedTarget = targetSubreddit?.toLowerCase();
  const children = listing.data?.children ?? [];
  const results: RedditSearchResult[] = [];
  for (const child of children) {
    const data = child.data;
    const id = stringValue(data?.id) ?? stripThingPrefix(stringValue(data?.name) ?? "");
    const subreddit = stringValue(data?.subreddit);
    const title = stringValue(data?.title);
    if (!id || !subreddit || !title) {
      continue;
    }
    if (normalizedTarget && subreddit.toLowerCase() !== normalizedTarget) {
      continue;
    }
    const permalink =
      stringValue(data?.permalink) ??
      `/r/${encodeURIComponent(subreddit)}/comments/${encodeURIComponent(id)}/`;
    results.push({
      id,
      subreddit,
      title,
      body: stringValue(data?.selftext),
      author: stringValue(data?.author),
      permalink,
      url: normalizeRedditUrl(permalink),
      score: numberValue(data?.score),
      commentCount: numberValue(data?.num_comments),
      createdUtc: numberValue(data?.created_utc)
    });
  }
  return results;
}

export function redditThreadJsonToState(payload: unknown, postUrl: string): RedditThreadState {
  if (!Array.isArray(payload) || payload.length < 2) {
    throw new RedditUnofficialRequestError("Unexpected Reddit thread JSON shape.", 200, payload);
  }
  const postListing = payload[0] as RedditListing;
  const commentListing = payload[1] as RedditListing;
  const post = postListing.data?.children?.[0]?.data;
  if (!post) {
    throw new RedditUnofficialRequestError("Reddit thread JSON did not include a post.", 200, payload);
  }
  const parsed = parseRedditThreadUrl(postUrl);
  const postId = stringValue(post.id) ?? parsed?.postId ?? "unknown";
  const subreddit = stringValue(post.subreddit) ?? parsed?.subreddit ?? "unknown";
  const permalink = stringValue(post.permalink) ?? new URL(postUrl).pathname;
  return {
    id: postId,
    subreddit,
    title: stringValue(post.title) ?? "",
    body: stringValue(post.selftext),
    author: stringValue(post.author),
    permalink,
    url: normalizeRedditUrl(permalink),
    score: numberValue(post.score),
    commentCount: numberValue(post.num_comments),
    createdUtc: numberValue(post.created_utc),
    locked: booleanValue(post.locked),
    archived: booleanValue(post.archived),
    removed: Boolean(post.removed_by_category),
    comments: (commentListing.data?.children ?? []).flatMap((child) => commentChildToState(child, 0))
  };
}

function commentChildToState(child: RedditListingChild, depth: number): RedditCommentState[] {
  if (child.kind !== "t1" || !child.data) {
    return [];
  }
  const data = child.data;
  const id = stringValue(data.id) ?? stripThingPrefix(stringValue(data.name) ?? "");
  const body = stringValue(data.body) ?? "";
  if (!id || !body) {
    return [];
  }
  const replies = extractReplies(data.replies, depth + 1);
  return [
    {
      id,
      body,
      author: stringValue(data.author),
      permalink: stringValue(data.permalink),
      score: numberValue(data.score),
      createdUtc: numberValue(data.created_utc),
      parentId: stringValue(data.parent_id),
      depth,
      replies
    }
  ];
}

function extractReplies(value: unknown, depth: number): RedditCommentState[] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const listing = value as RedditListing;
  const replies = (listing.data?.children ?? []).flatMap((child) => commentChildToState(child, depth));
  return replies.length > 0 ? replies : undefined;
}

function normalizeVoteThingId(value: string): string {
  const trimmed = value.trim();
  if (/^t[13]_/.test(trimmed)) {
    return trimmed;
  }
  throw new RedditUnofficialConfigurationError(
    `Vote target must be a Reddit fullname (t1_ or t3_); got ${value}.`
  );
}

function parseJsonResponse(text: string, status: number): Record<string, unknown> | unknown[] {
  try {
    return text ? (JSON.parse(text) as Record<string, unknown> | unknown[]) : {};
  } catch {
    throw new RedditUnofficialRequestError(`Reddit returned non-JSON (${status}).`, status, text);
  }
}

function extractApiErrors(payload: Record<string, unknown> | unknown[]): string[] {
  if (Array.isArray(payload)) {
    return [];
  }
  const errors = (payload as RedditJsonErrorPayload).json?.errors;
  if (!Array.isArray(errors)) {
    return [];
  }
  return errors
    .map((entry) => Array.isArray(entry) ? entry.map((part) => String(part)).join(": ") : undefined)
    .filter((entry): entry is string => Boolean(entry));
}

function extractRedditThing(payload: Record<string, unknown> | unknown[]): Record<string, unknown> | undefined {
  if (Array.isArray(payload)) {
    return undefined;
  }
  const data = (payload.json as Record<string, unknown> | undefined)?.data;
  if (!isRecord(data)) {
    return undefined;
  }
  if (Array.isArray(data.things)) {
    return data.things.find(isRecord);
  }
  return data;
}

function normalizeRedditUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const url = value.startsWith("http")
    ? new URL(value)
    : new URL(value, DEFAULT_PUBLIC_REDDIT_BASE_URL);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function stripThingPrefix(value: string): string {
  return value.replace(/^t[0-9]_/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function extractMeAccount(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(payload.data)) {
    return payload.data;
  }
  return isRecord(payload) ? payload : undefined;
}

function looksLikeSuspendedAccount(payload: unknown, status: number): boolean {
  if (status === 403) {
    return true;
  }
  const text = JSON.stringify(payload ?? "").toLowerCase();
  return text.includes("suspended") || text.includes("banned");
}
