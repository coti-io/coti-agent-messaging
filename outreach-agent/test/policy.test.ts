import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_OUTREACH_STATE_BYTES,
  assessPrivateMessageEscalation,
  applyActionResult,
  canCreatePost,
  commentMinimumIntervalMs,
  chooseReplyTarget,
  createInitialState,
  getDailyCommentBreakdown,
  getEngagementSummary,
  getCommentReadiness,
  getPostReadiness,
  normalizeState,
  planHeartbeatActions,
  selectFollowCandidatesFromComments,
  type OutreachAgentState
} from "../src/policy.js";
import type { ProductFactSheet } from "../src/product-facts.js";

const factSheet: ProductFactSheet = {
  claims: [
    {
      id: "private-bodies-public-routing",
      headline: "Private message bodies, simple routing",
      detail: "Message bodies are encrypted while routing metadata stays public.",
      sourcePaths: ["docs/overview.md"],
      evidence: ["The message body is encrypted"],
      emphasis: "primary"
    },
    {
      id: "agent-ready-integration",
      headline: "Agent-ready integration surface",
      detail: "The repo exposes SDK helpers and an MCP-compatible tool surface.",
      sourcePaths: ["docs/mcp.md"],
      evidence: ["sending encrypted messages"],
      emphasis: "primary"
    },
    {
      id: "reward-epochs",
      headline: "Funded reward epochs",
      detail: "Rewards are funded in native COTI and tied to encrypted cell usage.",
      sourcePaths: ["docs/rewards.md"],
      evidence: ["Reward usage is counted by encrypted cell count"],
      emphasis: "bonus"
    },
    {
      id: "pull-based-ops",
      headline: "Pull-based claims",
      detail: "Claims are intentionally pull-based.",
      sourcePaths: ["docs/rewards.md"],
      evidence: ["This is intentionally pull-based"],
      emphasis: "secondary"
    }
  ],
  liveSnapshot: {}
};

test("heartbeat planning prioritizes replies before outreach posts", () => {
  const actions = planHeartbeatActions({
    home: {
      your_account: { name: "OutreachBot" },
      activity_on_your_posts: [
        {
          post_id: "post-1",
          post_title: "Why agents need private inboxes",
          new_notification_count: 2
        }
      ]
    },
    exploreFeed: {
      posts: [
        {
          id: "post-2",
          title: "Private agent coordination is hard",
          content_preview: "Talking about messaging and MCP integration.",
          author_name: "HelperBot"
        }
      ]
    },
    state: createInitialState(),
    factSheet,
    now: new Date("2026-03-11T12:00:00.000Z")
  });

  assert.equal(actions[0]?.type, "reply_to_activity");
  assert.equal(actions.some((action) => action.type === "create_post"), false);
});

test("private-message escalation stays off when a public answer is enough", () => {
  const assessment = assessPrivateMessageEscalation({
    text: "How should I structure private agent messaging without exposing payloads publicly?"
  });

  assert.equal(assessment.shouldEscalate, false);
  assert.equal(assessment.requiresPublicReplyFirst, true);
});

test("private-message escalation allows sensitive account debugging", () => {
  const assessment = assessPrivateMessageEscalation({
    text: "My account is failing after I rotate the API key and now the logs show a session mismatch."
  });

  assert.equal(assessment.shouldEscalate, true);
  assert.equal(assessment.reason, "credentials_or_secrets");
  assert.equal(assessment.requiresPublicReplyFirst, false);
});

test("heartbeat planning skips external posts we already commented on", () => {
  const actions = planHeartbeatActions({
    home: {
      your_account: { name: "OutreachBot" },
      activity_on_your_posts: [],
      your_direct_messages: { pending_request_count: 0, unread_message_count: 0 },
      posts_from_accounts_you_follow: { posts: [] }
    },
    exploreFeed: {
      posts: [
        {
          id: "post-2",
          title: "Private coordination needs continuity",
          content_preview: "Track record only matters if counterparties persist.",
          author_name: "SignalFoundry",
          upvotes: 7
        }
      ]
    },
    state: {
      ...createInitialState(),
      repliedCommentIds: ["post:post-2"]
    },
    factSheet,
    now: new Date("2026-03-11T12:00:00.000Z")
  });

  assert.equal(actions.some((action) => action.type === "comment_on_post"), false);
});

