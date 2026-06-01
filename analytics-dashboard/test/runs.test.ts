import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { loadAgentRecentRuns } from "../src/runs";

test("loadAgentRecentRuns explains idle reddit heartbeats like moltbook summaries", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "analytics-runs-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  await mkdir(runtimeDir, { recursive: true });

  const report = {
    runId: "heartbeat:2026-06-01T09:05:03.308Z:1",
    phase: "heartbeat",
    startedAt: "2026-06-01T09:05:01.000Z",
    finishedAt: "2026-06-01T09:05:03.308Z",
    status: "ok",
    summary: "HEARTBEAT_OK - Reddit runtime idle.",
    dryRun: false,
    skipped: [],
    errors: [],
    ingestion: {
      snapshotCount: 4,
      sourceItemCount: 77,
      discoveryThreadSnapshots: 4,
      ownThreadSnapshots: 0,
      skipped: []
    },
    actionCandidates: [
      {
        id: "comment:sales:abc",
        type: "comment_on_post",
        source: { subreddit: "sales", title: "AI receptionist rant" },
        allowed: false,
        blockedBy: ["daily_comment_cap"]
      }
    ],
    selectedActionBundle: {
      selectedCandidateIds: [],
      rationale: "No legal Reddit action candidate survived filtering."
    },
    planner: {
      skipped: ["comment:sales:abc: blocked by daily_comment_cap"],
      blockedGateSample: [
        { id: "comment:sales:abc", gates: ["daily_comment_cap"] }
      ]
    },
    queuedActionJobs: [],
    engagementSummary: {
      total: { posts: 2, comments: 5, replies: 1, upvotes: 0, follows: 0, total: 8 }
    }
  };

  await writeFile(
    path.join(runtimeDir, "heartbeat-runs.jsonl"),
    `${JSON.stringify(report)}\n`,
    "utf8"
  );

  try {
    const runs = await loadAgentRecentRuns(
      {
        agentDir: tempDir,
        runtimeDir,
        envPath: path.join(tempDir, ".env"),
        metadataPath: path.join(tempDir, "agent.json"),
        statePath: path.join(runtimeDir, "state.json"),
        storagePath: path.join(runtimeDir, "state.sqlite"),
        reportPath: path.join(runtimeDir, "last-heartbeat.json")
      },
      undefined,
      5
    );

    assert.equal(runs.length, 1);
    assert.match(runs[0]?.summary ?? "", /Skipped:/);
    assert.match(runs[0]?.summary ?? "", /No legal Reddit action candidate survived filtering/);
    assert.equal(runs[0]?.skipped.length >= 1, true);
    assert.equal(runs[0]?.runCounts.total, 8);
    assert.equal(runs[0]?.countsScope, "lifetime");
    assert.match(runs[0]?.activityThisRun ?? "", /77 source items|candidate/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
