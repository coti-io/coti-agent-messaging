import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REDDIT_INGESTION_MAX_DISCOVERY_THREAD_READS,
  DEFAULT_REDDIT_INGESTION_MAX_SEARCHES_PER_SUBREDDIT,
  DEFAULT_REDDIT_OPERATING_SEARCH_QUERIES,
  collectDiscoveryExcludePostIds,
  collectOwnThreadTargets,
  qualifiesForOwnThreadParticipation,
  createDiscoveryRng,
  resolveRedditTargetTitle,
  resolveRedditTargetUrl,
  parseRedditThreadUrl,
  pickThreadReadCandidates,
  pickListingPageIndex,
  sampleDiscoverySubreddits,
  selectDiscoverySearchQueries,
  snapshotsToSourceItems
} from "../src/reddit-ingestion.js";
import { buildRedditOperatingAgentConfig, resolveRedditSearchQueries } from "../src/config.js";
import { DEFAULT_REDDIT_DISCOVERY_POOL } from "../src/reddit-outreach.js";
import type { RedditSearchResult } from "../src/reddit-controller.js";
import type { RedditConversationSnapshot } from "../src/reddit-controller.js";

test("reddit operating config defaults discovery pool to ~50 subs and samples 5", () => {
  const previous = process.env.OUTREACH_REDDIT_TARGET_SUBREDDITS;
  const previousPerRun = process.env.OUTREACH_REDDIT_DISCOVERY_SUBS_PER_RUN;
  delete process.env.OUTREACH_REDDIT_TARGET_SUBREDDITS;
  delete process.env.OUTREACH_REDDIT_DISCOVERY_SUBS_PER_RUN;
  try {
    const operating = buildRedditOperatingAgentConfig("/tmp/outreach-agent");
    assert.deepEqual(operating.discoverySubredditPool, [...DEFAULT_REDDIT_DISCOVERY_POOL]);
    assert.equal(operating.discoverySubsPerRun, 5);
    assert.equal(operating.targetSubreddits.includes("sales"), false);
    assert.equal(operating.targetSubreddits.includes("AI_Agents"), true);
  } finally {
    if (previousPerRun === undefined) {
      delete process.env.OUTREACH_REDDIT_DISCOVERY_SUBS_PER_RUN;
    } else {
      process.env.OUTREACH_REDDIT_DISCOVERY_SUBS_PER_RUN = previousPerRun;
    }
    if (previous === undefined) {
      delete process.env.OUTREACH_REDDIT_TARGET_SUBREDDITS;
    } else {
      process.env.OUTREACH_REDDIT_TARGET_SUBREDDITS = previous;
    }
  }
});

test("reddit operating config allows zero own-thread reads", () => {
  const previous = process.env.OUTREACH_REDDIT_INGESTION_MAX_OWN_THREAD_READS;
  process.env.OUTREACH_REDDIT_INGESTION_MAX_OWN_THREAD_READS = "0";
  try {
    const operating = buildRedditOperatingAgentConfig("/tmp/outreach-agent");
    assert.equal(operating.ingestionMaxOwnThreadReads, 0);
  } finally {
    if (previous === undefined) {
      delete process.env.OUTREACH_REDDIT_INGESTION_MAX_OWN_THREAD_READS;
    } else {
      process.env.OUTREACH_REDDIT_INGESTION_MAX_OWN_THREAD_READS = previous;
    }
  }
});

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

test("drafted comments still qualify for own-thread re-read", () => {
  assert.equal(
    qualifiesForOwnThreadParticipation({
      id: "draft-1",
      subreddit: "SaaS",
      kind: "comment",
      content: "draft",
      createdAt: "2026-05-20T10:00:00.000Z",
      status: "drafted",
      threadPostId: "1towpxq"
    }),
    true
  );
});

test("own thread targets include drafted participation threads", () => {
  const targets = collectOwnThreadTargets([
    {
      id: "draft-1",
      subreddit: "SaaS",
      kind: "comment",
      content: "draft",
      createdAt: "2026-05-20T10:00:00.000Z",
      status: "drafted",
      threadPostId: "1towpxq",
      targetUrl: "https://www.reddit.com/r/SaaS/comments/1towpxq/im_shutting_down/"
    }
  ]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.postId, "1towpxq");
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
  const picked = pickThreadReadCandidates(results, 2, { strategy: "top_score" });
  assert.deepEqual(picked.map((item) => item.id), ["high", "mid"]);
});

test("discovery search queries rotate instead of always using the first entry", () => {
  const queries = ["q1", "q2", "q3", "q4", "q5", "q6"];
  const firstRun = selectDiscoverySearchQueries(queries, 2, createDiscoveryRng(11));
  const secondRun = selectDiscoverySearchQueries(queries, 2, createDiscoveryRng(22));
  assert.deepEqual([...new Set(firstRun)].length, firstRun.length);
  assert.notDeepEqual(firstRun, secondRun);
});

