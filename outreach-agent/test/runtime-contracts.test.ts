import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRuntimePorts } from "../src/runtime/create-runtime-ports.js";
import { analyticsReadModelPath } from "../src/runtime/paths.js";
import { migrateRedditJsonJobsToState, loadRedditMemoryWithSharedJobs, syncRedditQueuedJobsToState } from "../src/runtime/reddit-job-sync.js";
import { heartbeatReportToStoredRun } from "../src/runtime/heartbeat-report.js";
import { redditRuntimeReportToStoredRun } from "../src/runtime/reddit-runtime-report.js";
import { OUTREACH_RUNTIME_PIPELINE } from "../src/runtime/outreach-runtime.js";
import { buildAnalyticsReadModelFromStorage, FileAnalyticsReadModelWriter } from "../src/runtime/analytics-read-model.js";
import { createInitialState } from "../src/policy.js";
import { saveRedditMemory } from "../src/reddit-memory.js";
import type { ActionJob } from "../src/action-planning.js";

test("runtime pipeline defines shared phases in order", () => {
  assert.equal(OUTREACH_RUNTIME_PIPELINE[0], "load_context");
  assert.equal(OUTREACH_RUNTIME_PIPELINE.at(-1), "report");
});

test("heartbeat and reddit reports map to stored run shape", () => {
  const stored = heartbeatReportToStoredRun({
    runId: "run-1",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    status: "ok",
    dryRun: false,
    performed: ["upvoted post:abc"]
  });
  assert.equal(stored.runId, "run-1");
  assert.deepEqual(stored.performed, ["upvoted post:abc"]);

  const redditStored = redditRuntimeReportToStoredRun({
    runId: "reddit-1",
    phase: "heartbeat",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    status: "ok",
    summary: "noop",
    dryRun: true
  });
  assert.equal(redditStored.plannedActions[0], "heartbeat");
});

test("saveRedditMemorySynced does not mirror queued jobs into json by default", async () => {
  const root = path.join(os.tmpdir(), `runtime-json-jobs-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const runtimeDir = path.join(root, ".runtime");
  await mkdir(runtimeDir, { recursive: true });
  const statePath = path.join(runtimeDir, "state.json");
  const heartbeatReportPath = path.join(runtimeDir, "last-heartbeat.json");
  const memoryPath = path.join(root, "reddit-memory.json");

  const job: ActionJob = {
    id: "job:2:decision",
    venue: "reddit",
    actionId: "action-2",
    candidateId: "candidate-2",
    type: "comment_on_post",
    payload: {
      id: "action-2",
      venue: "reddit",
      type: "comment_on_post",
      content: "reply"
    },
    status: "queued",
    createdAt: new Date().toISOString(),
    notBefore: new Date().toISOString(),
    attempts: 0,
    sourceDecisionId: "decision-2"
  };

  const config = {
    statePath,
    heartbeatReportPath,
    redditOperating: { memoryPath }
  } as import("../src/config.js").MoltbookRuntimeConfig;

  const ports = createRuntimePorts(config);
  await ports.state.saveState(createInitialState());

  const { saveRedditMemorySynced } = await import("../src/runtime/reddit-memory-persist.js");
  await saveRedditMemorySynced(
    config,
    {
      generatedAt: new Date().toISOString(),
      history: [],
      queuedJobs: [job]
    }
  );

  const memoryRaw = JSON.parse(await readFile(memoryPath, "utf8")) as { queuedJobs?: unknown[] };
  assert.equal(memoryRaw.queuedJobs, undefined);

  const loaded = await ports.jobs.loadJobs();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.id, job.id);

  await rm(root, { recursive: true, force: true });
});

test("sqlite job store syncs reddit json jobs into state", async () => {
  const root = path.join(os.tmpdir(), `runtime-contract-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const runtimeDir = path.join(root, ".runtime");
  await mkdir(runtimeDir, { recursive: true });
  const statePath = path.join(runtimeDir, "state.json");
  const heartbeatReportPath = path.join(runtimeDir, "last-heartbeat.json");
  const memoryPath = path.join(root, "reddit-memory.json");

  const job: ActionJob = {
    id: "job:1:decision",
    venue: "reddit",
    actionId: "action-1",
    candidateId: "candidate-1",
    type: "comment_on_post",
    payload: {
      id: "action-1",
      venue: "reddit",
      type: "comment_on_post",
      content: "helpful reply"
    },
    status: "queued",
    createdAt: new Date().toISOString(),
    notBefore: new Date().toISOString(),
    attempts: 0,
    sourceDecisionId: "decision-1"
  };

  await saveRedditMemory(memoryPath, {
    generatedAt: new Date().toISOString(),
    history: [],
    queuedJobs: [job]
  });

  const config = {
    statePath,
    heartbeatReportPath,
    redditOperating: { memoryPath }
  } as import("../src/config.js").MoltbookRuntimeConfig;

  const ports = createRuntimePorts(config);
  await ports.state.saveState(createInitialState());

  await migrateRedditJsonJobsToState(config);
  const loaded = await ports.jobs.loadJobs();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.id, job.id);

  const hydrated = await loadRedditMemoryWithSharedJobs(config);
  assert.equal(hydrated.queuedJobs?.length, 1);
  const memoryAfterMigrate = JSON.parse(await readFile(memoryPath, "utf8")) as {
    queuedJobs?: unknown[];
  };
  assert.equal(memoryAfterMigrate.queuedJobs, undefined);

  await syncRedditQueuedJobsToState(config, {
    ...hydrated,
    queuedJobs: []
  });
  const afterClear = await ports.jobs.loadJobs();
  assert.equal(afterClear.length, 0);

  const afterResurrection = await loadRedditMemoryWithSharedJobs(config);
  assert.equal(afterResurrection.queuedJobs?.length, 0);

  await rm(root, { recursive: true, force: true });
});

test("analytics read model writer persists json artifact", async () => {
  const root = path.join(os.tmpdir(), `runtime-analytics-${Date.now()}`);
  const runtimeDir = path.join(root, ".runtime");
  await mkdir(runtimeDir, { recursive: true });
  const statePath = path.join(runtimeDir, "state.json");
  const heartbeatReportPath = path.join(runtimeDir, "last-heartbeat.json");

  const ports = createRuntimePorts({ statePath, heartbeatReportPath });
  await ports.state.saveState(createInitialState());

  const model = await buildAnalyticsReadModelFromStorage({
    statePath,
    heartbeatReportPath,
    venue: "moltbook",
    runtimeKind: "heartbeat",
    latestRun: {
      runId: "r1",
      status: "ok",
      startedAt: "2026-01-01T00:00:00.000Z"
    }
  });
  await ports.analytics.write(model);

  const raw = await readFile(analyticsReadModelPath(statePath), "utf8");
  const parsed = JSON.parse(raw) as { schemaVersion: number; venue: string };
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.venue, "moltbook");

  await rm(root, { recursive: true, force: true });
});
