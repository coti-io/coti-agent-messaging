import type { OutreachRuntimePhase, OutreachRuntimePorts } from "./contracts.js";

export interface OutreachRuntimeStepResult {
  phase: OutreachRuntimePhase;
  skipped?: string;
  performed?: string[];
}

/**
 * Documents the shared runtime pipeline. Venue adapters invoke these phases
 * in order; implementations remain in heartbeat.ts and reddit-session.ts until
 * fully extracted.
 */
export const OUTREACH_RUNTIME_PIPELINE: readonly OutreachRuntimePhase[] = [
  "load_context",
  "execute_due_jobs",
  "reconcile_pending",
  "discover_candidates",
  "plan_actions",
  "select_bundle",
  "draft_content",
  "enqueue_jobs",
  "publish",
  "report"
] as const;

export async function runRuntimePhase<T>(
  phase: OutreachRuntimePhase,
  runner: () => Promise<T>
): Promise<T> {
  return await runner();
}

export function summarizeRuntimePorts(ports: OutreachRuntimePorts): Record<string, string> {
  return {
    jobs: "SqliteActionJobStore",
    runs: "CompositeRunReporter",
    state: "SqliteAgentStateStore",
    analytics: "FileAnalyticsReadModelWriter",
    memory: ports.memory ? `${ports.memory.venue}-memory` : "none"
  };
}
