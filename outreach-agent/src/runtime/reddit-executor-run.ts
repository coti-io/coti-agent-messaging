import { getOutreachAgentConfig, getRedditOperatingAgentConfig, loadRuntimeConfig, type MoltbookRuntimeConfig } from "../config.js";
import { chooseRedditActionBundle } from "../reddit-action-planning.js";
import { emptyRedditFilterSummary } from "../reddit-policy.js";
import type { RedditDecisionMemoryEntry } from "../reddit-memory.js";
import type { RedditMemoryStore } from "../reddit-memory.js";
import type { RedditSessionReport } from "./reddit-types.js";
import type { VenueAction, VenueOutcome } from "../venue.js";
import { createRuntimePorts } from "./create-runtime-ports.js";
import {
  createRedditPlannerStrategy,
  REDDIT_EXECUTOR_PHASES,
  type RedditPlannerSession
} from "./reddit-cycle-strategy.js";
import { executeQueuedRedditJob } from "./reddit-job-executor.js";
import {
  emptyIngestionSummary,
  resolveRedditSessionDuplicateCheckPolicy,
  summarizePlanner,
  summarizeQueuedRedditJobs,
  verifyRedditAccountHealth
} from "./reddit-planner-support.js";
import { createRedditPlannerWorkspace } from "./reddit-planner-phases.js";
import { requireRedditPlannerSessionReport } from "./reddit-planner-internal.js";
import { createRedditRuntimeStore } from "./reddit-runtime-store.js";
import { runOutreachCycle } from "./run-outreach-cycle.js";

function buildExecutorSessionReport(input: {
  now: Date;
  dryRun: boolean;
  operating: ReturnType<typeof getRedditOperatingAgentConfig>;
  store: RedditMemoryStore;
  outcome?: VenueOutcome;
  recorded?: RedditDecisionMemoryEntry;
  skipped: string[];
}): RedditSessionReport {
  return {
    generatedAt: input.now.toISOString(),
    dryRun: input.dryRun,
    duplicateCheckPolicy: resolveRedditSessionDuplicateCheckPolicy(input.dryRun),
    readSource: input.operating.readController,
    memoryPath: input.operating.memoryPath,
    ingestion: emptyIngestionSummary(),
    planner: summarizePlanner({ skipped: input.skipped }),
    actionCandidates: [],
    selectedActionBundle: chooseRedditActionBundle([], 1),
    queuedActionJobs: summarizeQueuedRedditJobs(input.store),
    decision: {
      action: undefined,
      plannedCandidates: [],
      candidates: [],
      skipped: input.skipped,
      filterSummary: emptyRedditFilterSummary()
    },
    outcome: input.outcome,
    recorded: input.recorded
  };
}

export async function runRedditExecutorCore(input: {
  config: MoltbookRuntimeConfig;
  dryRun: boolean;
  fetchImpl?: typeof fetch;
  publishAction?: (action: VenueAction) => Promise<VenueOutcome>;
  now: Date;
}): Promise<RedditSessionReport> {
  const { config, dryRun, now } = input;
  const operating = getRedditOperatingAgentConfig(config);
  const runtimeStore = createRedditRuntimeStore(config);
  if (dryRun) {
    const store = await runtimeStore.load();
    return buildExecutorSessionReport({
      now,
      dryRun,
      operating,
      store,
      skipped: ["Reddit executor skipped because dry-run mode is enabled."]
    });
  }

  const store = await runtimeStore.load();
  const accountHealth = await verifyRedditAccountHealth({
    config,
    memory: store,
    memoryPath: operating.memoryPath,
    now,
    fetchImpl: input.fetchImpl
  });
  if (accountHealth.blockedReason) {
    return buildExecutorSessionReport({
      now,
      dryRun,
      operating,
      store: accountHealth.memory,
      skipped: [accountHealth.blockedReason]
    });
  }

  const executed = await executeQueuedRedditJob(accountHealth.memory, {
    config,
    publishAction: input.publishAction,
    now,
    fetchImpl: input.fetchImpl
  });
  const nextStore = executed?.store ?? accountHealth.memory;
  return buildExecutorSessionReport({
    now,
    dryRun,
    operating,
    store: nextStore,
    outcome: executed?.outcome,
    recorded: executed?.recorded,
    skipped: executed?.executed
      ? ["Executed one queued Reddit action."]
      : [executed?.skipped ?? "No queued Reddit actions were due."]
  });
}

export async function runRedditExecutor(input: {
  config?: MoltbookRuntimeConfig;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  publishAction?: (action: VenueAction) => Promise<VenueOutcome>;
  now?: Date;
} = {}): Promise<RedditSessionReport> {
  const config = input.config ?? await loadRuntimeConfig({ requireVenue: true });
  const agent = getOutreachAgentConfig(config);
  if (agent.venue !== "reddit") {
    throw new Error("reddit-executor requires OUTREACH_AGENT_VENUE=reddit.");
  }
  const operating = getRedditOperatingAgentConfig(config);
  const dryRun = input.dryRun ?? operating.dryRunDefault;
  const now = input.now ?? new Date();
  const runtimeStore = createRedditRuntimeStore(config);

  const session: RedditPlannerSession = {
    config,
    dryRun,
    performed: [],
    skipped: [],
    workspace: createRedditPlannerWorkspace({ config, dryRun, ...input }, {
      executeDueJobsFirst: true,
      allowImmediatePublish: false,
      now
    })
  };

  try {
    await runOutreachCycle({
      ports: createRuntimePorts(config),
      strategy: createRedditPlannerStrategy(session, {
        loadContext: async () => {
          session.report = await runRedditExecutorCore({
            config,
            dryRun,
            fetchImpl: input.fetchImpl,
            publishAction: input.publishAction,
            now
          });
        }
      }),
      mode: "executor",
      dryRun,
      phases: [...REDDIT_EXECUTOR_PHASES]
    });
    const report = requireRedditPlannerSessionReport(session);
    await runtimeStore.persistRuntimeSnapshot({
      phase: "executor",
      finishedAt: report.generatedAt,
      status: "ok"
    });
    return report;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    await createRedditRuntimeStore(config).persistRuntimeSnapshot({
      phase: "executor",
      finishedAt,
      status: "failed"
    }).catch(() => undefined);
    throw error;
  }
}
