import { redditMemoryEntryConsumesTarget } from "./reddit-outreach.js";
import type { RedditOutboundMemoryEntry, RedditSourceItem } from "./reddit-outreach-types.js";
import type { RedditConversationSnapshot, RedditThreadState } from "./reddit-controller.js";
import {
  MIN_COMMENT_BODY_DISCOVERY,
  MIN_COMMENT_BODY_OWN_THREAD
} from "./reddit-ingestion-types.js";
import { dedupeSourceItems } from "./reddit-ingestion-utils.js";
import {
  collectOwnThreadTargets,
  parseRedditThreadUrl,
  qualifiesForOwnThreadParticipation
} from "./reddit-ingestion-discovery.js";
import {
  getScanLedgerEntry,
  isCommentSeenInLedger,
  isPostBodySeenInLedger,
  threadHasNewCommentsSinceLedger,
  type RedditScanLedgerEntry
} from "./reddit-scan-ledger.js";

export function snapshotsToSourceItems(
  snapshots: readonly RedditConversationSnapshot[],
  history: readonly RedditOutboundMemoryEntry[] = [],
  options: { venueAccountId?: string; scanLedgerMap?: ReadonlyMap<string, RedditScanLedgerEntry> } = {}
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
    const ledgerEntry = options.scanLedgerMap
      ? getScanLedgerEntry(options.scanLedgerMap, thread.subreddit, thread.id)
      : undefined;
    const hasNewComments = threadHasNewCommentsSinceLedger(ledgerEntry, thread.commentCount);
    const onOwnThread = snapshot.ownThread === true || ownThreadPostIds.has(thread.id);
    const minCommentBody = onOwnThread ? MIN_COMMENT_BODY_OWN_THREAD : MIN_COMMENT_BODY_DISCOVERY;
    const commentById = indexCommentsById(thread.comments);

    for (const comment of flattenComments(thread.comments)) {
      if (alreadyTouched.has(comment.id)) {
        continue;
      }
      if (options.scanLedgerMap && isCommentSeenInLedger(ledgerEntry, comment.id)) {
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
      const skipPostBody =
        options.scanLedgerMap &&
        isPostBodySeenInLedger(ledgerEntry, hasNewComments) &&
        !onOwnThread;
      if (!skipPostBody) {
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

export function sourceItemToThreadState(item: RedditSourceItem): RedditThreadState {
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