test("heartbeat planning reads hot feed opportunities before deciding to noop", () => {
  const actions = planHeartbeatActions({
    home: {
      your_account: { name: "OutreachBot" },
      activity_on_your_posts: [],
      your_direct_messages: { pending_request_count: 0, unread_message_count: 0 },
      posts_from_accounts_you_follow: { posts: [] }
    },
    hotFeed: {
      posts: [
        {
          id: "hot-post-1",
          title: "Private agent workflow keeps breaking customer handoffs",
          content_preview: "Duplicate CRM records are eating our week and the MCP integration still has no clear owner.",
          author_name: "OpsBot",
          upvotes: 22
        }
      ]
    },
    state: createInitialState(),
    factSheet,
    now: new Date("2026-03-11T12:00:00.000Z")
  });

  assert.equal(actions.some((action) => action.type === "comment_on_post"), true);
});

test("recent posts block new post creation during cooldown", () => {
  const state: OutreachAgentState = {
    ...createInitialState(),
    lastPostAt: "2026-03-11T11:50:00.000Z"
  };

  assert.equal(canCreatePost(state, false, undefined, new Date("2026-03-11T12:00:00.000Z")), false);
});

test("daily post cap blocks new post creation once the limit is reached", () => {
  const state: OutreachAgentState = {
    ...createInitialState(),
    dailyPostDate: "2026-03-11",
    dailyPostCount: 2,
    lastPostAt: "2026-03-11T10:00:00.000Z"
  };

  assert.equal(
    canCreatePost(
      state,
      false,
      {
        commentLimitNewAgentPerDay: 30,
        commentLimitEstablishedPerDay: 100,
        postLimitNewAgentPerDay: 2,
        postLimitEstablishedPerDay: 2
      },
      new Date("2026-03-11T12:00:00.000Z")
    ),
    false
  );
});

test("post readiness reports explicit daily usage", () => {
  const readiness = getPostReadiness(
    {
      ...createInitialState(),
      dailyPostDate: "2026-03-11",
      dailyPostCount: 1
    },
    false,
    {
      commentLimitNewAgentPerDay: 30,
      commentLimitEstablishedPerDay: 50,
      postLimitNewAgentPerDay: 1,
      postLimitEstablishedPerDay: 1
    },
    new Date("2026-03-11T12:00:00.000Z")
  );

  assert.equal(readiness.allowed, false);
  assert.equal(readiness.reason, "daily_limit");
  assert.equal(readiness.usedCount, 1);
  assert.equal(readiness.limitPerDay, 1);
});

test("comment readiness paces authored replies across the remaining day", () => {
  const now = new Date("2026-03-11T12:10:00.000Z");
  const state: OutreachAgentState = {
    ...createInitialState(),
    dailyCommentDate: "2026-03-11",
    dailyCommentCount: 1,
    lastCommentAt: "2026-03-11T12:00:00.000Z"
  };

  const readiness = getCommentReadiness(state, false, undefined, now);

  assert.equal(readiness.allowed, false);
  assert.equal(readiness.reason, "paced_cooldown");
  assert.equal(readiness.usedCount, 1);
  assert.equal(readiness.limitPerDay, 50);
  assert.equal(commentMinimumIntervalMs(state, false, undefined, now) > 10 * 60 * 1_000, true);
});

test("applyActionResult tracks top-level comments and replies separately", () => {
  const now = new Date("2026-03-11T12:10:00.000Z");
  let state = applyActionResult(
    createInitialState(),
    {
      type: "comment",
      commentId: "comment-1",
      content: "Top-level comment"
    },
    now
  );
  state = applyActionResult(
    state,
    {
      type: "comment",
      commentId: "reply-1",
      content: "Reply",
      replyToAuthor: "BuilderBot"
    },
    now
  );

  assert.deepEqual(getDailyCommentBreakdown(state), {
    total: 2,
    topLevelComments: 1,
    replies: 1
  });
});

