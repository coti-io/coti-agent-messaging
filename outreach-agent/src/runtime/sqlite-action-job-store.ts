import {
  loadStateFromStorage,
  saveStateToStorage,
  type StoredHeartbeatRun
} from "../storage.js";
import type { ActionJob } from "../action-planning.js";
import type { OutreachAgentState } from "../policy.js";
import type { ActionJobStore, AgentStateStore } from "./contracts.js";

export class SqliteAgentStateStore implements AgentStateStore {
  constructor(
    private readonly statePath: string,
    private readonly heartbeatReportPath: string
  ) {}

  loadState(): Promise<OutreachAgentState> {
    return loadStateFromStorage(this.statePath, this.heartbeatReportPath);
  }

  saveState(state: OutreachAgentState, runId?: string): Promise<OutreachAgentState> {
    return saveStateToStorage(this.statePath, state, runId);
  }
}

export class SqliteActionJobStore implements ActionJobStore {
  constructor(private readonly stateStore: AgentStateStore) {}

  async loadJobs(): Promise<ActionJob[]> {
    const state = await this.stateStore.loadState();
    return state.queuedActionJobs ?? [];
  }

  async saveJobs(jobs: readonly ActionJob[]): Promise<void> {
    const state = await this.stateStore.loadState();
    await this.stateStore.saveState({
      ...state,
      queuedActionJobs: [...jobs]
    });
  }
}

export async function hydrateStateQueuedJobsFromPaths(input: {
  statePath: string;
  heartbeatReportPath: string;
  jobs: readonly ActionJob[];
}): Promise<void> {
  const store = new SqliteAgentStateStore(input.statePath, input.heartbeatReportPath);
  const state = await store.loadState();
  if ((state.queuedActionJobs?.length ?? 0) > 0) {
    return;
  }
  if (input.jobs.length === 0) {
    return;
  }
  await store.saveState({
    ...state,
    queuedActionJobs: [...input.jobs]
  });
}

export function toStoredHeartbeatRun(input: {
  runId: string;
  agentId?: string;
  startedAt: string;
  finishedAt?: string;
  status: StoredHeartbeatRun["status"];
  summary?: string;
  dryRun: boolean;
  plannedActions?: string[];
  performed?: string[];
  skipped?: string[];
  errors?: unknown[];
  engagementSummary?: StoredHeartbeatRun["engagementSummary"];
}): StoredHeartbeatRun {
  return {
    runId: input.runId,
    agentId: input.agentId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status: input.status,
    summary: input.summary,
    dryRun: input.dryRun,
    plannedActions: input.plannedActions ?? [],
    performed: input.performed ?? [],
    skipped: input.skipped ?? [],
    errors: input.errors ?? [],
    reconciledPendingWrites: [],
    writeCandidates: [],
    engagementSummary: input.engagementSummary
  };
}
