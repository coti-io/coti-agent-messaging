import type { OutreachRuntimePhase } from "./contracts.js";
import type { RedditPlannerWorkspace } from "./reddit-cycle-strategy.js";

export type RedditPlannerInvariantPhase =
  | "execute_due_jobs"
  | "discover_candidates"
  | "plan_actions"
  | "select_bundle"
  | "draft_content"
  | "enqueue_jobs"
  | "publish"
  | "build_report";

export function assertRedditPlannerWorkspaceReady(
  ws: RedditPlannerWorkspace,
  phase: RedditPlannerInvariantPhase
): void {
  const require = (condition: boolean, message: string): void => {
    if (!condition) {
      throw new Error(`Reddit planner workspace not ready before ${phase}: ${message}`);
    }
  };

  switch (phase) {
    case "execute_due_jobs":
      require(ws.config !== undefined, "missing config after load_context");
      require(ws.memory !== undefined, "missing memory after load_context");
      require(ws.now !== undefined, "missing now after load_context");
      require(ws.dryRun !== undefined, "missing dryRun after load_context");
      return;
    case "discover_candidates":
      require(ws.config !== undefined, "missing config");
      require(ws.memory !== undefined, "missing memory");
      require(ws.redditVenue !== undefined, "missing redditVenue");
      require(ws.now !== undefined, "missing now");
      return;
    case "plan_actions":
      require(ws.decision !== undefined, "missing decision after discover_candidates");
      require(ws.gatedActionCandidates !== undefined, "missing gatedActionCandidates after discover_candidates");
      require(ws.operating !== undefined, "missing operating");
      return;
    case "select_bundle":
      require(ws.decision !== undefined, "missing decision");
      require(ws.gatedActionCandidates !== undefined, "missing gatedActionCandidates");
      require(ws.maxActions !== undefined, "missing maxActions");
      return;
    case "draft_content":
      require(ws.selectedActionBundle !== undefined, "missing selectedActionBundle after select_bundle");
      require(ws.plannerContext !== undefined, "missing plannerContext");
      return;
    case "enqueue_jobs":
      require(ws.draft !== undefined, "missing draft after draft_content");
      require(ws.action !== undefined, "missing action after draft_content");
      require(ws.plannedAction !== undefined, "missing plannedAction");
      return;
    case "publish":
      require(ws.nextQueuedJobs !== undefined || ws.dryRun === true, "missing nextQueuedJobs after enqueue_jobs in live mode");
      return;
    case "build_report":
      return;
    default:
      return;
  }
}

/** Phases that must run before select_bundle on Reddit (limits before bundle pick). */
export const REDDIT_PRE_SELECT_PHASES: readonly OutreachRuntimePhase[] = [
  "load_context",
  "discover_candidates",
  "plan_actions"
] as const;

export const REDDIT_PRE_DRAFT_PHASES: readonly OutreachRuntimePhase[] = [
  ...REDDIT_PRE_SELECT_PHASES,
  "select_bundle"
] as const;

export const REDDIT_PRE_ENQUEUE_PHASES: readonly OutreachRuntimePhase[] = [
  ...REDDIT_PRE_DRAFT_PHASES,
  "draft_content"
] as const;
