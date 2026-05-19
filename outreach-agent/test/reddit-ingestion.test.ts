import test from "node:test";
import assert from "node:assert/strict";

import { snapshotsToSourceItems } from "../src/reddit-ingestion.js";
import type { RedditConversationSnapshot } from "../src/reddit-controller.js";

test("reddit ingestion converts thread comments before post source items", () => {
  const snapshots: RedditConversationSnapshot[] = [
    {
      source: "browser",
      capturedAt: "2026-05-19T09:00:00.000Z",
      thread: {
        id: "post-1",
        subreddit: "sales",
        title: "CRM messy data",
        body: "How do you fix duplicate CRM records?",
        permalink: "/r/sales/comments/post-1/crm/",
        commentCount: 2,
        comments: [
          {
            id: "comment-1",
            body: "We keep breaking handoffs because reps update the wrong fields. Any advice on cleaning this up?",
            permalink: "/r/sales/comments/post-1/_/comment-1/",
            depth: 0
          }
        ]
      }
    }
  ];

  const items = snapshotsToSourceItems(snapshots);
  assert.equal(items[0]?.kind, "comment");
  assert.equal(items[0]?.id, "comment-1");
  assert.equal(items[1]?.kind, "post");
});

test("reddit ingestion skips already-touched source targets", () => {
  const snapshots: RedditConversationSnapshot[] = [
    {
      source: "browser",
      capturedAt: "2026-05-19T09:00:00.000Z",
      thread: {
        id: "post-1",
        subreddit: "sales",
        title: "CRM messy data",
        comments: [
          {
            id: "comment-1",
            body: "This manual workflow keeps failing and creating duplicate CRM records.",
            depth: 0
          }
        ]
      }
    }
  ];

  const items = snapshotsToSourceItems(snapshots, [
    {
      id: "old",
      subreddit: "sales",
      kind: "reply",
      content: "old",
      createdAt: "2026-05-19T08:00:00.000Z",
      targetId: "comment-1"
    }
  ]);
  assert.deepEqual(items.map((item) => item.id), ["post-1"]);
});
