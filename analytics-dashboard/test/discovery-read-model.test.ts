import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { discoverAgents } from "../src/discovery";
import { analyticsReadModelPathForState } from "../src/read-analytics-read-model";

test("discoverAgents prefers analytics-read-model.json when present", async () => {
  const agentRoot = path.join(os.tmpdir(), `analytics-discovery-${Date.now()}`);
  const agentDir = path.join(agentRoot, "agent-a");
  const runtimeDir = path.join(agentDir, ".runtime");
  await mkdir(runtimeDir, { recursive: true });

  const statePath = path.join(runtimeDir, "state.json");
  await writeFile(
    path.join(agentDir, "agent.json"),
    JSON.stringify({
      agentId: "agent-a",
      displayName: "Agent A",
      serviceName: "outreach-a"
    }),
    "utf8"
  );
  await writeFile(statePath, JSON.stringify({ engagementEvents: [] }), "utf8");

  const finishedAt = "2026-06-01T12:00:00.000Z";
  await writeFile(
    analyticsReadModelPathForState(statePath),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: finishedAt,
      venue: "reddit",
      runtimeKind: "heartbeat",
      paths: {
        statePath,
        storagePath: path.join(runtimeDir, "state.sqlite"),
        heartbeatReportPath: path.join(runtimeDir, "last-heartbeat.json")
      },
      scheduler: {
        lastHeartbeatAt: finishedAt,
        lastSuccessfulRunAt: finishedAt,
        latestStatus: "ok",
        health: "fresh"
      },
      pendingWork: { pendingWrites: 2, queuedJobs: 3 },
      latestRun: {
        runId: "run-a",
        status: "ok",
        startedAt: "2026-06-01T11:00:00.000Z",
        finishedAt,
        summary: "posted 1 reply"
      }
    }),
    "utf8"
  );

  const agents = await discoverAgents(agentRoot, new Date("2026-06-01T12:05:00.000Z"));
  assert.equal(agents.length, 1);
  assert.equal(agents[0]?.pendingWrites, 5);
  assert.equal(agents[0]?.schedulerHealth, "fresh");
  assert.equal(agents[0]?.latestStatus, "ok");
  assert.equal(agents[0]?.lastHeartbeatAt, finishedAt);
  assert.equal(agents[0]?.readModelPresent, true);

  await rm(agentRoot, { recursive: true, force: true });
});

test("discoverAgents without read model exposes unknown scheduler and no inferred heartbeat", async () => {
  const agentRoot = path.join(os.tmpdir(), `analytics-discovery-missing-${Date.now()}`);
  const agentDir = path.join(agentRoot, "agent-b");
  const runtimeDir = path.join(agentDir, ".runtime");
  await mkdir(runtimeDir, { recursive: true });

  const staleHeartbeat = "2020-01-01T00:00:00.000Z";
  const statePath = path.join(runtimeDir, "state.json");
  await writeFile(
    path.join(agentDir, "agent.json"),
    JSON.stringify({
      agentId: "agent-b",
      displayName: "Agent B",
      serviceName: "outreach-b"
    }),
    "utf8"
  );
  await writeFile(
    statePath,
    JSON.stringify({
      engagementEvents: [],
      lastHeartbeatAt: staleHeartbeat,
      pendingWrites: [{ id: "pw-1" }],
      queuedActionJobs: [{ id: "job-1" }]
    }),
    "utf8"
  );

  const agents = await discoverAgents(agentRoot, new Date("2026-06-01T12:05:00.000Z"));
  assert.equal(agents.length, 1);
  assert.equal(agents[0]?.readModelPresent, false);
  assert.equal(agents[0]?.schedulerHealth, "unknown");
  assert.equal(agents[0]?.lastHeartbeatAt, undefined);
  assert.equal(agents[0]?.pendingWrites, 0);
  assert.equal(agents[0]?.latestStatus, undefined);

  await rm(agentRoot, { recursive: true, force: true });
});
