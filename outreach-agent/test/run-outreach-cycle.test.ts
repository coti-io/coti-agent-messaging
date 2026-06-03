import test from "node:test";
import assert from "node:assert/strict";

import type { OutreachRuntimePorts } from "../src/runtime/contracts.js";
import { createInitialState } from "../src/policy.js";
import {
  runOutreachCycle,
  type OutreachCycleStrategy
} from "../src/runtime/run-outreach-cycle.js";
import { OUTREACH_RUNTIME_PIPELINE } from "../src/runtime/outreach-runtime.js";

function stubPorts(): OutreachRuntimePorts {
  return {
    jobs: {
      loadJobs: async () => [],
      saveJobs: async () => undefined
    },
    runs: {
      persistRun: async () => undefined,
      writeLatestReport: async () => undefined,
      appendRunHistory: async () => undefined
    },
    state: {
      loadState: async () => createInitialState(),
      saveState: async (state) => state
    },
    analytics: {
      write: async () => undefined,
      readModelPath: () => "/tmp/analytics-read-model.json"
    }
  };
}

test("runOutreachCycle runs phases in pipeline order", async () => {
  const order: string[] = [];
  const strategy: OutreachCycleStrategy = {
    loadContext: async () => {
      order.push("load_context");
    },
    executeDueJobs: async () => {
      order.push("execute_due_jobs");
    },
    buildReport: async () => {
      order.push("report");
    }
  };

  const result = await runOutreachCycle({
    ports: stubPorts(),
    strategy,
    mode: "heartbeat",
    dryRun: true,
    phases: ["load_context", "execute_due_jobs", "report"]
  });

  assert.deepEqual(order, ["load_context", "execute_due_jobs", "report"]);
  assert.deepEqual(result.phasesRun, ["load_context", "execute_due_jobs", "report"]);
  assert.equal(result.mode, "heartbeat");
  assert.equal(result.dryRun, true);
});

test("runOutreachCycle skips phases without handlers", async () => {
  const order: string[] = [];
  const strategy: OutreachCycleStrategy = {
    loadContext: async () => {
      order.push("load_context");
    },
    buildReport: async () => {
      order.push("report");
    }
  };

  const result = await runOutreachCycle({
    ports: stubPorts(),
    strategy,
    mode: "executor",
    dryRun: false,
    phases: OUTREACH_RUNTIME_PIPELINE
  });

  assert.deepEqual(order, ["load_context", "report"]);
  assert.deepEqual(result.phasesRun, ["load_context", "report"]);
});

test("runOutreachCycle executor subset runs only load execute report handlers", async () => {
  const phasesRun: string[] = [];
  const strategy: OutreachCycleStrategy = {
    loadContext: async (ctx) => {
      phasesRun.push(ctx.mode);
    },
    executeDueJobs: async (ctx) => {
      ctx.performed.push("executed job");
    },
    buildReport: async () => {
      phasesRun.push("report");
    }
  };

  const result = await runOutreachCycle({
    ports: stubPorts(),
    strategy,
    mode: "executor",
    dryRun: false,
    phases: ["load_context", "execute_due_jobs", "report"]
  });

  assert.deepEqual(result.phasesRun, ["load_context", "execute_due_jobs", "report"]);
  assert.deepEqual(result.performed, ["executed job"]);
  assert.equal(phasesRun[0], "executor");
});

test("runOutreachCycle propagates phase errors", async () => {
  const strategy: OutreachCycleStrategy = {
    loadContext: async () => undefined,
    executeDueJobs: async () => {
      throw new Error("boom");
    }
  };

  await assert.rejects(
    () =>
      runOutreachCycle({
        ports: stubPorts(),
        strategy,
        mode: "executor",
        dryRun: false,
        phases: ["load_context", "execute_due_jobs"]
      }),
    /boom/
  );
});
