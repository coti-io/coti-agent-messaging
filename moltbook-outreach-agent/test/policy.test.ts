import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_OUTREACH_STATE_BYTES,
  canCreatePost,
  chooseReplyTarget,
  createInitialState,
  normalizeState,
  planHeartbeatActions,
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

test("recent posts block new post creation during cooldown", () => {
  const state: OutreachAgentState = {
    ...createInitialState(),
    lastPostAt: "2026-03-11T11:50:00.000Z"
  };

  assert.equal(canCreatePost(state, false, new Date("2026-03-11T12:00:00.000Z")), false);
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

