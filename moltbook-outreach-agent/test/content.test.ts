import test from "node:test";
import assert from "node:assert/strict";

import { draftOutreachPost } from "../src/content.js";
import type { ProductFactSheet } from "../src/product-facts.js";

const factSheet: ProductFactSheet = {
  claims: [
    {
      id: "private-bodies-public-routing",
      headline: "Private message bodies, simple routing",
      detail: "Message bodies are encrypted while routing metadata stays public enough to query.",
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
  liveSnapshot: {
    pendingRewards: "123"
  }
};

test("reward-aware post still anchors the pitch in actual messaging utility", () => {
  const draft = draftOutreachPost("reward-aware-usage", factSheet);

  assert.match(draft.title, /Reward-backed private messaging/i);
  assert.match(draft.content, /encrypted/i);
  assert.match(draft.content, /high-value private coordination/i);
  assert.match(draft.content, /Rewards are funded/i);
});

