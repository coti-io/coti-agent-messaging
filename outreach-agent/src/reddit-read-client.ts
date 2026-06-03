import type { RedditCommentState, RedditThreadState } from "./reddit-controller.js";
import type { RedditReadOnlyClientConfig, RedditSourceItem } from "./reddit-outreach-types.js";

export class RedditReadOnlyClient {
  private readonly accessToken: string;
  private readonly userAgent: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: RedditReadOnlyClientConfig) {
    if (!config.accessToken) {
      throw new Error("Reddit read-only monitoring requires REDDIT_ACCESS_TOKEN.");
    }
    if (!config.userAgent) {
      throw new Error("Reddit read-only monitoring requires REDDIT_USER_AGENT.");
    }

    this.accessToken = config.accessToken;
    this.userAgent = config.userAgent;
    this.baseUrl = config.baseUrl ?? "https://oauth.reddit.com";
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async getNewPosts(subreddit: string, limit = 10): Promise<RedditSourceItem[]> {
    const url = new URL(`/r/${encodeURIComponent(subreddit)}/new.json`, this.baseUrl);
    url.searchParams.set("limit", String(limit));
    return parseRedditListing(await this.fetchJson(url));
  }

  async getHotPosts(subreddit: string, limit = 10): Promise<RedditSourceItem[]> {
    const url = new URL(`/r/${encodeURIComponent(subreddit)}/hot.json`, this.baseUrl);
    url.searchParams.set("limit", String(limit));
    return parseRedditListing(await this.fetchJson(url));
  }

  async searchSubreddit(
    subreddit: string,
    query: string,
    limit = 10
  ): Promise<RedditSourceItem[]> {
    const url = new URL(`/r/${encodeURIComponent(subreddit)}/search.json`, this.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("restrict_sr", "1");
    url.searchParams.set("sort", "new");
    url.searchParams.set("limit", String(limit));
    return parseRedditListing(await this.fetchJson(url));
  }

  async getThreadState(
    subreddit: string,
    postId: string,
    commentLimit = 100
  ): Promise<RedditThreadState | undefined> {
    const url = new URL(
      `/r/${encodeURIComponent(subreddit)}/comments/${encodeURIComponent(postId)}.json`,
      this.baseUrl
    );
    url.searchParams.set("limit", String(commentLimit));
    url.searchParams.set("depth", "8");
    url.searchParams.set("sort", "new");
    return parseRedditThreadJsonListing(await this.fetchJson(url), this.baseUrl);
  }

  private async fetchJson(url: URL): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "User-Agent": this.userAgent,
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Reddit API request failed with ${response.status}: ${await response.text()}`);
    }

    return response.json();
  }
}

export function parseRedditListing(input: unknown): RedditSourceItem[] {
  if (Array.isArray(input)) {
    return input.flatMap((entry) => parseRedditListing(entry));
  }

  if (!isRecord(input)) {
    return [];
  }

  if (Array.isArray(input.items)) {
    return input.items.flatMap((entry) => parseRedditListing(entry));
  }

  if (Array.isArray(input.posts)) {
    return input.posts.flatMap((entry) => parseFlexibleSource(entry, "post"));
  }

  if (Array.isArray(input.comments)) {
    return input.comments.flatMap((entry) => parseFlexibleSource(entry, "comment"));
  }

  if (isRecord(input.data) && Array.isArray(input.data.children)) {
    return input.data.children.flatMap((child) => {
      if (!isRecord(child) || !isRecord(child.data)) {
        return [];
      }

      const kind = child.kind === "t1" ? "comment" : "post";
      return parseFlexibleSource(child.data, kind);
    });
  }

  return parseFlexibleSource(input, "post");
}

export function parseRedditThreadJsonListing(
  input: unknown,
  baseUrl = "https://www.reddit.com"
): RedditThreadState | undefined {
  if (!Array.isArray(input) || input.length === 0) {
    return undefined;
  }
  const postItems = parseRedditListing(input[0]);
  const post = postItems.find((item) => item.kind === "post");
  if (!post) {
    return undefined;
  }
  const comments = parseRedditCommentListingJson(input[1]);
  return {
    id: post.id,
    subreddit: post.subreddit,
    title: post.title,
    body: post.body,
    author: post.author,
    permalink: post.permalink,
    url: post.url,
    score: post.score,
    commentCount: post.commentCount,
    createdUtc: post.createdUtc,
    comments
  };
}

function parseRedditCommentListingJson(input: unknown): RedditCommentState[] {
  if (!isRecord(input) || !isRecord(input.data) || !Array.isArray(input.data.children)) {
    return [];
  }
  return input.data.children.flatMap((child) => parseRedditCommentNodeJson(child, 0));
}

function parseRedditCommentNodeJson(input: unknown, depth: number): RedditCommentState[] {
  if (!isRecord(input) || input.kind !== "t1" || !isRecord(input.data)) {
    return [];
  }
  const data = input.data;
  const replies =
    isRecord(data.replies) && isRecord(data.replies.data) && Array.isArray(data.replies.data.children)
      ? data.replies.data.children.flatMap((child) => parseRedditCommentNodeJson(child, depth + 1))
      : [];
  return [
    {
      id: stringValue(data.id) ?? stringValue(data.name) ?? `comment-depth-${depth}`,
      body: stringValue(data.body) ?? "",
      author: stringValue(data.author),
      permalink: stringValue(data.permalink),
      score: numberValue(data.score),
      createdUtc: numberValue(data.created_utc),
      parentId: stringValue(data.parent_id),
      depth,
      replies
    }
  ].filter((comment) => comment.body.length > 0);
}

function parseFlexibleSource(input: unknown, fallbackKind: RedditSourceItem["kind"]): RedditSourceItem[] {
  if (!isRecord(input)) {
    return [];
  }

  const subreddit = stringValue(input.subreddit) ?? stringValue(input.subreddit_name_prefixed)?.replace(/^r\//, "");
  const id = stringValue(input.id) ?? stringValue(input.name);
  if (!subreddit || !id) {
    return [];
  }

  const kind =
    stringValue(input.kind) === "comment" || stringValue(input.kind) === "post"
      ? (input.kind as RedditSourceItem["kind"])
      : fallbackKind;
  const title =
    stringValue(input.title) ??
    stringValue(input.link_title) ??
    stringValue(input.parentTitle) ??
    "Comment thread";

  return [
    {
      id,
      kind,
      subreddit,
      title,
      body: stringValue(input.selftext) ?? stringValue(input.body) ?? stringValue(input.content),
      author: stringValue(input.author),
      permalink: stringValue(input.permalink),
      url: stringValue(input.url),
      createdUtc: numberValue(input.created_utc) ?? numberValue(input.createdUtc),
      score: numberValue(input.score),
      commentCount: numberValue(input.num_comments) ?? numberValue(input.commentCount),
      parentTitle: stringValue(input.link_title) ?? stringValue(input.parentTitle)
    }
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