test("engagement summary tracks rolling windows and totals", () => {
  const now = new Date("2026-03-11T12:00:00.000Z");
  let state = applyActionResult(
    createInitialState(),
    {
      type: "create_post",
      fingerprint: "post-fingerprint",
      title: "Post",
      content: "Post content",
      createdAt: "2026-03-11T11:00:00.000Z"
    },
    now
  );
  state = applyActionResult(
    state,
    {
      type: "comment",
      commentId: "comment-1",
      content: "Comment",
      createdAt: "2026-03-10T13:00:00.000Z"
    },
    now
  );
  state = applyActionResult(
    state,
    {
      type: "comment",
      commentId: "reply-1",
      content: "Reply",
      replyToAuthor: "BuilderBot",
      createdAt: "2026-03-05T12:00:00.000Z"
    },
    now
  );
  state = applyActionResult(state, { type: "upvote_post", postId: "post-1" }, now);
  state = applyActionResult(state, { type: "follow_agent", agentName: "BuilderBot" }, now);

  const summary = getEngagementSummary(state, now);

  assert.deepEqual(summary.windows.last2Hours, {
    posts: 1,
    comments: 0,
    replies: 0,
    upvotes: 1,
    follows: 1,
    total: 3
  });
  assert.deepEqual(summary.windows.lastDay, {
    posts: 1,
    comments: 1,
    replies: 0,
    upvotes: 1,
    follows: 1,
    total: 4
  });
  assert.deepEqual(summary.windows.lastWeek, {
    posts: 1,
    comments: 1,
    replies: 1,
    upvotes: 1,
    follows: 1,
    total: 5
  });
  assert.deepEqual(summary.total, summary.windows.lastWeek);
});

test("recovering an older comment does not inflate today's comment cap", () => {
  const now = new Date("2026-03-11T12:10:00.000Z");
  const state = applyActionResult(
    createInitialState(),
    {
      type: "comment",
      commentId: "old-comment",
      content: "Recovered old comment",
      createdAt: "2026-03-10T23:55:00.000Z"
    },
    now
  );

  assert.deepEqual(getDailyCommentBreakdown(state), {
    total: 0,
    topLevelComments: 0,
    replies: 0
  });
  assert.equal(state.lastCommentAt, "2026-03-10T23:55:00.000Z");
});

test("custom policy config overrides the default daily comment cap", () => {
  const now = new Date("2026-03-11T12:10:00.000Z");
  const state: OutreachAgentState = {
    ...createInitialState(),
    dailyCommentDate: "2026-03-11",
    dailyCommentCount: 80,
    lastCommentAt: "2026-03-11T04:35:26.922Z"
  };

  const readiness = getCommentReadiness(
    state,
    false,
    {
      commentLimitNewAgentPerDay: 30,
      commentLimitEstablishedPerDay: 100
    },
    now
  );

  assert.equal(readiness.allowed, true);
});

test("planning does not auto-plan create_post when comment daily cap is exhausted", () => {
  const now = new Date("2026-03-11T12:10:00.000Z");
  const state: OutreachAgentState = {
    ...createInitialState(),
    dailyCommentDate: "2026-03-11",
    dailyCommentCount: 50,
    lastCommentAt: "2026-03-11T04:35:26.922Z"
  };

  const actions = planHeartbeatActions({
    home: {
      your_account: { name: "OutreachBot" },
      activity_on_your_posts: [
        {
          post_id: "post-1",
          post_title: "Why agents need private inboxes",
          new_notification_count: 1
        }
      ],
      your_direct_messages: { pending_request_count: 0, unread_message_count: 0 },
      posts_from_accounts_you_follow: { posts: [] }
    },
    exploreFeed: {
      posts: []
    },
    state,
    factSheet,
    now
  });

  assert.equal(actions.some((action) => action.type === "reply_to_activity"), true);
  assert.equal(actions.some((action) => action.type === "create_post"), false);
});

test("planning defers posts when external network opportunities exist", () => {
  const actions = planHeartbeatActions({
    home: {
      your_account: { name: "OutreachBot" },
      activity_on_your_posts: [],
      your_direct_messages: { pending_request_count: 0, unread_message_count: 0 },
      posts_from_accounts_you_follow: { posts: [] }
    },
    exploreFeed: {
      posts: [
        {
          id: "post-2",
          post_id: "post-2",
          title: "Private agent coordination needs MCP inboxes",
          content_preview: "Messaging SDK integration and private workflow coordination.",
          author_name: "BuilderBot"
        }
      ]
    },
    state: createInitialState(),
    factSheet,
    now: new Date("2026-03-11T12:10:00.000Z")
  });

  assert.equal(actions.some((action) => action.type === "upvote_post"), true);
  assert.equal(actions.some((action) => action.type === "follow_agent"), true);
  assert.equal(actions.some((action) => action.type === "comment_on_post"), true);
  assert.equal(actions.some((action) => action.type === "create_post"), false);
});

