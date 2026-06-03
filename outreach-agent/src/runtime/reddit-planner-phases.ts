export type { RedditPlannerRunInput, RedditPlannerPhaseOptions } from "./reddit-planner-workspace.js";
export { createRedditPlannerWorkspace } from "./reddit-planner-workspace.js";
export { buildPlannerSessionReport } from "./reddit-planner-workspace.js";
export { redditPlannerLoadContext, redditPlannerExecuteDueJobs } from "./reddit-planner-phase-context.js";
export { redditPlannerDiscoverCandidates } from "./reddit-planner-phase-discover.js";
export { redditPlannerPlanActions, redditPlannerSelectBundle } from "./reddit-planner-phase-plan.js";
export {
  redditPlannerDraftContent,
  redditPlannerEnqueueJobs,
  redditPlannerPublish,
  redditPlannerBuildReport
} from "./reddit-planner-phase-write.js";
import type { RedditPlannerPhaseHooks } from "./reddit-cycle-strategy.js";
import { redditPlannerLoadContext, redditPlannerExecuteDueJobs } from "./reddit-planner-phase-context.js";
import { redditPlannerDiscoverCandidates } from "./reddit-planner-phase-discover.js";
import { redditPlannerPlanActions, redditPlannerSelectBundle } from "./reddit-planner-phase-plan.js";
import {
  redditPlannerDraftContent,
  redditPlannerEnqueueJobs,
  redditPlannerPublish,
  redditPlannerBuildReport
} from "./reddit-planner-phase-write.js";
import { shouldPublishQueuedActionImmediately } from "./reddit-planner-support.js";

export const DEFAULT_REDDIT_PLANNER_HOOKS: RedditPlannerPhaseHooks = {
  loadContext: redditPlannerLoadContext,
  executeDueJobs: redditPlannerExecuteDueJobs,
  discoverCandidates: redditPlannerDiscoverCandidates,
  planActions: redditPlannerPlanActions,
  selectBundle: redditPlannerSelectBundle,
  draftContent: redditPlannerDraftContent,
  enqueueJobs: redditPlannerEnqueueJobs,
  publish: redditPlannerPublish,
  buildReport: redditPlannerBuildReport
};

export function createRedditPlannerHooks(): RedditPlannerPhaseHooks {
  return DEFAULT_REDDIT_PLANNER_HOOKS;
}

export function shouldRedditSessionPublishImmediately(): boolean {
  return shouldPublishQueuedActionImmediately();
}
