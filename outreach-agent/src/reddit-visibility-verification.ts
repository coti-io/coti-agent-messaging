import { parseRedditThreadUrl } from "./reddit-ingestion.js";
import { parseRedditThreadJsonListing } from "./reddit-outreach.js";
import type { RedditCommentState } from "./reddit-controller.js";

export interface RedditVisibilityVerificationInput {
  subreddit?: string;
  threadPostId?: string;
  remoteContentId?: string;
  remoteContentUrl?: string;
  content: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  commentLimit?: number;
}

export interface RedditVisibilityVerificationResult {
  visible?: boolean;
  matchedCommentId?: string;
  checkedUrl?: string;
  reason: "visible" | "not_found" | "missing_target" | "thread_unavailable" | "fetch_failed";
}

const PUBLIC_REDDIT_BASE_URL = "https://www.reddit.com";

export async function verifyPublicRedditCommentVisibility(
  input: RedditVisibilityVerificationInput
): Promise<RedditVisibilityVerificationResult> {
  const target = resolveVerificationTarget(input);
  if (!target) {
    return { visible: undefined, reason: "missing_target" };
  }

  const checkedUrl = new URL(
    `/r/${encodeURIComponent(target.subreddit)}/comments/${encodeURIComponent(target.postId)}.json`,
    PUBLIC_REDDIT_BASE_URL
  );
  checkedUrl.searchParams.set("limit", String(input.commentLimit ?? 100));
  checkedUrl.searchParams.set("depth", "8");
  checkedUrl.searchParams.set("sort", "new");
  checkedUrl.searchParams.set("raw_json", "1");

  const fetchImpl = input.fetchImpl ?? fetch;
  let payload: unknown;
  try {
    const response = await fetchImpl(checkedUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(input.userAgent ? { "User-Agent": input.userAgent } : {})
      }
    });
    if (!response.ok) {
      return {
        visible: undefined,
        checkedUrl: checkedUrl.toString(),
        reason: "thread_unavailable"
      };
    }
    payload = await response.json();
  } catch {
    return {
      visible: undefined,
      checkedUrl: checkedUrl.toString(),
      reason: "fetch_failed"
    };
  }

  const thread = parseRedditThreadJsonListing(payload, PUBLIC_REDDIT_BASE_URL);
  if (!thread) {
    return {
      visible: undefined,
      checkedUrl: checkedUrl.toString(),
      reason: "thread_unavailable"
    };
  }

  const targetCommentId = normalizeRedditId(input.remoteContentId) ?? extractCommentIdFromUrl(input.remoteContentUrl);
  const contentSnippet = commentVerificationSnippet(input.content);
  const matchedCommentId = findVisibleCommentId(thread.comments, targetCommentId, contentSnippet);
  if (!matchedCommentId) {
    return {
      visible: false,
      checkedUrl: checkedUrl.toString(),
      reason: "not_found"
    };
  }

  return {
    visible: true,
    matchedCommentId,
    checkedUrl: checkedUrl.toString(),
    reason: "visible"
  };
}

function resolveVerificationTarget(
  input: RedditVisibilityVerificationInput
): { subreddit: string; postId: string } | undefined {
  const parsedFromUrl = input.remoteContentUrl ? parseRedditThreadUrl(input.remoteContentUrl) : undefined;
  const subreddit = (input.subreddit ?? parsedFromUrl?.subreddit ?? "").trim();
  const postId = normalizeRedditId(input.threadPostId) ?? parsedFromUrl?.postId;
  if (!subreddit || !postId) {
    return undefined;
  }
  return { subreddit, postId };
}

function findVisibleCommentId(
  comments: readonly RedditCommentState[],
  targetCommentId: string | undefined,
  contentSnippet: string
): string | undefined {
  for (const comment of comments) {
    const normalizedId = normalizeRedditId(comment.id);
    if (targetCommentId && normalizedId === targetCommentId) {
      return normalizedId;
    }
    if (normalizeCommentText(comment.body).includes(contentSnippet)) {
      return normalizedId;
    }
    const replyMatch = comment.replies ? findVisibleCommentId(comment.replies, targetCommentId, contentSnippet) : undefined;
    if (replyMatch) {
      return replyMatch;
    }
  }
  return undefined;
}

function extractCommentIdFromUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value, PUBLIC_REDDIT_BASE_URL);
    const parts = url.pathname.split("/").filter(Boolean);
    const commentSegment = parts[parts.length - 1];
    return commentSegment ? normalizeRedditId(commentSegment) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeRedditId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/^t[0-9]_/, "").trim() || undefined;
}

function commentVerificationSnippet(content: string): string {
  const normalized = normalizeCommentText(content);
  if (normalized.length <= 80) {
    return normalized;
  }
  return normalized.slice(0, 80);
}

function normalizeCommentText(content: string): string {
  return content.trim().replace(/\s+/g, " ").toLowerCase();
}