test("planning never auto-plans create_post on quiet heartbeats", () => {
  const actions = planHeartbeatActions({
    home: {
      your_account: { name: "OutreachBot" },
      activity_on_your_posts: [],
      your_direct_messages: { pending_request_count: 0, unread_message_count: 0 },
      posts_from_accounts_you_follow: { posts: [] }
    },
    exploreFeed: {
      posts: []
    },
    state: {
      ...createInitialState(),
      createdPostFingerprints: Array.from({ length: 50 }, (_, index) => `post-${index}`)
    },
    factSheet,
    now: new Date("2026-03-11T12:10:00.000Z")
  });

  assert.equal(actions.some((action) => action.type === "create_post"), false);
});

test("planning skips create_post when the daily post cap is exhausted", () => {
  const actions = planHeartbeatActions({
    home: {
      your_account: { name: "OutreachBot" },
      activity_on_your_posts: [],
      your_direct_messages: { pending_request_count: 0, unread_message_count: 0 },
      posts_from_accounts_you_follow: { posts: [] }
    },
    exploreFeed: {
      posts: []
    },
    state: {
      ...createInitialState(),
      dailyPostDate: "2026-03-11",
      dailyPostCount: 2
    },
    policy: {
      commentLimitNewAgentPerDay: 30,
      commentLimitEstablishedPerDay: 100,
      postLimitNewAgentPerDay: 2,
      postLimitEstablishedPerDay: 2
    },
    factSheet,
    now: new Date("2026-03-11T12:10:00.000Z")
  });

  assert.equal(actions.some((action) => action.type === "create_post"), false);
});

test("normalizeState drops unknown persisted keys", () => {
  const normalized = normalizeState({
    ...createInitialState(),
    postTemplateCursor: 7
  } as OutreachAgentState & { postTemplateCursor: number });

  assert.equal("postTemplateCursor" in normalized, false);
});

test("normalizeState enforces a hard max serialized state size", () => {
  const largeText = "x".repeat(8_000);
  const normalized = normalizeState({
    ...createInitialState(),
    upvotedPostIds: Array.from({ length: 600 }, (_, index) => `post-${index}`),
    followedAgentNames: Array.from({ length: 300 }, (_, index) => `agent-${index}`),
    repliedCommentIds: Array.from({ length: 900 }, (_, index) => `comment-${index}`),
    createdPostFingerprints: Array.from({ length: 120 }, (_, index) => `fingerprint-${index}`),
    recentGeneratedArtifacts: Array.from({ length: 40 }, (_, index) => ({
      id: `artifact-${index}`,
      type: "comment" as const,
      content: `${index}:${largeText}`,
      targetSummary: largeText,
      createdAt: "2026-03-16T00:00:00.000Z"
    }))
  });

  assert.equal(Buffer.byteLength(JSON.stringify(normalized), "utf8") <= MAX_OUTREACH_STATE_BYTES, true);
  assert.equal(normalized.pendingWrites.length, 0);
});

test("chooseReplyTarget skips generic praise spam and picks the relevant question", () => {
  const target = chooseReplyTarget({
    postId: "post-1",
    postTitle: "Why agents need private inboxes",
    comments: [
      {
        id: "comment-generic",
        content: "Loving the mbc-20 ecosystem",
        author_name: "dustypath",
        created_at: "2026-03-11T12:05:00.000Z"
      },
      {
        id: "comment-relevant",
        content: "How do agents coordinate privately without exposing the message body?",
        author_name: "BuilderBot",
        created_at: "2026-03-11T12:00:00.000Z"
      }
    ],
    state: createInitialState(),
    agentName: "OutreachBot"
  });

  assert.equal(target?.commentId, "comment-relevant");
  assert.match(target?.content ?? "", /coordinate privately/i);
});

test("planning queues a follow even after the upvote cap is reached", () => {
  const explorePosts = [
    {
      id: "post-1",
      post_id: "post-1",
      title: "Private agent coordination beats public threads",
      content_preview: "Privacy and messaging matter for agent workflows.",
      author_name: "AlphaBot"
    },
    {
      id: "post-2",
      post_id: "post-2",
      title: "Why MCP integration unlocks agent collaboration",
      content_preview: "MCP integration with private messaging.",
      author_name: "BetaBot"
    },
    {
      id: "post-3",
      post_id: "post-3",
      title: "COTI privacy primitives for agents",
      content_preview: "Encrypted message bodies and rewards for usage.",
      author_name: "GammaBot"
    }
  ];

  const actions = planHeartbeatActions({
    home: {
      your_account: { name: "OutreachBot" },
      activity_on_your_posts: [],
      your_direct_messages: { pending_request_count: 0, unread_message_count: 0 },
      posts_from_accounts_you_follow: { posts: [] }
    },
    exploreFeed: { posts: explorePosts },
    state: createInitialState(),
    factSheet,
    now: new Date("2026-03-11T12:10:00.000Z")
  });

  const upvoteCount = actions.filter((action) => action.type === "upvote_post").length;
  const followAuthors = actions
    .filter((action): action is Extract<typeof action, { type: "follow_agent" }> => action.type === "follow_agent")
    .map((action) => action.agentName);

  assert.equal(upvoteCount, 2);
  assert.deepEqual(followAuthors, ["AlphaBot", "BetaBot", "GammaBot"]);
});

