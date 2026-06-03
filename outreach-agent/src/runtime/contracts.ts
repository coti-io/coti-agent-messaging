import type { ActionJob } from "../action-planning.js";
import type { EngagementSummary, OutreachAgentState } from "../policy.js";
import type { StoredHeartbeatRun } from "../storage.js";
import type { OutreachVenueId, VenueProvider } from "../venue.js";

/** Ordered steps shared by Moltbook and Reddit runtimes. */
export type OutreachRuntimePhase =
  | "load_context"
  | "execute_due_jobs"
  | "reconcile_pending"
  | "discover_candidates"
  | "plan_actions"
  | "select_bundle"
  | "draft_content"
  | "enqueue_jobs"
  | "publish"
  | "report";

export interface RuntimePaths {
  statePath: string;
  storagePath: string;
  heartbeatReportPath: string;
  attributionDbPath?: string;
  promptRotationStatePath?: string;
}

export interface OutreachRuntimeContext {
  venue: OutreachVenueId;
  phase: "heartbeat" | "executor" | "session";
  dryRun: boolean;
  paths: RuntimePaths;
  provider: VenueProvider;
}

export interface ActionJobStore {
  loadJobs(): Promise<ActionJob[]>;
  saveJobs(jobs: readonly ActionJob[]): Promise<void>;
}

export interface RunReporter {
  /** Canonical row in state.sqlite heartbeat_runs. */
  persistRun(report: StoredHeartbeatRun): Promise<void>;
  /** Full venue-specific report JSON at last-heartbeat.json. */
  writeLatestReport(report: unknown): Promise<void>;
  appendRunHistory(report: unknown): Promise<void>;
}

export interface AgentStateStore {
  loadState(): Promise<OutreachAgentState>;
  saveState(state: OutreachAgentState, runId?: string): Promise<OutreachAgentState>;
}

export interface OutboundMemoryStore {
  readonly venue: OutreachVenueId;
  /** Venue-specific memory path when not fully modeled in AgentStateStore. */
  memoryPath?: string;
}

export interface AnalyticsReadModel {
  schemaVersion: 1;
  generatedAt: string;
  agentId?: string;
  venue: OutreachVenueId;
  venueAccountId?: string;
  runtimeKind: "heartbeat" | "executor" | "session";
  paths: {
    statePath: string;
    storagePath: string;
    heartbeatReportPath: string;
    attributionDbPath?: string;
    promptRotationStatePath?: string;
    redditMemoryPath?: string;
  };
  scheduler: {
    lastHeartbeatAt?: string;
    lastSuccessfulRunAt?: string;
    latestStatus?: string;
    health: "fresh" | "stale" | "unknown";
  };
  engagementSummary?: EngagementSummary;
  pendingWork: {
    pendingWrites: number;
    queuedJobs: number;
  };
  latestRun?: {
    runId: string;
    phase?: string;
    status: string;
    startedAt: string;
    finishedAt?: string;
    summary?: string;
  };
}

export interface AnalyticsReadModelWriter {
  write(model: AnalyticsReadModel): Promise<void>;
  readModelPath(): string;
}

export interface OutreachRuntimePorts {
  jobs: ActionJobStore;
  runs: RunReporter;
  state: AgentStateStore;
  analytics: AnalyticsReadModelWriter;
  memory?: OutboundMemoryStore;
}
