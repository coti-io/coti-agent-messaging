import test from "node:test";
import assert from "node:assert/strict";

import { resolveAgentAccountStatus } from "../src/account-status";

test("resolveAgentAccountStatus maps reddit kill switch bans to banned", () => {
  const status = resolveAgentAccountStatus({
    agentId: "reddit-outreach",
    serviceName: "reddit-outreach-heartbeat",
    state: { venue: "reddit" },
    report: {
      planner: {
        sessionLimits: ["Kill switch: a ban was recorded in Reddit memory."]
      }
    }
  });

  assert.equal(status?.state, "banned");
  assert.equal(status?.label, "Banned");
});

test("resolveAgentAccountStatus reads persisted accountHealth", () => {
  const status = resolveAgentAccountStatus({
    agentId: "reddit-outreach",
    serviceName: "reddit-outreach-heartbeat",
    report: {
      accountHealth: {
        status: "session_invalid",
        reason: "token_v2 missing or expired in reddit storage state — run reddit:login.",
        controller: "unofficial"
      }
    }
  });

  assert.equal(status?.state, "session_invalid");
  assert.equal(status?.label, "Session invalid");
});

test("resolveAgentAccountStatus is omitted for moltbook agents", () => {
  const status = resolveAgentAccountStatus({
    agentId: "moltbook-outreach",
    serviceName: "moltbook-outreach-heartbeat",
    state: { venue: "moltbook" }
  });

  assert.equal(status, undefined);
});
