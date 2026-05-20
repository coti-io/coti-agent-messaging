import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import sqlite3 from "sqlite3";

import { discoverAgents } from "../src/discovery";

async function execSql(databasePath: string, sql: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const db = new sqlite3.Database(databasePath, (error) => {
      if (error) {
        reject(error);
        return;
      }
      db.exec(sql, (runError) => {
        db.close(() => {
          if (runError) {
            reject(runError);
            return;
          }
          resolve();
        });
      });
    });
  });
}

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
      serviceName: "outreach-agent-a",
      profileUrl: "https://www.moltbook.com/u/signalfoundry",
      walletAddress: "0x0000000000000000000000000000000000000001"
    }),
    "utf8"
  );
  await writeFile(
    path.join(runtimeDir, "state.json"),
    JSON.stringify({
      lastHeartbeatAt: "2026-05-04T12:00:00.000Z",
      pendingWrites: [{ id: "pending-1" }],
      queuedActionJobs: [{ id: "job-1" }],
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
    assert.equal(agents[0]?.metadata.profileUrl, "https://www.moltbook.com/u/signalfoundry");
    assert.equal(agents[0]?.pendingWrites, 2);
    assert.equal(agents[0]?.latestStatus, "ok");
    assert.equal(agents[0]?.latestSkipped, 1);
    assert.equal(agents[0]?.engagementSummary.windows.last2Hours.posts, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("discoverAgents prefers sqlite health and counters when present", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "analytics-discovery-sqlite-"));
  const agentDir = path.join(tempDir, "agent-b");
  const runtimeDir = path.join(agentDir, ".runtime");
  const sqlitePath = path.join(runtimeDir, "state.sqlite");

  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "agent.json"),
    JSON.stringify({
      agentId: "agent-b",
      displayName: "Agent B",
      serviceName: "outreach-agent-b"
    }),
    "utf8"
  );
  await execSql(
    sqlitePath,
    `
      CREATE TABLE agent_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO agent_meta(key, value) VALUES ('engagement_baseline_json', '{"posts":2,"comments":0,"replies":0,"upvotes":0,"follows":0,"total":2}');
      CREATE TABLE heartbeat_runs (
        run_id TEXT PRIMARY KEY,
        agent_id TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        summary TEXT,
        dry_run INTEGER NOT NULL,
        error_count INTEGER NOT NULL,
        skip_count INTEGER NOT NULL,
        planned_actions_json TEXT NOT NULL,
        performed_json TEXT NOT NULL,
        skipped_json TEXT NOT NULL,
        errors_json TEXT NOT NULL,
        reconciled_pending_writes_json TEXT NOT NULL,
        write_candidates_json TEXT NOT NULL,
        selected_write_decision_json TEXT,
        engagement_summary_json TEXT
      );
      CREATE TABLE engagement_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        target_id TEXT,
        target_summary TEXT
      );
      CREATE TABLE pending_writes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        reconciliation_misses INTEGER NOT NULL DEFAULT 0,
        title TEXT,
        content TEXT NOT NULL,
        post_id TEXT,
        target_comment_id TEXT,
        target_summary TEXT,
        reply_to_author TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE state_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO heartbeat_runs(
        run_id, agent_id, started_at, finished_at, status, summary, dry_run, error_count, skip_count,
        planned_actions_json, performed_json, skipped_json, errors_json,
        reconciled_pending_writes_json, write_candidates_json, selected_write_decision_json, engagement_summary_json
      ) VALUES
        ('run-ok', 'agent-b', '2026-05-04T11:40:00.000Z', '2026-05-04T11:45:00.000Z', 'ok', NULL, 0, 0, 0, '[]', '[]', '[]', '[]', '[]', '[]', NULL, NULL),
        ('run-failed', 'agent-b', '2026-05-04T11:55:00.000Z', '2026-05-04T12:00:00.000Z', 'failed', NULL, 0, 1, 2, '[]', '[]', '[]', '[]', '[]', '[]', NULL, NULL);
      INSERT INTO engagement_events(event_id, run_id, event_type, created_at, target_id, target_summary) VALUES
        ('event-reply', 'run-ok', 'reply', '2026-05-04T11:50:00.000Z', 'comment-1', 'reply target');
      INSERT INTO pending_writes(id, type, fingerprint, content, created_at) VALUES
        ('pending-1', 'comment', 'fp-1', 'still pending', '2026-05-04T11:58:00.000Z');
      INSERT INTO state_snapshots(snapshot_id, snapshot_json, updated_at) VALUES
        ('current', '{"pendingWrites":[{"id":"pending-1"}],"queuedActionJobs":[{"id":"job-1"}]}', '2026-05-04T12:00:00.000Z');
    `
  );

  try {
    const agents = await discoverAgents(tempDir, new Date("2026-05-04T12:00:00.000Z"));

    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.metadata.agentId, "agent-b");
    assert.equal(agents[0]?.schedulerHealth, "fresh");
    assert.equal(agents[0]?.latestStatus, "failed");
    assert.equal(agents[0]?.lastSuccessfulHeartbeatAt, "2026-05-04T11:45:00.000Z");
    assert.equal(agents[0]?.pendingWrites, 2);
    assert.equal(agents[0]?.engagementSummary.windows.last2Hours.replies, 1);
    assert.equal(agents[0]?.engagementSummary.total.posts, 2);
    assert.equal(agents[0]?.engagementSummary.total.replies, 1);
    assert.equal(agents[0]?.engagementSummary.total.total, 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