test("discovery candidate pick excludes engaged thread posts but not unrelated comment ids", () => {
  const exclude = collectDiscoveryExcludePostIds([
    {
      id: "posted-1",
      subreddit: "SaaS",
      kind: "comment",
      content: "posted",
      createdAt: "2026-05-20T10:00:00.000Z",
      status: "posted",
      threadPostId: "high"
    }
  ]);
  assert.equal(exclude.has("high"), true);
  assert.equal(exclude.has("someone-elses-reply"), false);
});

test("discovery candidate pick skips thread posts already in memory", () => {
  const exclude = collectDiscoveryExcludePostIds([
    {
      id: "posted-1",
      subreddit: "SaaS",
      kind: "comment",
      content: "posted",
      createdAt: "2026-05-20T10:00:00.000Z",
      status: "posted",
      threadPostId: "high"
    }
  ]);
  const picked = pickThreadReadCandidates(
    [
      { id: "high", subreddit: "sales", title: "seen", score: 99 },
      { id: "fresh", subreddit: "sales", title: "new", score: 10 }
    ],
    1,
    { excludePostIds: exclude, strategy: "top_score" }
  );
  assert.deepEqual(picked.map((item) => item.id), ["fresh"]);
});

test("stochastic discovery pick differs from deterministic top-score selection", () => {
  const results = Array.from({ length: 12 }, (_, index) => ({
    id: `post-${index}`,
    subreddit: "sales",
    title: `post ${index}`,
    score: 100 - index
  }));
  const topScore = pickThreadReadCandidates(results, 2, { strategy: "top_score" });
  const stochastic = pickThreadReadCandidates(results, 2, {
    strategy: "stochastic",
    random: createDiscoveryRng(99)
  });
  assert.notDeepEqual(
    stochastic.map((item) => item.id),
    topScore.map((item) => item.id)
  );
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

test("reddit ingestion normalizes t1 parent ids for direct reply detection", () => {
  const snapshots: RedditConversationSnapshot[] = [
    {
      source: "browser",
      capturedAt: "2026-05-19T09:00:00.000Z",
      ownThread: true,
      thread: {
        id: "post-1",
        subreddit: "AI_Agents",
        title: "Agent messaging",
        comments: [
          {
            id: "t1_abc123",
            author: "reddit-user",
            body: "We usually separate transport from policy so agents can rotate keys safely.",
            depth: 0,
            replies: [
              {
                id: "t1_def456",
                author: "peer-user",
                parentId: "t1_abc123",
                body: "Thanks — how do you handle key rotation between agents in practice?",
                depth: 1
              }
            ]
          }
        ]
      }
    }
  ];

  const items = snapshotsToSourceItems(snapshots, [], { venueAccountId: "reddit-user" });
  const peerReply = items.find((item) => item.id === "t1_def456");
  assert.equal(peerReply?.parentId, "abc123");
  assert.equal(peerReply?.replyToOurComment, true);
});

test("reddit ingestion flags direct replies to our comments", () => {
  const snapshots: RedditConversationSnapshot[] = [
    {
      source: "browser",
      capturedAt: "2026-05-19T09:00:00.000Z",
      ownThread: true,
      thread: {
        id: "post-1",
        subreddit: "AI_Agents",
        title: "Agent messaging",
        comments: [
          {
            id: "our-comment",
            author: "reddit-user",
            body: "We usually separate transport from policy so agents can rotate keys safely.",
            depth: 0,
            replies: [
              {
                id: "peer-reply",
                author: "peer-user",
                parentId: "our-comment",
                body: "Thanks — how do you handle key rotation between agents in practice?",
                depth: 1
              }
            ]
          }
        ]
      }
    }
  ];

  const items = snapshotsToSourceItems(snapshots, [], { venueAccountId: "reddit-user" });
  const peerReply = items.find((item) => item.id === "peer-reply");
  assert.equal(peerReply?.replyToOurComment, true);
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

test("sampleDiscoverySubreddits returns unique subs capped at count", () => {
  const pool = ["a", "b", "c", "d", "e", "f"];
  const rng = createDiscoveryRng(42);
  const sampled = sampleDiscoverySubreddits(pool, 5, rng);
  assert.equal(sampled.length, 5);
  assert.equal(new Set(sampled).size, 5);
});

test("pickListingPageIndex favors early pages with seeded rng", () => {
  const rng = createDiscoveryRng(99);
  const counts = [0, 0, 0];
  for (let index = 0; index < 200; index += 1) {
    counts[pickListingPageIndex(rng)]! += 1;
  }
  assert.equal(counts[0]! > counts[1]!, true);
  assert.equal(counts[1]! > counts[2]!, true);
});
