import { readFile } from "node:fs/promises";

import {
  loadRuntimeConfig,
  type MoltbookRuntimeConfig
} from "./config.js";
import {
  createInitialState,
  getEngagementSummary,
  normalizeState,
  type OutreachAgentState,
  type PlannedAction
} from "./policy.js";
import {
  readPromptRotationDebugSnapshot
} from "./prompt-rotation.js";
import { assertMoltbookVenueProvider, createVenueProvider } from "./venue-factory.js";
import { createRuntimePorts } from "./runtime/create-runtime-ports.js";
import {
  persistMoltbookHeartbeatReport,
  writeMoltbookAnalyticsReadModel
} from "./runtime/heartbeat-persist.js";
import {
  createMoltbookExecutorStrategy,
  createMoltbookHeartbeatStrategy,
  DEFAULT_MOLTBOOK_HEARTBEAT_HOOKS,
  MOLTBOOK_EXECUTOR_PHASES,
  MOLTBOOK_HEARTBEAT_PHASES,
  type MoltbookExecutorSession,
  type MoltbookHeartbeatSession
} from "./runtime/moltbook-cycle-strategy.js";
import { loadMoltbookAgentState, saveMoltbookAgentState } from "./runtime/moltbook-state-persist.js";
import { createCorrelationId } from "./runtime/correlation.js";
import { runOutreachCycle } from "./runtime/run-outreach-cycle.js";
import type { HeartbeatReport } from "./heartbeat-types.js";
import {
  executeDueActionJobs,
  toHeartbeatError,
  formatErrorMessage
} from "./runtime/moltbook-job-runtime.js";

export interface HeartbeatResult {
  summary: string;
  performed: string[];
  skipped: string[];
  plannedActions: PlannedAction["type"][];
}

export interface ExecutorResult {
  summary: string;
  performed: string[];
  skipped: string[];
}

async function readOptionalUtf8(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function saveHeartbeatReport(
  statePath: string,
  heartbeatReportPath: string,
  report: HeartbeatReport
): Promise<void> {
  await persistMoltbookHeartbeatReport({ statePath, heartbeatReportPath }, report);
}

async function readPreviousHeartbeatReport(heartbeatReportPath: string): Promise<Partial<HeartbeatReport> | undefined> {
  const raw = await readOptionalUtf8(heartbeatReportPath);
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as Partial<HeartbeatReport>;
  } catch {
    return undefined;
  }
}

function formatSummary(performed: string[], skipped: string[]): string {
  if (performed.length === 0 && skipped.length === 0) {
    return "HEARTBEAT_OK - Checked Moltbook, all good.";
  }

  const parts: string[] = [];
  if (performed.length > 0) {
    parts.push(performed.join(" "));
  }

  if (skipped.length > 0) {
    parts.push(`Skipped: ${skipped.join(" ")}`);
  }

  return parts.join(" ");
}

function formatExecutorSummary(performed: string[], skipped: string[]): string {
  if (performed.length === 0 && skipped.length === 0) {
    return "EXECUTOR_OK - No queued jobs were due.";
  }
  const parts: string[] = [];
  if (performed.length > 0) {
    parts.push(performed.join(" "));
  }
  if (skipped.length > 0) {
    parts.push(`Skipped: ${skipped.join(" ")}`);
  }
  return parts.join(" ");
}

