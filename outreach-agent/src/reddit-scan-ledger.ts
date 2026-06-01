import type { RedditConversationSnapshot, RedditThreadState } from "./reddit-controller.js";

export interface RedditScanLedgerEntry {
  postId: string;
  subreddit: string;
  lastScannedAt: string;
  commentCount?: number;
  seenCommentIds: string[];
  seenPostBody?: boolean;
}

export const DEFAULT_SCAN_LEDGER_TTL_HOURS = 48;
export const DEFAULT_SCAN_LEDGER_MAX_ENTRIES = 2000;
const MAX_SEEN_COMMENT_IDS_PER_POST = 200;

export function ledgerKey(subreddit: string, postId: string): string {
  return `${subreddit.toLowerCase()}:${postId}`;
}

export function buildScanLedgerMap(
  entries: readonly RedditScanLedgerEntry[] = []
): Map<string, RedditScanLedgerEntry> {
  const map = new Map<string, RedditScanLedgerEntry>();
  for (const entry of entries) {
    map.set(ledgerKey(entry.subreddit, entry.postId), entry);
  }
  return map;
}

export function getScanLedgerEntry(
  ledger: ReadonlyMap<string, RedditScanLedgerEntry>,
  subreddit: string,
  postId: string
): RedditScanLedgerEntry | undefined {
  return ledger.get(ledgerKey(subreddit, postId));
}

export function shouldSkipColdDiscoveryRead(
  entry: RedditScanLedgerEntry | undefined,
  now: Date,
  ttlHours: number,
  currentCommentCount?: number
): boolean {
  if (!entry) {
    return false;
  }
  const ttlMs = Math.max(1, ttlHours) * 60 * 60 * 1000;
  const ageMs = now.getTime() - Date.parse(entry.lastScannedAt);
  if (ageMs >= ttlMs) {
    return false;
  }
  if (currentCommentCount === undefined || entry.commentCount === undefined) {
    return true;
  }
  return currentCommentCount <= entry.commentCount;
}

export function collectScanLedgerExcludePostIds(
  ledger: readonly RedditScanLedgerEntry[],
  now: Date,
  ttlHours: number
): Set<string> {
  const ids = new Set<string>();
  for (const entry of ledger) {
    if (shouldSkipColdDiscoveryRead(entry, now, ttlHours, entry.commentCount)) {
      ids.add(entry.postId);
    }
  }
  return ids;
}

export function isCommentSeenInLedger(
  entry: RedditScanLedgerEntry | undefined,
  commentId: string
): boolean {
  if (!entry) {
    return false;
  }
  return entry.seenCommentIds.includes(commentId);
}

export function isPostBodySeenInLedger(
  entry: RedditScanLedgerEntry | undefined,
  hasNewComments: boolean
): boolean {
  if (!entry?.seenPostBody) {
    return false;
  }
  return !hasNewComments;
}

export function threadHasNewCommentsSinceLedger(
  entry: RedditScanLedgerEntry | undefined,
  currentCommentCount?: number
): boolean {
  if (!entry || currentCommentCount === undefined || entry.commentCount === undefined) {
    return true;
  }
  return currentCommentCount > entry.commentCount;
}

export function upsertScanLedgerFromSnapshot(
  ledger: Map<string, RedditScanLedgerEntry>,
  snapshot: RedditConversationSnapshot,
  scannedAt: string
): void {
  const thread = snapshot.thread;
  const key = ledgerKey(thread.subreddit, thread.id);
  const commentIds = flattenThreadComments(thread.comments).map((comment) => comment.id);
  const existing = ledger.get(key);
  const seenCommentIds = mergeSeenCommentIds(existing?.seenCommentIds ?? [], commentIds);
  ledger.set(key, {
    postId: thread.id,
    subreddit: thread.subreddit,
    lastScannedAt: scannedAt,
    commentCount: thread.commentCount,
    seenCommentIds,
    seenPostBody: true
  });
}

export function mergeScanLedgerUpdates(
  existing: readonly RedditScanLedgerEntry[],
  snapshots: readonly RedditConversationSnapshot[],
  scannedAt: string
): RedditScanLedgerEntry[] {
  const map = buildScanLedgerMap(existing);
  for (const snapshot of snapshots) {
    upsertScanLedgerFromSnapshot(map, snapshot, scannedAt);
  }
  return [...map.values()];
}

export function pruneScanLedger(
  entries: readonly RedditScanLedgerEntry[],
  maxEntries: number
): RedditScanLedgerEntry[] {
  const cap = Math.max(100, maxEntries);
  if (entries.length <= cap) {
    return [...entries];
  }
  return [...entries]
    .sort((left, right) => Date.parse(right.lastScannedAt) - Date.parse(left.lastScannedAt))
    .slice(0, cap);
}

function flattenThreadComments(
  comments: readonly RedditThreadState["comments"][number][]
): RedditThreadState["comments"] {
  const flat: RedditThreadState["comments"] = [];
  for (const comment of comments) {
    flat.push(comment);
    if (comment.replies?.length) {
      flat.push(...flattenThreadComments(comment.replies));
    }
  }
  return flat;
}

function mergeSeenCommentIds(existing: readonly string[], fresh: readonly string[]): string[] {
  const merged = [...existing];
  for (const id of fresh) {
    if (!merged.includes(id)) {
      merged.push(id);
    }
  }
  if (merged.length <= MAX_SEEN_COMMENT_IDS_PER_POST) {
    return merged;
  }
  return merged.slice(-MAX_SEEN_COMMENT_IDS_PER_POST);
}
