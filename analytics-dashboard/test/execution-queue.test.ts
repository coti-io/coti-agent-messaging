import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import sqlite3 from "sqlite3";

import { buildExecutionQueue, loadExecutionQueue } from "../src/execution-queue";
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

test("buildExecutionQueue sorts running before queued and omits succeeded", () => {
  const queue = buildExecutionQueue([
    {
      id: "job-queued",
      venue: "moltbook",
      type: "comment_on_post",
      status: "queued",
      candidateId: "cand-1",
      notBefore: "2026-06-03T12:10:00.000Z",
      attempts: 0
    },
    {
      id: "job-running",
      venue: "moltbook",
      type: "upvote_post",
      status: "running",
      candidateId: "cand-2",
      notBefore: "2026-06-03T12:00:00.000Z",
      runningAt: "2026-06-03T12:05:00.000Z",
      attempts: 1
    },
    {
      id: "job-done",
      venue: "moltbook",
      type: "create_post",
      status: "succeeded",
      candidateId: "cand-3",
      notBefore: "2026-06-03T11:00:00.000Z",
      attempts: 1
    },
    {
      id: "job-failed",
      venue: "reddit",
      type: "comment_on_post",
      status: "failed",
      candidateId: "cand-4",
      notBefore: "2026-06-03T11:30:00.000Z",
      lastAttemptAt: "2026-06-03T12:01:00.000Z",
      lastError: "publish failed",
      attempts: 3
    }
  ]);

  assert.equal(queue.items.length, 3);
  assert.equal(queue.items[0]?.id, "job-running");
  assert.equal(queue.items[1]?.id, "job-queued");
  assert.equal(queue.items[2]?.id, "job-failed");
  assert.equal(queue.summary.running, 1);
  assert.equal(queue.summary.queued, 1);
  assert.equal(queue.summary.failed, 1);
  assert.equal(queue.items[2]?.lastError, "publish failed");
});

test("loadExecutionQueue falls back to sqlite snapshot when state json has no jobs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "analytics-queue-sqlite-"));
  const runtimeDir = path.join(tempDir, "runtime");
  const sqlitePath = path.join(runtimeDir, "state.sqlite");
  await mkdir(runtimeDir, { recursive: true });
  await execSql(
    sqlitePath,
    `
      CREATE TABLE state_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO state_snapshots(snapshot_id, snapshot_json, updated_at) VALUES
        ('current', '{"queuedActionJobs":[{"id":"sqlite-job","venue":"moltbook","type":"reply_to_comment","status":"queued","candidateId":"cand-sqlite","notBefore":"2026-06-03T13:00:00.000Z","attempts":0}]}', '2026-06-03T12:00:00.000Z');
    `
  );

  try {
    const queue = await loadExecutionQueue({
      state: { queuedActionJobs: [] },
      storagePath: sqlitePath
    });
    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0]?.id, "sqlite-job");
    assert.equal(queue.items[0]?.type, "reply_to_comment");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("discoverAgents exposes execution queue from state.json", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "analytics-queue-discovery-"));
  const agentDir = path.join(tempDir, "agent-q");
  const runtimeDir = path.join(agentDir, ".runtime");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "agent.json"),
    JSON.stringify({
      agentId: "agent-q",
      displayName: "Queue Agent",
      serviceName: "outreach-agent-q"
    }),
    "utf8"
  );
  await writeFile(
    path.join(runtimeDir, "state.json"),
    JSON.stringify({
      queuedActionJobs: [
        {
          id: "state-job",
          venue: "moltbook",
          type: "create_post",
          status: "failed",
          candidateId: "cand-state",
          notBefore: "2026-06-03T10:00:00.000Z",
          lastError: "rate limited",
          attempts: 2
        }
      ],
      engagementTotals: { posts: 0, comments: 0, replies: 0, upvotes: 0, follows: 0, total: 0 }
    }),
    "utf8"
  );

  try {
    const agents = await discoverAgents(tempDir);
    assert.equal(agents[0]?.executionQueue.items.length, 1);
    assert.equal(agents[0]?.executionQueue.items[0]?.id, "state-job");
    assert.equal(agents[0]?.executionQueue.summary.failed, 1);
    assert.equal(agents[0]?.executionQueue.items[0]?.lastError, "rate limited");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
