import type { OutreachRuntimePhase, OutreachRuntimePorts } from "./contracts.js";
import { OUTREACH_RUNTIME_PIPELINE, runRuntimePhase } from "./outreach-runtime.js";

export type { OutreachRuntimePhase as OutreachCyclePhase };
export type OutreachCycleMode = "heartbeat" | "executor" | "session";

export interface OutreachCycleError {
  phase: OutreachRuntimePhase;
  message: string;
  name?: string;
}

export interface OutreachCycleResult {
  mode: OutreachCycleMode;
  dryRun: boolean;
  phasesRun: OutreachRuntimePhase[];
  performed: string[];
  skipped: string[];
  errors: OutreachCycleError[];
  report?: unknown;
}

export interface OutreachCycleContext {
  ports: OutreachRuntimePorts;
  mode: OutreachCycleMode;
  dryRun: boolean;
  phasesRun: OutreachRuntimePhase[];
  performed: string[];
  skipped: string[];
  errors: OutreachCycleError[];
}

type PhaseHandler = (context: OutreachCycleContext) => Promise<void>;

export interface OutreachCycleStrategy {
  loadContext?: PhaseHandler;
  executeDueJobs?: PhaseHandler;
  reconcilePending?: PhaseHandler;
  discoverCandidates?: PhaseHandler;
  planActions?: PhaseHandler;
  selectBundle?: PhaseHandler;
  draftContent?: PhaseHandler;
  enqueueJobs?: PhaseHandler;
  publish?: PhaseHandler;
  buildReport?: PhaseHandler;
}

const PHASE_HANDLERS: Record<OutreachRuntimePhase, keyof OutreachCycleStrategy> = {
  load_context: "loadContext",
  execute_due_jobs: "executeDueJobs",
  reconcile_pending: "reconcilePending",
  discover_candidates: "discoverCandidates",
  plan_actions: "planActions",
  select_bundle: "selectBundle",
  draft_content: "draftContent",
  enqueue_jobs: "enqueueJobs",
  publish: "publish",
  report: "buildReport"
};

export interface RunOutreachCycleInput {
  ports: OutreachRuntimePorts;
  strategy: OutreachCycleStrategy;
  mode: OutreachCycleMode;
  dryRun: boolean;
  phases?: readonly OutreachRuntimePhase[];
}

export async function runOutreachCycle(input: RunOutreachCycleInput): Promise<OutreachCycleResult> {
  const phases = input.phases ?? OUTREACH_RUNTIME_PIPELINE;
  const context: OutreachCycleContext = {
    ports: input.ports,
    mode: input.mode,
    dryRun: input.dryRun,
    phasesRun: [],
    performed: [],
    skipped: [],
    errors: []
  };

  for (const phase of phases) {
    const handlerKey = PHASE_HANDLERS[phase];
    const handler = input.strategy[handlerKey];
    if (!handler) {
      continue;
    }

    context.phasesRun.push(phase);
    try {
      await runRuntimePhase(phase, () => handler(context));
    } catch (error) {
      context.errors.push({
        phase,
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : undefined
      });
      throw error;
    }
  }

  return {
    mode: input.mode,
    dryRun: input.dryRun,
    phasesRun: context.phasesRun,
    performed: context.performed,
    skipped: context.skipped,
    errors: context.errors
  };
}
