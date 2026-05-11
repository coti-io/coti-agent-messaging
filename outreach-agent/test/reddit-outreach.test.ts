import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REDDIT_RULES_REGISTRY,
  DEFAULT_REDDIT_TARGETING,
  RedditReadOnlyClient,
  assertRulesRegistryCoversTargets,
  assertTargetingIsViable,
  buildRedditReviewQueue,
  evaluateRedditOutcomes,
  parseRedditListing,
  textSimilarity,
  type RedditOutboundMemoryEntry,
  type RedditSourceItem
} from "../src/reddit-outreach.js";

test("default Reddit targeting defines a viable audience and covered rules registry", () => {
  assert.doesNotThrow(() => assertTargetingIsViable(DEFAULT_REDDIT_TARGETING));
  assert.doesNotThrow(() =>
    assertRulesRegistryCoversTargets(DEFAULT_REDDIT_TARGETING, DEFAULT_REDDIT_RULES_REGISTRY)
  );
  assert.equal(DEFAULT_REDDIT_TARGETING.targetSubreddits.length >= 10, true);
  assert.equal(DEFAULT_REDDIT_TARGETING.targetSubreddits.length <= 30, true);
});

test("review queue generates only non-promotional explanatory first replies", () => {
  const source: RedditSourceItem = {
    id: "thread-1",
    kind: "post",
    subreddit: "AI_Agents",
    title: "How should AI agents coordinate private messages across MCP tools?",
    body: "I am trying to design agent-to-agent messaging without leaking every detail publicly. What architecture works best?"
  };

  const queue = buildRedditReviewQueue({
    items: [
      source,
      {
        id: "thread-2",
        kind: "post",
        subreddit: "AI_Agents",
        title: "Agent hype is everywhere",
        body: "Just sharing a general thought."
      }
    ],
    now: new Date("2026-05-07T09:00:00.000Z")
  });

  assert.equal(queue.items.length, 1);
  assert.equal(queue.ignored.length, 1);
  assert.equal(queue.items[0]?.source.id, "thread-1");
  assert.equal(queue.items[0]?.approvalRequired, true);
  assert.match(queue.items[0]?.draft ?? "", /transport layer|integration|infrastructure/i);
  assert.doesNotMatch(queue.items[0]?.draft ?? "", /coti|web4|https?:|dm me|sign up/i);
  assert.equal(
    queue.items[0]?.gates.some((gate) => gate.id === "human_review_required" && !gate.passed),
    true
  );
});

test("review queue blocks near-duplicate outbound comments", () => {
  const source: RedditSourceItem = {
    id: "thread-1",
    kind: "post",
    subreddit: "AI_Agents",
    title: "How should agents coordinate over MCP tools?",
    body: "What should be in the tool layer versus the agent policy?"
  };
  const previous = buildRedditReviewQueue({
    items: [source],
    now: new Date("2026-05-07T09:00:00.000Z")
  }).items[0]?.draft;
  assert.ok(previous);

  const history: RedditOutboundMemoryEntry[] = [
    {
      id: "comment-previous",
      subreddit: "AI_Agents",
      kind: "comment",
      content: previous,
      createdAt: "2026-05-06T09:00:00.000Z",
      firstReply: true,
      status: "posted"
    }
  ];
  const queue = buildRedditReviewQueue({
    items: [source],
    history,
    now: new Date("2026-05-07T09:00:00.000Z")
  });

  assert.equal(queue.items.length, 0);
  assert.equal(queue.ignored[0]?.status, "blocked");
  assert.equal(
    queue.ignored[0]?.gates.some((gate) => gate.id === "not_near_duplicate" && !gate.passed),
    true
  );
  assert.equal(textSimilarity(previous, previous), 1);
});

test("outcome evaluation surfaces kill criteria", () => {
  const summary = evaluateRedditOutcomes(
    [
      {
        id: "comment-1",
        subreddit: "AI_Agents",
        kind: "comment",
        content: "COTI can help, sign up here",
        createdAt: "2026-05-07T09:00:00.000Z",
        firstReply: true,
        productMentioned: true,
        status: "posted"
      },
      {
        id: "comment-2",
        subreddit: "AI_Agents",
        kind: "comment",
        content: "Explanatory reply",
        createdAt: "2026-05-07T10:00:00.000Z",
        firstReply: true,
        status: "removed"
      },
      {
        id: "comment-3",
        subreddit: "AI_Agents",
        kind: "comment",
        content: "Another explanatory reply",
        createdAt: "2026-05-07T11:00:00.000Z",
        firstReply: true,
        status: "mod_warning"
      },
      {
        id: "comment-4",
        subreddit: "LocalLLaMA",
        kind: "comment",
        content: "Explanatory reply",
        createdAt: "2026-05-07T12:00:00.000Z",
        firstReply: true,
        status: "spam_accusation"
      }
    ],
    new Date("2026-05-07T13:00:00.000Z")
  );

  assert.equal(summary.firstReplyPromotionViolations, 1);
  assert.equal(summary.spamAccusations, 1);
  assert.equal(summary.killReasons.length >= 3, true);
  assert.match(summary.killReasons.join(" "), /first reply|spam|Repeated mod/i);
});

test("Reddit read-only client maps OAuth listing responses", async () => {
  const client = new RedditReadOnlyClient({
    accessToken: "token",
    userAgent: "test-agent",
    baseUrl: "https://oauth.reddit.test",
    fetchImpl: async (input, init) => {
      const url = new URL(input instanceof URL ? input.toString() : String(input));
      assert.equal(url.pathname, "/r/AI_Agents/new.json");
      assert.equal(init?.method, "GET");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer token");
      return new Response(
        JSON.stringify({
          data: {
            children: [
              {
                kind: "t3",
                data: {
                  id: "abc",
                  subreddit: "AI_Agents",
                  title: "How do agents coordinate private messages?",
                  selftext: "Looking for design advice.",
                  author: "builder",
                  created_utc: 1778160000
                }
              }
            ]
          }
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
  });

  const posts = await client.getNewPosts("AI_Agents", 5);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts, parseRedditListing({ posts }));
  assert.equal(posts[0]?.id, "abc");
  assert.equal(posts[0]?.subreddit, "AI_Agents");
});
