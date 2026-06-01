import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REDDIT_RULES_REGISTRY,
  DEFAULT_REDDIT_TARGETING,
  RedditReadOnlyClient,
  assertRulesRegistryCoversTargets,
  assertTargetingIsViable,
  buildRedditReviewQueue,
  collectPeerThreadCommentBodies,
  evaluateRedditOutcomes,
  hasAgentMessagingTopicMatch,
  hasExplicitHelpIntent,
  parseRedditListing,
  passesDiscoveryTopicalFit,
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
  assert.equal(queue.items[0]?.promptParameters?.layout, "short_hook_then_detail");
  assert.equal(queue.items[0]?.promptParameters?.responseLength, "brief");
  assert.equal(queue.items[0]?.explicitProductInterest, false);
  assert.equal(queue.items[0]?.privateMessageAssessment.shouldEscalate, false);
  assert.equal(queue.items[0]?.publicValueDeliveredFirst, false);
});

test("review queue accepts operational pain even before a direct how-to question", () => {
  const source: RedditSourceItem = {
    id: "thread-pain",
    kind: "post",
    subreddit: "mcp",
    title: "Our agent handoff is broken and the workflow is still manual",
    body: "Sales keeps duplicating records and ops is cleaning spreadsheets every day.",
    commentCount: 16,
    createdUtc: Math.floor(new Date("2026-05-07T08:00:00.000Z").getTime() / 1000),
    onOwnThread: true
  };

  const queue = buildRedditReviewQueue({
    items: [source],
    now: new Date("2026-05-07T09:00:00.000Z")
  });

  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0]?.action, "answer_publicly");
  assert.match(queue.items[0]?.whyRelevant ?? "", /operational pain/i);
});

test("review queue blocks hostile bait threads even when target topics match", () => {
  const source: RedditSourceItem = {
    id: "thread-hostile",
    kind: "post",
    subreddit: "AI_Agents",
    title: "Change my mind: private agent messaging is trash",
    body: "Anyone building this is an idiot bot shill."
  };

  const queue = buildRedditReviewQueue({
    items: [source],
    now: new Date("2026-05-07T09:00:00.000Z")
  });

  assert.equal(queue.items.length, 0);
  assert.equal(queue.ignored[0]?.gates.some((gate) => gate.id === "low_argument_risk" && !gate.passed), true);
});

test("review queue marks PM escalation as justified only for sensitive troubleshooting", () => {
  const source: RedditSourceItem = {
    id: "thread-pm",
    kind: "comment",
    subreddit: "LangChain",
    title: "LangChain agent messaging thread",
    body:
      "My agent messaging integration is failing after we rotated the API key and the session id mismatch keeps showing in the logs."
  };

  const queue = buildRedditReviewQueue({
    items: [source],
    now: new Date("2026-05-07T09:00:00.000Z")
  });

  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0]?.privateMessageAssessment.shouldEscalate, true);
  assert.equal(queue.items[0]?.privateMessageAssessment.reason, "credentials_or_secrets");
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

test("review queue blocks near-duplicate drafted outbound on the same thread", () => {
  const source: RedditSourceItem = {
    id: "post-1",
    kind: "post",
    subreddit: "AI_Agents",
    title: "How should agents coordinate private messages across MCP tools?",
    body: "What should live in the tool layer versus the agent policy?",
    threadPostId: "post-1"
  };
  const draft = buildRedditReviewQueue({
    items: [source],
    now: new Date("2026-05-27T09:00:00.000Z")
  }).items[0]?.draft;
  assert.ok(draft);

  const queue = buildRedditReviewQueue({
    items: [source],
    duplicateCheckPolicy: "block_all_outbound",
    history: [
      {
        id: "draft:post-1:1",
        subreddit: "AI_Agents",
        kind: "comment",
        content: draft,
        createdAt: "2026-05-27T09:00:00.000Z",
        firstReply: true,
        status: "drafted",
        threadPostId: "post-1"
      }
    ],
    now: new Date("2026-05-27T10:00:00.000Z")
  });

  assert.equal(queue.items.length, 0);
  assert.equal(
    queue.ignored[0]?.gates.some((gate) => gate.id === "not_near_duplicate" && !gate.passed),
    true
  );
});

test("substantive agent-messaging comment without question mark counts as help intent", () => {
  const source: RedditSourceItem = {
    id: "comment-1",
    kind: "comment",
    subreddit: "mcp",
    title: "MCP gateway patterns",
    body:
      "We are building a private MCP channel for multi-agent coordination and encrypted agent-to-agent messaging between services."
  };

  assert.equal(hasExplicitHelpIntent(source), true);
});