export async function runHeartbeat(
  configInput?: MoltbookRuntimeConfig
): Promise<HeartbeatResult> {
  const config = configInput ?? (await loadRuntimeConfig({ requireVenue: true }));
  const venue = assertMoltbookVenueProvider(createVenueProvider(config));
  if (!config.apiKey) {
    throw new Error(
      "Missing Moltbook API key. Set MOLTBOOK_API_KEY or save credentials via the register command."
    );
  }
  const startedAt = new Date().toISOString();
  const runId = `${startedAt}:${process.pid}`;
  const correlationId = createCorrelationId();
  const previousReport = await readPreviousHeartbeatReport(config.heartbeatReportPath);
  const report: HeartbeatReport = {
    runId,
    correlationId,
    agentId: config.agentId,
    startedAt,
    status: "running",
    dryRun: config.dryRun,
    failureStreak: 0,
    alerts: [],
    plannedActions: [],
    performed: [],
    skipped: [],
    errors: [],
    reconciledPendingWrites: [],
    writeCandidates: [],
    actionCandidates: [],
    queuedActionJobs: []
  };
  let state = createInitialState();
  const session: MoltbookHeartbeatSession = {
    config,
    venue,
    report: report as unknown as Record<string, unknown>,
    state,
    performed: [],
    skipped: [],
    runId,
    startedAt,
    workspace: {}
  };

  const finalizeHeartbeatResult = (): HeartbeatResult => {
    const performed = session.performed;
    const skipped = session.skipped;
    const planned = session.workspace.planned ?? [];
    const result = {
      summary: formatSummary(performed, skipped),
      performed,
      skipped,
      plannedActions: planned.map((entry) => entry.type)
    };
    report.status = report.errors.length > 0 ? "degraded" : "ok";
    report.summary = result.summary;
    report.performed = result.performed;
    report.skipped = result.skipped;
    report.engagementSummary = getEngagementSummary(session.state);
    return result;
  };

  try {
    await runOutreachCycle({
      ports: createRuntimePorts(config),
      strategy: createMoltbookHeartbeatStrategy(session, {
        ...DEFAULT_MOLTBOOK_HEARTBEAT_HOOKS,
        buildReport: async () => {
          session.state = normalizeState(
            {
              ...session.state,
              agentId: config.agentId ?? session.state.agentId,
              lastHeartbeatAt: new Date().toISOString()
            },
            new Date()
          );
          session.state = await saveMoltbookAgentState(config.statePath, session.state, runId);
          session.result = finalizeHeartbeatResult();
        }
      }),
      mode: "heartbeat",
      dryRun: config.dryRun,
      phases: [...MOLTBOOK_HEARTBEAT_PHASES]
    });
    return session.result!;
  } catch (error) {
    state = session.state;
    state = normalizeState(
      {
        ...state,
        agentId: config.agentId ?? state.agentId,
        lastHeartbeatAt: new Date().toISOString()
      },
      new Date()
    );
    state = await saveMoltbookAgentState(config.statePath, state, runId);
    report.status = "failed";
    report.errors.push(toHeartbeatError("heartbeat", error));
    report.summary = `HEARTBEAT_FAILED - ${formatErrorMessage(error)}`;
    report.engagementSummary = getEngagementSummary(state);
    throw error;
  } finally {
    finalizeHeartbeatAlerts(report, previousReport);
    report.promptRotation = await readPromptRotationDebugSnapshot(config).then((snapshot) => ({
      statePath: snapshot.statePath,
      auditPath: snapshot.auditPath,
      currentScopeKey: snapshot.currentScopeKey,
      currentScope: snapshot.currentScope,
      buckets: snapshot.buckets,
      recentHistory: snapshot.recentHistory.map((entry) => ({
        id: entry.id,
        scopeKey: entry.scopeKey,
        status: entry.status,
        eventType: entry.eventType,
        promptVariantId: entry.promptVariantId,
        promptVariantLabel: entry.promptVariantLabel,
        selectionSource: entry.selectionSource,
        reusedExisting: entry.reusedExisting,
        rotateAfterActions: entry.rotateAfterActions,
        actionsSinceRotation: entry.actionsSinceRotation,
        selectionRationale: entry.selectionRationale,
        createdAt: entry.createdAt,
        correlationId: entry.correlationId,
        debugInputPath: entry.debugInputPath
      }))
    })).catch(() => undefined);
    report.finishedAt = new Date().toISOString();
    await saveHeartbeatReport(config.statePath, config.heartbeatReportPath, report);
    await writeMoltbookAnalyticsReadModel(config, report).catch(() => undefined);
  }
}

export async function runExecutor(
  configInput?: MoltbookRuntimeConfig
): Promise<ExecutorResult> {
  const config = configInput ?? (await loadRuntimeConfig({ requireVenue: true }));
  const venue = assertMoltbookVenueProvider(createVenueProvider(config));
  if (!config.apiKey) {
    throw new Error(
      "Missing Moltbook API key. Set MOLTBOOK_API_KEY or save credentials via the register command."
    );
  }

  let state = createInitialState();
  const report: HeartbeatReport = {
    runId: `executor:${new Date().toISOString()}:${process.pid}`,
    correlationId: createCorrelationId(),
    agentId: config.agentId,
    startedAt: new Date().toISOString(),
    status: "running",
    dryRun: config.dryRun,
    failureStreak: 0,
    alerts: [],
    plannedActions: [],
    performed: [],
    skipped: [],
    errors: [],
    reconciledPendingWrites: [],
    writeCandidates: [],
    actionCandidates: [],
    queuedActionJobs: []
  };

  const session: MoltbookExecutorSession = {
    config,
    venue,
    report: report as unknown as Record<string, unknown>,
    state,
    performed: [],
    skipped: []
  };

  const persistState = async (nextState: OutreachAgentState): Promise<void> => {
    session.state = normalizeState({
      ...nextState,
      agentId: config.agentId ?? nextState.agentId
    });
    session.state = await saveMoltbookAgentState(config.statePath, session.state);
  };

  await runOutreachCycle({
    ports: createRuntimePorts(config),
    strategy: createMoltbookExecutorStrategy(session, {
      loadContext: async () => {
        session.state = normalizeState(
          await loadMoltbookAgentState(config.statePath, config.heartbeatReportPath)
        );
      },
      executeDueJobs: async () => {
        session.state = await executeDueActionJobs(
          venue,
          session.state,
          report,
          persistState,
          config,
          config.dryRun,
          session.performed,
          session.skipped
        );
      },
      buildReport: async () => {
        session.result = {
          summary: formatExecutorSummary(session.performed, session.skipped),
          performed: session.performed,
          skipped: session.skipped
        };
      }
    }),
    mode: "executor",
    dryRun: config.dryRun,
    phases: [...MOLTBOOK_EXECUTOR_PHASES]
  });

  return session.result!;
}

function finalizeHeartbeatAlerts(report: HeartbeatReport, previousReport: Partial<HeartbeatReport> | undefined): void {
  const previousStreak =
    previousReport?.status === "failed" || previousReport?.status === "degraded"
      ? Number(previousReport.failureStreak) || 1
      : 0;

  if (report.status === "failed") {
    report.failureStreak = previousStreak + 1;
    report.alerts.push({
      severity: report.failureStreak >= 2 ? "critical" : "warning",
      message: `Heartbeat failed; failure streak is ${report.failureStreak}.`
    });
    return;
  }

  if (report.status === "degraded") {
    report.failureStreak = previousStreak + 1;
    report.alerts.push({
      severity: report.failureStreak >= 3 ? "critical" : "warning",
      message: `Heartbeat completed with ${report.errors.length} error${report.errors.length === 1 ? "" : "s"}; failure streak is ${report.failureStreak}.`
    });
    return;
  }

  report.failureStreak = 0;
}
