import type { MoltbookRuntimeConfig } from "../config.js";
import { chooseRedditActionBundle } from "../reddit-action-planning.js";
import type { RedditIngestionResult } from "../reddit-ingestion-types.js";
import type { VenueAction, VenueOutcome } from "../venue.js";
import type { RedditSessionReport } from "./reddit-types.js";
import type { RedditPlannerWorkspace } from "./reddit-cycle-strategy.js";
import {
  emptyIngestionSummary,
  summarizeActionCandidates,
  summarizeIngestion,
  summarizePlanner,
  summarizeQueuedRedditJobs
} from "./reddit-planner-support.js";

export interface RedditPlannerRunInput {
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
}

export interface RedditPlannerPhaseOptions {
  executeDueJobsFirst: boolean;
  allowImmediatePublish: boolean;
  now?: Date;
  rng?: () => number;
}

export function createRedditPlannerWorkspace(
  input: RedditPlannerRunInput,
  options: RedditPlannerPhaseOptions
): RedditPlannerWorkspace {
  return { input, options };
}

export function buildPlannerSessionReport(
  ws: RedditPlannerWorkspace,
  overrides: Partial<RedditSessionReport> & Pick<RedditSessionReport, "decision"> & {
    sessionLimits?: string[];
    pipeline?: RedditSessionReport["planner"]["pipeline"];
  }
): RedditSessionReport {
  const { operating, dryRun, duplicateCheckPolicy, now, memory, ingestion, gatedActionCandidates, selectedActionBundle, maxActions } = ws;
  if (!operating || dryRun === undefined || !duplicateCheckPolicy || !now || !memory) {
    throw new Error("Reddit planner workspace incomplete while building session report.");
  }
  const emptyBundle = overrides.selectedActionBundle ?? selectedActionBundle ?? chooseRedditActionBundle([], maxActions ?? 1);
  return {
    generatedAt: now.toISOString(),
    dryRun,
    duplicateCheckPolicy,
    readSource: operating.readController,
    memoryPath: operating.memoryPath,
    ingestion: ingestion ? summarizeIngestion(ingestion) : emptyIngestionSummary(),
    actionCandidates: gatedActionCandidates ? summarizeActionCandidates(gatedActionCandidates) : [],
    selectedActionBundle: emptyBundle,
    queuedActionJobs: overrides.queuedActionJobs ?? summarizeQueuedRedditJobs(memory),
    planner: summarizePlanner({
      skipped: overrides.decision.skipped,
      filterSummary: overrides.decision.filterSummary ?? ws.decision?.filterSummary,
      sessionLimits: overrides.sessionLimits,
      pipeline: overrides.pipeline ?? { llmDraft: "not_reached" }
    }),
    decision: overrides.decision,
    draft: overrides.draft,
    outcome: overrides.outcome,
    recorded: overrides.recorded
  };
}