test("rhetorical title question alone does not count as help intent", () => {
  const source: RedditSourceItem = {
    id: "thread-rant",
    kind: "post",
    subreddit: "AI_Agents",
    title: "Anyone else hang up when the receptionist is AI?",
    body: "When I get one I just hang up. I have absolutely no patience for it."
  };

  assert.equal(hasExplicitHelpIntent(source), false);
});

test("discovery threads without topical fit are blocked", () => {
  const source: RedditSourceItem = {
    id: "thread-rant",
    kind: "post",
    subreddit: "AI_Agents",
    title: "Anyone else hang up when the receptionist is AI?",
    body: "When I get one I just hang up.",
    onOwnThread: false
  };

  const queue = buildRedditReviewQueue({
    items: [source],
    now: new Date("2026-05-27T10:00:00.000Z")
  });

  assert.equal(queue.items.length, 0);
  assert.equal(
    queue.ignored[0]?.gates.some((gate) => gate.id === "discovery_topical_fit" && !gate.passed),
    true
  );
});

test("discovery threads with agent-messaging topics can pass", () => {
  const source: RedditSourceItem = {
    id: "thread-agent",
    kind: "post",
    subreddit: "AI_Agents",
    title: "How are you handling private agent messaging over MCP?",
    body: "Looking for patterns for encrypted agent-to-agent coordination with our AI agents SDK.",
    onOwnThread: false,
    commentCount: 20,
    createdUtc: Math.floor(new Date("2026-05-27T09:00:00.000Z").getTime() / 1000)
  };

  assert.equal(hasAgentMessagingTopicMatch(`${source.title}\n${source.body}`), true);
  assert.equal(
    passesDiscoveryTopicalFit({
      discoveryThread: true,
      topicalMatch: true,
      relevanceScore: 4
    }),
    true
  );

  const queue = buildRedditReviewQueue({
    items: [source],
    now: new Date("2026-05-27T10:00:00.000Z")
  });

  assert.equal(queue.items.length, 1);
});

test("collectPeerThreadCommentBodies returns other comments on the same thread", () => {
  const threadPostId = "post-1";
  const source: RedditSourceItem = {
    id: "post-1",
    kind: "post",
    subreddit: "AI_Agents",
    title: "Thread",
    body: "Question?",
    threadPostId
  };
  const peerBody =
    "Short answer: duplicate CRM records usually mean ownership rules are unclear across sales and ops.";
  const peers = collectPeerThreadCommentBodies(source, [
    source,
    {
      id: "comment-1",
      kind: "comment",
      subreddit: "AI_Agents",
      title: "Thread",
      parentTitle: "Thread",
      body: peerBody,
      threadPostId
    }
  ]);

  assert.deepEqual(peers, [peerBody]);
  assert.ok(
    textSimilarity(
      "Short answer: duplicate CRM records usually mean ownership rules are unclear across sales teams.",
      peerBody
    ) >= 0.55
  );
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
        status: "spam_filtered"
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
      },
      {
        id: "comment-5",
        subreddit: "LangChain",
        kind: "comment",
        content: "DM me and I can help debug it.",
        createdAt: "2026-05-07T12:30:00.000Z",
        publicValueDeliveredFirst: false,
        status: "posted"
      }
    ],
    new Date("2026-05-07T13:00:00.000Z")
  );

  assert.equal(summary.firstReplyPromotionViolations, 1);
  assert.equal(summary.removals, 1);
  assert.equal(summary.spamAccusations, 1);
  assert.equal(summary.lowValuePrivateMessagePrompts, 1);
  assert.equal(summary.killReasons.length >= 3, true);
  assert.match(summary.killReasons.join(" "), /first reply|spam|hidden replies|private-message/i);
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

test("Reddit read-only client can read hot listings", async () => {
  const client = new RedditReadOnlyClient({
    accessToken: "token",
    userAgent: "test-agent",
    baseUrl: "https://oauth.reddit.test",
    fetchImpl: async (input) => {
      const url = new URL(input instanceof URL ? input.toString() : String(input));
      assert.equal(url.pathname, "/r/sales/hot.json");
      return new Response(
        JSON.stringify({
          data: {
            children: [
              {
                kind: "t3",
                data: {
                  id: "hot-1",
                  subreddit: "sales",
                  title: "Why does CRM hygiene always regress?",
                  selftext: "Looking for operator advice."
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

  const posts = await client.getHotPosts("sales", 5);
  assert.equal(posts[0]?.id, "hot-1");
  assert.equal(posts[0]?.title, "Why does CRM hygiene always regress?");
});
