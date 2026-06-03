import { getRedditOperatingAgentConfig, loadRuntimeConfig } from "./config.js";
import { createRuntimePorts } from "./runtime/create-runtime-ports.js";
import {
  createRedditPlannerStrategy,
  REDDIT_HEARTBEAT_PHASES,
  REDDIT_SESSION_PHASES,
  type RedditPlannerSession
} from "./runtime/reddit-cycle-strategy.js";
import {
  createRedditPlannerHooks,
  createRedditPlannerWorkspace,
  shouldRedditSessionPublishImmediately
} from "./runtime/reddit-planner-phases.js";
import { createCorrelationId } from "./runtime/correlation.js";
import { createRedditRuntimeStore } from "./runtime/reddit-runtime-store.js";
import type { RedditSessionReport } from "./runtime/reddit-types.js";
import { requireRedditPlannerSessionReport } from "./runtime/reddit-planner-internal.js";
import { runOutreachCycle } from "./runtime/run-outreach-cycle.js";
import type { VenueAction, VenueOutcome } from "./venue.js";
import type { MoltbookRuntimeConfig } from "./config.js";
import type { RedditIngestionResult } from "./reddit-ingestion.js";

export type { RedditSessionReport, RedditRuntimeReport } from "./runtime/reddit-types.js";
export { runRedditExecutor } from "./runtime/reddit-executor-run.js";
export {
  runRedditSessionCli,
  runRedditHeartbeatCli,
  runRedditExecutorCli
} from "./reddit-session-cli.js";

export async function runRedditSession(input: {
  config?: MoltbookRuntimeConfig;
  dryRun?: boolean;
  maxActions?: number;
  subreddits?: readonly string[];
  once?: boolean;
  fetchImpl?: typeof fetch;
  ingestion?: RedditIngestionResult;
  discoverySeed?: number;
  publishAction?: (action: VenueAction) => Promise<VenueOutcome>;
  now?: Date;
  rng?: () => number;
} = {}): Promise<RedditSessionReport> {
  const config = input.config ?? (await loadRuntimeConfig({ requireVenue: true }));
  const operating = getRedditOperatingAgentConfig(config);
  const plannerOptions = {
    executeDueJobsFirst: true,
    allowImmediatePublish: shouldRedditSessionPublishImmediately(),
    now: input.now,
    rng: input.rng
  };
  const session: RedditPlannerSession = {
    config,
    dryRun: input.dryRun ?? operating.dryRunDefault,
    performed: [],
    skipped: [],
    workspace: createRedditPlannerWorkspace(input, plannerOptions)
  };
  await runOutreachCycle({
    ports: createRuntimePorts(config),
    strategy: createRedditPlannerStrategy(session, createRedditPlannerHooks()),
    mode: "session",
    dryRun: session.dryRun,
    phases: [...REDDIT_SESSION_PHASES]
  });
  return requireRedditPlannerSessionReport(session);
}

export async function runRedditHeartbeat(input: {
  config?: MoltbookRuntimeConfig;
  dryRun?: boolean;
  maxActions?: number;
  subreddits?: readonly string[];
  once?: boolean;
  fetchImpl?: typeof fetch;
  ingestion?: RedditIngestionResult;
  discoverySeed?: number;
  publishAction?: (action: VenueAction) => Promise<VenueOutcome>;
  now?: Date;
  rng?: () => number;
} = {}): Promise<RedditSessionReport> {
  const config = input.config ?? await loadRuntimeConfig({ requireVenue: true });
  const startedAt = new Date().toISOString();
  const correlationId = createCorrelationId();
  const operating = getRedditOperatingAgentConfig(config);
  const plannerOptions = {
    executeDueJobsFirst: false,
    allowImmediatePublish: false,
    now: input.now,
    rng: input.rng
  };
  const session: RedditPlannerSession = {
    config,
    dryRun: input.dryRun ?? operating.dryRunDefault,
    performed: [],
    skipped: [],
    workspace: createRedditPlannerWorkspace({ ...input, config }, plannerOptions)
  };
  try {
    await runOutreachCycle({
      ports: createRuntimePorts(config),
      strategy: createRedditPlannerStrategy(session, createRedditPlannerHooks()),
      mode: "heartbeat",
      dryRun: session.dryRun,
      phases: [...REDDIT_HEARTBEAT_PHASES]
    });
    const report = requireRedditPlannerSessionReport(session);
    const runtimeStore = createRedditRuntimeStore(config);
    await runtimeStore.persistRuntimeSnapshot({
      phase: "heartbeat",
      finishedAt: report.generatedAt,
      status: "ok"
    });
    await runtimeStore.persistHeartbeatReport(
      runtimeStore.buildRuntimeReport({
        phase: "heartbeat",
        correlationId,
        startedAt,
        finishedAt: report.generatedAt,
        dryRun: report.dryRun,
        report,
        status: "ok",
        skipped: [],
        errors: []
      })
    );
    return report;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const runtimeStore = createRedditRuntimeStore(config);
    await runtimeStore.persistRuntimeSnapshot({
      phase: "heartbeat",
      finishedAt,
      status: "failed"
    }).catch(() => undefined);
    await runtimeStore.persistHeartbeatReport(
      runtimeStore.buildRuntimeReport({
        phase: "heartbeat",
        correlationId,
        startedAt,
        finishedAt,
        dryRun: input.dryRun ?? getRedditOperatingAgentConfig(config).dryRunDefault,
        report: undefined,
        status: "failed",
        skipped: [],
        errors: [
          {
            phase: "heartbeat",
            message: error instanceof Error ? error.message : String(error)
          }
        ]
      })
    ).catch(() => undefined);
    throw error;
  }
}
