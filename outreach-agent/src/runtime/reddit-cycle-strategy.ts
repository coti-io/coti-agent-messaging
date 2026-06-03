import type { MoltbookRuntimeConfig } from "../config.js";
import type { ConstrainedActionCandidate } from "../action-planning.js";
import type { ActionJob } from "../action-planning.js";
import type { RedditIngestionResult } from "../reddit-ingestion.js";
import type { RedditMemoryStore } from "../reddit-memory.js";
import type { RedditSessionReport } from "./reddit-types.js";
import type { RedditVenueProvider } from "../reddit-venue.js";
import type { VenueAction, VenueOutcome } from "../venue.js";
import type { OutreachCycleStrategy, OutreachCycleContext } from "./run-outreach-cycle.js";
import type { RedditPlannerPhaseOptions, RedditPlannerRunInput } from "./reddit-planner-phases.js";
import type { RedditRuntimeStore } from "./reddit-runtime-store.js";

export type { RedditPlannerRunInput, RedditPlannerPhaseOptions } from "./reddit-planner-phases.js";

export interface RedditPlannerWorkspace {
  input: RedditPlannerRunInput;
  options: RedditPlannerPhaseOptions;
  runtimeStore?: RedditRuntimeStore;
  terminalReport?: RedditSessionReport;
  config?: MoltbookRuntimeConfig;
  operating?: ReturnType<typeof import("../config.js").getRedditOperatingAgentConfig>;
  dryRun?: boolean;
  duplicateCheckPolicy?: import("../reddit-outreach.js").RedditDuplicateCheckPolicy;
  maxActions?: number;
  memory?: RedditMemoryStore;
  redditVenue?: RedditVenueProvider;
  now?: Date;
  ingestion?: RedditIngestionResult;
  plannerContext?: ReturnType<typeof import("../reddit-policy.js").resolveRedditPlannerContext>;
  decision?: RedditSessionReport["decision"];
  actionCandidates?: ConstrainedActionCandidate[];
  gatedActionCandidates?: ConstrainedActionCandidate[];
  subredditCooldowns?: Map<string, { subreddit: string; until: string; reason: string }>;
  selectedActionBundle?: RedditSessionReport["selectedActionBundle"];
  plannedAction?: NonNullable<RedditSessionReport["decision"]["action"]>;
  selectedVariant?: Awaited<ReturnType<typeof import("../prompt-rotation.js").selectPromptVariant>>;
  adaptiveOverrides?: Record<string, unknown>;
  upvotePipeline?: { upvoteAttempted: boolean; upvoteSucceeded: boolean };
  upvoteNotes?: string[];
  draft?: RedditSessionReport["draft"] & {
    promptProfileId?: string;
    promptParameters?: import("../prompt-profile.js").PromptParameterSet;
    layout?: string;
  };
  action?: VenueAction;
  nextQueuedJobs?: ActionJob[];
  outcome?: VenueOutcome;
  recorded?: import("../reddit-memory.js").RedditDecisionMemoryEntry;
}

export interface RedditPlannerSession {
  config: MoltbookRuntimeConfig;
  dryRun: boolean;
  report?: RedditSessionReport;
  performed: string[];
  skipped: string[];
  workspace: RedditPlannerWorkspace;
}

export type RedditPlannerPhaseHooks = {
  [K in keyof OutreachCycleStrategy]?: (
    session: RedditPlannerSession,
    context: OutreachCycleContext
  ) => Promise<void>;
};

function syncContextFromSession(
  context: OutreachCycleContext,
  session: RedditPlannerSession
): void {
  context.performed.length = 0;
  context.performed.push(...session.performed);
  context.skipped.length = 0;
  context.skipped.push(...session.skipped);
}

function bindPlannerHook(
  hook: RedditPlannerPhaseHooks[keyof RedditPlannerPhaseHooks] | undefined,
  session: RedditPlannerSession
): OutreachCycleStrategy[keyof OutreachCycleStrategy] {
  if (!hook) {
    return undefined;
  }
  return async (context) => {
    await hook(session, context);
    syncContextFromSession(context, session);
  };
}

export function createRedditPlannerStrategy(
  session: RedditPlannerSession,
  hooks: RedditPlannerPhaseHooks
): OutreachCycleStrategy {
  return {
    loadContext: bindPlannerHook(hooks.loadContext, session),
    executeDueJobs: bindPlannerHook(hooks.executeDueJobs, session),
    reconcilePending: bindPlannerHook(hooks.reconcilePending, session),
    discoverCandidates: bindPlannerHook(hooks.discoverCandidates, session),
    planActions: bindPlannerHook(hooks.planActions, session),
    selectBundle: bindPlannerHook(hooks.selectBundle, session),
    draftContent: bindPlannerHook(hooks.draftContent, session),
    enqueueJobs: bindPlannerHook(hooks.enqueueJobs, session),
    publish: bindPlannerHook(hooks.publish, session),
    buildReport: bindPlannerHook(hooks.buildReport, session)
  };
}

/** Reddit: plan_actions applies session limits before select_bundle; draft before enqueue. */
export const REDDIT_SESSION_PHASES = [
  "load_context",
  "execute_due_jobs",
  "discover_candidates",
  "plan_actions",
  "select_bundle",
  "draft_content",
  "enqueue_jobs",
  "publish",
  "report"
] as const;

export const REDDIT_HEARTBEAT_PHASES = [
  "load_context",
  "discover_candidates",
  "plan_actions",
  "select_bundle",
  "draft_content",
  "enqueue_jobs",
  "report"
] as const;

export const REDDIT_EXECUTOR_PHASES = ["load_context", "execute_due_jobs", "report"] as const;