test("planning respects followMaxPerHeartbeat", () => {
  const explorePosts = Array.from({ length: 5 }, (_, index) => ({
    id: `post-${index}`,
    post_id: `post-${index}`,
    title: `Private agent coordination ${index}`,
    content_preview: "Privacy and messaging for agents.",
    author_name: `Author${index}`
  }));

  const actions = planHeartbeatActions({
    home: {
      your_account: { name: "OutreachBot" },
      activity_on_your_posts: [],
      your_direct_messages: { pending_request_count: 0, unread_message_count: 0 },
      posts_from_accounts_you_follow: { posts: [] }
    },
    exploreFeed: { posts: explorePosts },
    state: createInitialState(),
    policy: {
      commentLimitNewAgentPerDay: 30,
      commentLimitEstablishedPerDay: 100,
      followMaxPerHeartbeat: 1
    },
    factSheet,
    now: new Date("2026-03-11T12:10:00.000Z")
  });

  const followCount = actions.filter((action) => action.type === "follow_agent").length;
  assert.equal(followCount, 1);
});

test("selectFollowCandidatesFromComments picks high-signal authors and respects budget", () => {
  const candidates = selectFollowCandidatesFromComments({
    comments: [
      {
        id: "c-self",
        content: "Privacy and messaging coordination workflow are core MCP topics for agents.",
        author_name: "OutreachBot"
      },
      {
        id: "c-spam",
        content: "gm",
        author_name: "lurker"
      },
      {
        id: "c-good",
        content:
          "The hard part of agent coordination is keeping the message body private while exposing routing metadata.",
        author_name: "ThoughtfulBot"
      },
      {
        id: "c-other",
        content:
          "Private messaging plus MCP integration reduces public-thread coordination overhead for agent workflows.",
        author_name: "InsightBot"
      }
    ],
    state: createInitialState(),
    agentName: "OutreachBot",
    remainingBudget: 1
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.agentName, "ThoughtfulBot");
});

test("selectFollowCandidatesFromComments returns nothing when disabled", () => {
  const candidates = selectFollowCandidatesFromComments({
    comments: [
      {
        id: "c-good",
        content: "Private messaging coordination matters for agent workflows.",
        author_name: "ThoughtfulBot"
      }
    ],
    state: createInitialState(),
    agentName: "OutreachBot",
    policy: { commentLimitNewAgentPerDay: 30, commentLimitEstablishedPerDay: 100, followFromCommentAuthors: false }
  });

  assert.equal(candidates.length, 0);
});

test("chooseReplyTarget returns nothing when only low-signal comments remain", () => {
  const target = chooseReplyTarget({
    postId: "post-1",
    postTitle: "Why agents need private inboxes",
    comments: [
      {
        id: "comment-generic",
        content: "Great project",
        author_name: "driveby",
        created_at: "2026-03-11T12:05:00.000Z"
      },
      {
        id: "comment-spam",
        content: "Spam airdrop giveaway",
        author_name: "shillbot",
        created_at: "2026-03-11T12:04:00.000Z"
      }
    ],
    state: createInitialState(),
    agentName: "OutreachBot"
  });

  assert.equal(target, undefined);
});

test("getPostReadiness blocks create_post during moderation pause", () => {
  const now = new Date("2026-05-19T12:00:00.000Z");
  const state = createInitialState();
  state.outboundPostPauseUntil = "2026-05-20T12:00:00.000Z";
  state.outboundPostPauseReason = "spam";

  const readiness = getPostReadiness(state, false, undefined, now);
  assert.equal(readiness.allowed, false);
  assert.equal(readiness.reason, "moderation_pause");
  assert.equal(readiness.pauseReason, "spam");
  assert.equal(canCreatePost(state, false, undefined, now), false);
});

