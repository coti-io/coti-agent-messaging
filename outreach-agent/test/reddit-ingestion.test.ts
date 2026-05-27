import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REDDIT_INGESTION_MAX_DISCOVERY_THREAD_READS,
  DEFAULT_REDDIT_INGESTION_MAX_SEARCHES_PER_SUBREDDIT,
  DEFAULT_REDDIT_OPERATING_SEARCH_QUERIES,
  collectOwnThreadTargets,
  resolveRedditTargetTitle,
  resolveRedditTargetUrl,
  parseRedditThreadUrl,
  pickThreadReadCandidates,
  snapshotsToSourceItems
} from "../src/reddit-ingestion.js";
import { buildRedditOperatingAgentConfig, resolveRedditSearchQueries } from "../src/config.js";
import type { RedditSearchResult } from "../src/reddit-controller.js";
import type { RedditConversationSnapshot } from "../src/reddit-controller.js";

test("reddit operating config enables discovery and search by default", () => {
  const previousDiscovery = process.env.OUTREACH_REDDIT_INGESTION_MAX_DISCOVERY_THREAD_READS;
  const previousSearch = process.env.OUTREACH_REDDIT_INGESTION_MAX_SEARCHES_PER_SUBREDDIT;
  const previousQueries = process.env.OUTREACH_REDDIT_SEARCH_QUERIES;
  delete process.env.OUTREACH_REDDIT_INGESTION_MAX_DISCOVERY_THREAD_READS;
  delete process.env.OUTREACH_REDDIT_INGESTION_MAX_SEARCHES_PER_SUBREDDIT;
  delete process.env.OUTREACH_REDDIT_SEARCH_QUERIES;
  try {
    const operating = buildRedditOperatingAgentConfig("/tmp/outreach-agent");
    assert.equal(operating.ingestionMaxDiscoveryThreadReads, DEFAULT_REDDIT_INGESTION_MAX_DISCOVERY_THREAD_READS);
    assert.equal(operating.ingestionMaxSearchesPerSubreddit, DEFAULT_REDDIT_INGESTION_MAX_SEARCHES_PER_SUBREDDIT);
    assert.deepEqual(operating.searchQueries, [...DEFAULT_REDDIT_OPERATING_SEARCH_QUERIES]);
    assert.equal(resolveRedditSearchQueries(undefined).length > 0, true);
  } finally {
    if (previousDiscovery === undefined) {
      delete process.env.OUTREACH_REDDIT_INGESTION_MAX_DISCOVERY_THREAD_READS;
    } else {
      process.env.OUTREACH_REDDIT_INGESTION_MAX_DISCOVERY_THREAD_READS = previousDiscovery;
    }
    if (previousSearch === undefined) {
      delete process.env.OUTREACH_REDDIT_INGESTION_MAX_SEARCHES_PER_SUBREDDIT;
    } else {
      process.env.OUTREACH_REDDIT_INGESTION_MAX_SEARCHES_PER_SUBREDDIT = previousSearch;
    }
    if (previousQueries === undefined) {
      delete process.env.OUTREACH_REDDIT_SEARCH_QUERIES;
    } else {
      process.env.OUTREACH_REDDIT_SEARCH_QUERIES = previousQueries;
    }
  }
});

test("resolveRedditTargetUrl and title normalize permalink and post references", () => {
  assert.equal(
    resolveRedditTargetUrl({
      id: "1towpxq",
      kind: "post",
      subreddit: "SaaS",
      permalink: "/r/SaaS/comments/1towpxq/im_shutting_down/"
    }),
    "https://www.reddit.com/r/SaaS/comments/1towpxq/im_shutting_down/"
  );
  assert.equal(
    resolveRedditTargetTitle({
      title: "Shutdown postmortem",
      parentTitle: "ignored"
    }),
    "Shutdown postmortem"
  );
});

test("reddit ingestion collects own thread targets from memory urls", () => {
  const targets = collectOwnThreadTargets([
    {
      id: "1",
      subreddit: "sales",
      kind: "reply",
      content: "thanks",
      createdAt: "2026-05-20T10:00:00.000Z",
      status: "posted",
      targetId: "t1_abc",
      remoteContentUrl: "https://www.reddit.com/r/sales/comments/post123/title/comment/abc/"
    }
  ]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.postId, "post123");
  assert.equal(targets[0]?.subreddit, "sales");
  assert.deepEqual(parseRedditThreadUrl("/r/SaaS/comments/xyz9/foo/"), {
    subreddit: "SaaS",
    postId: "xyz9"
  });
});

test("reddit ingestion collects own thread targets from targetUrl on drafts", () => {
  const targets = collectOwnThreadTargets([
    {
      id: "draft-1",
      subreddit: "SaaS",
      kind: "comment",
      content: "draft",
      createdAt: "2026-05-20T10:00:00.000Z",
      status: "posted",
      threadPostId: "1towpxq",
      targetUrl: "https://www.reddit.com/r/SaaS/comments/1towpxq/im_shutting_down/"
    }
  ]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.postId, "1towpxq");
  assert.equal(targets[0]?.subreddit, "SaaS");
});

test("reddit ingestion ranks hot candidates and caps thread reads", () => {
  const results: RedditSearchResult[] = [
    { id: "low", subreddit: "sales", title: "low", score: 2 },
    { id: "high", subreddit: "sales", title: "high", score: 99 },
    { id: "mid", subreddit: "SaaS", title: "mid", score: 40 }
  ];
  const picked = pickThreadReadCandidates(results, 2);
  assert.deepEqual(picked.map((item) => item.id), ["high", "mid"]);
});

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

test("reddit ingestion keeps short replies on our own threads", () => {
  const snapshots: RedditConversationSnapshot[] = [
    {
      source: "browser",
      capturedAt: "2026-05-19T09:00:00.000Z",
      ownThread: true,
      thread: {
        id: "post-1",
        subreddit: "sales",
        title: "Our post",
        comments: [
          {
            id: "comment-1",
            body: "Can you clarify?",
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
      kind: "comment",
      content: "we posted",
      createdAt: "2026-05-19T08:00:00.000Z",
      status: "posted",
      targetId: "post-1",
      threadPostId: "post-1"
    }
  ]);
  assert.deepEqual(items.map((item) => item.id), ["comment-1"]);
  assert.equal(items[0]?.onOwnThread, true);
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
