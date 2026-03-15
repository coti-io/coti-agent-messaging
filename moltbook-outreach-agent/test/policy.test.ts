import test from "node:test";
import assert from "node:assert/strict";

import {
  canCreatePost,
  createInitialState,
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

