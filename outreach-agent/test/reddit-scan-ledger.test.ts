import test from "node:test";
import assert from "node:assert/strict";

import type { RedditConversationSnapshot } from "../src/reddit-controller.js";
import {
  buildScanLedgerMap,
  collectScanLedgerExcludePostIds,
  mergeScanLedgerUpdates,
  pruneScanLedger,
  shouldSkipColdDiscoveryRead
} from "../src/reddit-scan-ledger.js";
import { snapshotsToSourceItems } from "../src/reddit-ingestion.js";

test("shouldSkipColdDiscoveryRead respects ttl and comment count", () => {
  const now = new Date("2026-06-01T12:00:00.000Z");
  const entry = {
    postId: "abc123",
    subreddit: "mcp",
    lastScannedAt: "2026-06-01T10:00:00.000Z",
    commentCount: 5,
    seenCommentIds: ["c1"]
  };
  assert.equal(shouldSkipColdDiscoveryRead(entry, now, 48, 5), true);
  assert.equal(shouldSkipColdDiscoveryRead(entry, now, 48, 6), false);
  assert.equal(shouldSkipColdDiscoveryRead(entry, new Date("2026-06-05T12:00:00.000Z"), 48, 5), false);
});

test("collectScanLedgerExcludePostIds returns cold-skip ids", () => {
  const now = new Date("2026-06-01T12:00:00.000Z");
  const ids = collectScanLedgerExcludePostIds(
    [
      {
        postId: "a",
        subreddit: "mcp",
        lastScannedAt: "2026-06-01T11:00:00.000Z",
        commentCount: 2,
        seenCommentIds: []
      }
    ],
    now,
    48
  );
  assert.deepEqual([...ids], ["a"]);
});

test("mergeScanLedgerUpdates records seen comment ids", () => {
  const snapshot: RedditConversationSnapshot = {
    capturedAt: "2026-06-01T12:00:00.000Z",
    source: "unofficial",
    ownThread: false,
    thread: {
      id: "post1",
      subreddit: "mcp",
      title: "help",
      body: "need agent messaging",
      author: "user",
      comments: [
        {
          id: "c1",
          body: "a".repeat(50),
          author: "other",
          parentId: "t3_post1",
          depth: 0
        }
      ]
    }
  };
  const ledger = mergeScanLedgerUpdates([], [snapshot], snapshot.capturedAt);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.seenCommentIds.includes("c1"), true);
  assert.equal(ledger[0]?.seenPostBody, true);
});

test("snapshotsToSourceItems filters previously seen comments via scan ledger", () => {
  const snapshot: RedditConversationSnapshot = {
    capturedAt: "2026-06-01T12:00:00.000Z",
    source: "unofficial",
    ownThread: false,
    thread: {
      id: "post1",
      subreddit: "mcp",
      title: "help",
      body: "need agent messaging",
      author: "user",
      commentCount: 2,
      comments: [
        {
          id: "c1",
          body: "a".repeat(50),
          author: "other",
          parentId: "t3_post1",
          depth: 0
        },
        {
          id: "c2",
          body: "b".repeat(50),
          author: "other2",
          parentId: "t3_post1",
          depth: 0
        }
      ]
    }
  };
  const ledger = mergeScanLedgerUpdates([], [snapshot], snapshot.capturedAt);
  const map = buildScanLedgerMap(ledger);
  const items = snapshotsToSourceItems([snapshot], [], { scanLedgerMap: map });
  assert.equal(items.some((item) => item.id === "c1"), false);
  assert.equal(items.some((item) => item.id === "c2"), false);
});

test("pruneScanLedger keeps newest entries", () => {
  const entries = Array.from({ length: 120 }, (_, index) => ({
    postId: `p${index}`,
    subreddit: "mcp",
    lastScannedAt: new Date(Date.UTC(2020, 0, index + 1)).toISOString(),
    seenCommentIds: [] as string[]
  }));
  const pruned = pruneScanLedger(entries, 100);
  assert.equal(pruned.length, 100);
  assert.equal(pruned[0]?.postId, "p119");
});
