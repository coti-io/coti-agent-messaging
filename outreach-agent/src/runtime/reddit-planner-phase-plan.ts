import { getOutreachAgentConfig, getRedditControllerConfig, getRedditOperatingAgentConfig, loadRuntimeConfig, type MoltbookRuntimeConfig } from "../config.js";
import { createActionJob } from "../action-planning.js";
import { scheduleActionJobNotBefore } from "../action-execution.js";
import { draftRedditResponse } from "../reddit-drafting.js";
import { ingestRedditState, resolveRedditTargetTitle, resolveRedditTargetUrl } from "../reddit-ingestion.js";
import { enqueueActionJobs } from "../job-queue.js";
import { appendRedditMemory, type RedditDecisionMemoryEntry } from "../reddit-memory.js";
import {
  buildRedditActionCandidates,
  chooseRedditActionBundle,
  chooseRedditActionBundleWithLlm,
  plannedRedditActionFromCandidate
} from "../reddit-action-planning.js";
import { triageRedditSourceItems } from "../reddit-triage.js";
import { tryUpvoteBeforeReply } from "../reddit-upvote.js";
import {
  emptyRedditFilterSummary,
  planRedditAction,
  resolveRedditPlannerContext
} from "../reddit-policy.js";
import { assertRedditVenueProvider, createVenueProvider } from "../venue-factory.js";
import { selectPromptVariant } from "../prompt-rotation.js";
import type { VenueAction, VenueOutcome } from "../venue.js";
import type { RedditSessionReport } from "./reddit-types.js";
import { createRedditRuntimeStore } from "./reddit-runtime-store.js";
import type { RedditPlannerSession } from "./reddit-cycle-strategy.js";
import {
  applySubredditCooldownsToCandidates,
  buildRedditBlockedSessionReport,
  emptyIngestionSummary,
  findDailyActionLimitReason,
  findKillSwitch,
  findRedditSubredditCooldowns,
  findSessionCooldownReason,
  parseDiscoverySeedFromEnv,
  resolveAdaptiveRedditPromptOverrides,
  resolveRedditSessionDuplicateCheckPolicy,
  resolveThreadPostId,
  structuralFingerprint,
  summarizeActionCandidates,
  summarizePlanner,
  summarizeQueuedRedditJobs,
  summarizeRedditSubredditCooldowns,
  toVenueAction,
  verifyRedditAccountHealth
} from "./reddit-planner-support.js";
import { executeQueuedRedditJob, redditExecutionRecords } from "./reddit-job-executor.js";
import { assertRedditPlannerWorkspaceReady } from "./reddit-planner-workspace-invariants.js";
import { buildPlannerSessionReport } from "./reddit-planner-workspace.js";
import { setTerminal, stopped, workspace } from "./reddit-planner-internal.js";


export async function redditPlannerPlanActions(session: RedditPlannerSession): Promise<void> {
  const ws = workspace(session);
  if (stopped(ws)) {
    return;
  }
  assertRedditPlannerWorkspaceReady(ws, "plan_actions");
  const { operating, memory, now, dryRun, decision, gatedActionCandidates, maxActions } = ws;
  if (!operating || !memory || !now || dryRun === undefined || !decision || !gatedActionCandidates || maxActions === undefined) {
    throw new Error("Reddit planner workspace missing context before plan_actions.");
  }

  const dailyLimitReason = findDailyActionLimitReason(memory.history, operating.maxActionsPerDay, now);
  if (dailyLimitReason) {
    const limitedDecision = {
      ...decision,
      action: undefined,
      skipped: [dailyLimitReason, ...decision.skipped]
    };
    setTerminal(ws, buildPlannerSessionReport(ws, {
      decision: limitedDecision,
      sessionLimits: [dailyLimitReason],
      pipeline: { llmDraft: "not_reached" }
    }));
    return;
  }

  const cooldownReason = dryRun ? undefined : findSessionCooldownReason(memory.history, now);
  if (cooldownReason) {
    const cooledDecision = {
      ...decision,
      action: undefined,
      skipped: [cooldownReason, ...decision.skipped]
    };
    setTerminal(ws, buildPlannerSessionReport(ws, {
      decision: cooledDecision,
      sessionLimits: [cooldownReason],
      pipeline: { llmDraft: "not_reached" }
    }));
    return;
  }
}

export async function redditPlannerSelectBundle(session: RedditPlannerSession): Promise<void> {
  const ws = workspace(session);
  if (stopped(ws)) {
    return;
  }
  assertRedditPlannerWorkspaceReady(ws, "select_bundle");
  const input = ws.input;
  const { config, operating, decision, gatedActionCandidates, maxActions, now, dryRun, subredditCooldowns } = ws;
  if (!config || !operating || !decision || !gatedActionCandidates || maxActions === undefined || !now || dryRun === undefined) {
    throw new Error("Reddit planner workspace missing context before select_bundle.");
  }

  const selectedActionBundle =
    operating.llmSelectEnabled && gatedActionCandidates.length > 0
      ? await chooseRedditActionBundleWithLlm({
          config,
          candidates: gatedActionCandidates,
          maxActions,
          fetchImpl: input.fetchImpl
        })
      : chooseRedditActionBundle(gatedActionCandidates, maxActions);
  ws.selectedActionBundle = selectedActionBundle;

  const selectedAction = selectedActionBundle.selectedWriteCandidateId
    ? gatedActionCandidates.find((candidate) => candidate.id === selectedActionBundle.selectedWriteCandidateId)
    : undefined;
  const plannedAction = selectedAction ? plannedRedditActionFromCandidate(selectedAction) : undefined;
  ws.plannedAction = plannedAction;
  if (!plannedAction || maxActions < 1) {
    const subredditLimitReasons = summarizeRedditSubredditCooldowns(subredditCooldowns ?? new Map(), now);
    const emptyDecision = {
      ...decision,
      action: undefined,
      skipped: [...subredditLimitReasons, ...decision.skipped]
    };
    setTerminal(ws, buildPlannerSessionReport(ws, {
      decision: emptyDecision,
      selectedActionBundle,
      sessionLimits: subredditLimitReasons,
      pipeline: {
        llmDraft: "not_reached",
        selectionSource: selectedActionBundle.strategy === "llm" ? "llm" : "deterministic_fallback"
      }
    }));
  }
}
