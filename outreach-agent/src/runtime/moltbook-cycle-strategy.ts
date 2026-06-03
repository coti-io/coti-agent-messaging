import type { MoltbookRuntimeConfig } from "../config.js";
import type { MoltbookVenueProvider } from "../moltbook-venue.js";
import type { OutreachAgentState, PlannedAction } from "../policy.js";
import type { OutreachCycleStrategy, OutreachCycleContext } from "./run-outreach-cycle.js";
import {
  moltbookHeartbeatDraftContent,
  moltbookHeartbeatDiscoverCandidates,
  moltbookHeartbeatEnqueueJobs,
  moltbookHeartbeatLoadContext,
  moltbookHeartbeatPlanActions,
  moltbookHeartbeatReconcilePending,
  moltbookHeartbeatSelectBundle
} from "./moltbook-heartbeat-phases.js";

type MoltbookHeartbeatSources = Awaited<ReturnType<MoltbookVenueProvider["loadHeartbeatSources"]>>;

export interface MoltbookHeartbeatWorkspace {
  sources?: MoltbookHeartbeatSources;
  home?: MoltbookHeartbeatSources["home"];
  me?: MoltbookHeartbeatSources["me"];
  factSheet?: MoltbookHeartbeatSources["factSheet"];
  agentName?: string;
  persistState?: (nextState: OutreachAgentState) => Promise<void>;
  newAgent?: boolean;
  actionCandidates?: import("../action-planning.js").ConstrainedActionCandidate[];
  selectedBundle?: Awaited<
    ReturnType<typeof import("../moltbook-action-planning.js").chooseMoltbookActionBundle>
  >;
  planned?: PlannedAction[];
  deferredWriteActions?: PlannedAction[];
  writeCandidates?: import("../llm-content.js").WriteCandidate[];
  eligibleWriteCandidates?: import("../llm-content.js").WriteCandidate[];
  selectedWriteBlockedByConstraint?: boolean;
  scheduledActionJobs?: import("../action-planning.js").ActionJob[];
  nextJobNotBefore?: (actionType: import("../venue.js").VenueAction["type"], needsContent: boolean) => string;
}

export interface MoltbookHeartbeatSession {
  config: MoltbookRuntimeConfig;
  venue: MoltbookVenueProvider;
  report: Record<string, unknown>;
  state: OutreachAgentState;
  performed: string[];
  skipped: string[];
  runId: string;
  startedAt: string;
  workspace: MoltbookHeartbeatWorkspace;
  result?: {
    summary: string;
    performed: string[];
    skipped: string[];
    plannedActions: PlannedAction["type"][];
  };
}

export interface MoltbookExecutorSession {
  config: MoltbookRuntimeConfig;
  venue: MoltbookVenueProvider;
  report: Record<string, unknown>;
  state: OutreachAgentState;
  performed: string[];
  skipped: string[];
  result?: {
    summary: string;
    performed: string[];
    skipped: string[];
  };
}

export type MoltbookHeartbeatPhaseHooks = {
  [K in keyof OutreachCycleStrategy]?: (
    session: MoltbookHeartbeatSession,
    context: OutreachCycleContext
  ) => Promise<void>;
};

export type MoltbookExecutorPhaseHooks = {
  [K in keyof OutreachCycleStrategy]?: (
    session: MoltbookExecutorSession,
    context: OutreachCycleContext
  ) => Promise<void>;
};

function syncContextFromSession(
  context: OutreachCycleContext,
  session: { performed: string[]; skipped: string[] }
): void {
  context.performed.length = 0;
  context.performed.push(...session.performed);
  context.skipped.length = 0;
  context.skipped.push(...session.skipped);
}

function bindHeartbeatHook(
  hook: MoltbookHeartbeatPhaseHooks[keyof MoltbookHeartbeatPhaseHooks] | undefined,
  session: MoltbookHeartbeatSession
): OutreachCycleStrategy[keyof OutreachCycleStrategy] {
  if (!hook) {
    return undefined;
  }
  return async (context) => {
    await hook(session, context);
    syncContextFromSession(context, session);
  };
}

function bindExecutorHook(
  hook: MoltbookExecutorPhaseHooks[keyof MoltbookExecutorPhaseHooks] | undefined,
  session: MoltbookExecutorSession
): OutreachCycleStrategy[keyof OutreachCycleStrategy] {
  if (!hook) {
    return undefined;
  }
  return async (context) => {
    await hook(session, context);
    syncContextFromSession(context, session);
  };
}

export function createMoltbookHeartbeatStrategy(
  session: MoltbookHeartbeatSession,
  hooks: MoltbookHeartbeatPhaseHooks
): OutreachCycleStrategy {
  return {
    loadContext: bindHeartbeatHook(hooks.loadContext, session),
    executeDueJobs: bindHeartbeatHook(hooks.executeDueJobs, session),
    reconcilePending: bindHeartbeatHook(hooks.reconcilePending, session),
    discoverCandidates: bindHeartbeatHook(hooks.discoverCandidates, session),
    planActions: bindHeartbeatHook(hooks.planActions, session),
    selectBundle: bindHeartbeatHook(hooks.selectBundle, session),
    draftContent: bindHeartbeatHook(hooks.draftContent, session),
    enqueueJobs: bindHeartbeatHook(hooks.enqueueJobs, session),
    publish: bindHeartbeatHook(hooks.publish, session),
    buildReport: bindHeartbeatHook(hooks.buildReport, session)
  };
}

export function createMoltbookExecutorStrategy(
  session: MoltbookExecutorSession,
  hooks: MoltbookExecutorPhaseHooks
): OutreachCycleStrategy {
  return {
    loadContext: bindExecutorHook(hooks.loadContext, session),
    executeDueJobs: bindExecutorHook(hooks.executeDueJobs, session),
    buildReport: bindExecutorHook(hooks.buildReport, session)
  };
}

/** Heartbeat-specific order: select bundle before planning; enqueue before draft. */
export const MOLTBOOK_HEARTBEAT_PHASES = [
  "load_context",
  "execute_due_jobs",
  "reconcile_pending",
  "discover_candidates",
  "select_bundle",
  "plan_actions",
  "enqueue_jobs",
  "draft_content",
  "publish",
  "report"
] as const;

export const MOLTBOOK_EXECUTOR_PHASES = [
  "load_context",
  "execute_due_jobs",
  "report"
] as const;

export const DEFAULT_MOLTBOOK_HEARTBEAT_HOOKS: MoltbookHeartbeatPhaseHooks = {
  loadContext: (session) => moltbookHeartbeatLoadContext(session),
  reconcilePending: (session) => moltbookHeartbeatReconcilePending(session),
  discoverCandidates: (session) => moltbookHeartbeatDiscoverCandidates(session),
  selectBundle: (session) => moltbookHeartbeatSelectBundle(session),
  planActions: (session) => moltbookHeartbeatPlanActions(session),
  enqueueJobs: (session) => moltbookHeartbeatEnqueueJobs(session),
  draftContent: (session) => moltbookHeartbeatDraftContent(session)
};
