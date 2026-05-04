import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { discoverAgents } from "../src/discovery";

test("discoverAgents reads agent metadata, state, and heartbeat report", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "analytics-discovery-"));
  const agentDir = path.join(tempDir, "agent-a");
  const runtimeDir = path.join(agentDir, ".runtime");

  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "agent.json"),
    JSON.stringify({
      agentId: "agent-a",
      displayName: "Agent A",
      serviceName: "moltbook-outreach-agent-a",
      walletAddress: "0x0000000000000000000000000000000000000001"
    }),
    "utf8"
  );
  await writeFile(
    path.join(runtimeDir, "state.json"),
    JSON.stringify({
      lastHeartbeatAt: "2026-05-04T12:00:00.000Z",
      pendingWrites: [{ id: "pending-1" }],
      engagementEvents: [{ type: "post", createdAt: "2026-05-04T11:00:00.000Z" }],
      engagementTotals: { posts: 1 }
    }),
    "utf8"
  );
  await writeFile(
    path.join(runtimeDir, "last-heartbeat.json"),
    JSON.stringify({ status: "ok", errors: [], skipped: ["cooldown"] }),
    "utf8"
  );

  try {
    const agents = await discoverAgents(tempDir, new Date("2026-05-04T12:00:00.000Z"));

    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.metadata.agentId, "agent-a");
    assert.equal(agents[0]?.metadata.displayName, "Agent A");
    assert.equal(agents[0]?.pendingWrites, 1);
    assert.equal(agents[0]?.latestStatus, "ok");
    assert.equal(agents[0]?.latestSkipped, 1);
    assert.equal(agents[0]?.engagementSummary.windows.last2Hours.posts, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
