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


export async function redditPlannerLoadContext(session: RedditPlannerSession): Promise<void> {
  const ws = workspace(session);
  if (stopped(ws)) {
    return;
  }
  const input = ws.input;
  const config = input.config ?? await loadRuntimeConfig({ requireVenue: true });
  const agent = getOutreachAgentConfig(config);
  if (agent.venue !== "reddit") {
    throw new Error("reddit-session requires OUTREACH_AGENT_VENUE=reddit.");
  }
  const operating = getRedditOperatingAgentConfig(config);
  const dryRun = input.dryRun ?? operating.dryRunDefault;
  const duplicateCheckPolicy = resolveRedditSessionDuplicateCheckPolicy(dryRun);
  const maxActions = input.maxActions ?? operating.maxActionsPerSession;
  const runtimeStore = createRedditRuntimeStore(config);
  let memory = await runtimeStore.load();
  ws.runtimeStore = runtimeStore;
  const redditVenue = assertRedditVenueProvider(createVenueProvider(config));
  const now = ws.options.now ?? new Date();
  ws.config = config;
  ws.operating = operating;
  ws.dryRun = dryRun;
  ws.duplicateCheckPolicy = duplicateCheckPolicy;
  ws.maxActions = maxActions;
  ws.memory = memory;
  ws.redditVenue = redditVenue;
  ws.now = now;

  const recentKillReason = findKillSwitch(memory.history);
  if (recentKillReason) {
    setTerminal(ws, buildRedditBlockedSessionReport({
      now,
      dryRun,
      duplicateCheckPolicy,
      operating,
      memory,
      decision: {
        skipped: [recentKillReason],
        candidates: [],
        plannedCandidates: [],
        filterSummary: emptyRedditFilterSummary()
      },
      maxActions,
      sessionLimits: [recentKillReason],
      pipeline: { llmDraft: "not_reached" }
    }));
    return;
  }

  const accountHealth = await verifyRedditAccountHealth({
    config,
    memory,
    memoryPath: operating.memoryPath,
    now,
    fetchImpl: input.fetchImpl
  });
  ws.memory = accountHealth.memory;
  if (accountHealth.blockedReason) {
    setTerminal(ws, buildRedditBlockedSessionReport({
      now,
      dryRun,
      duplicateCheckPolicy,
      operating,
      memory: accountHealth.memory,
      decision: {
        skipped: [accountHealth.blockedReason],
        candidates: [],
        plannedCandidates: [],
        filterSummary: emptyRedditFilterSummary()
      },
      maxActions,
      sessionLimits: [accountHealth.blockedReason],
      pipeline: { llmDraft: "not_reached" },
      accountHealth: accountHealth.health
    }));
  }
}

export async function redditPlannerExecuteDueJobs(session: RedditPlannerSession): Promise<void> {
  const ws = workspace(session);
  if (stopped(ws) || !ws.options.executeDueJobsFirst) {
    return;
  }
  assertRedditPlannerWorkspaceReady(ws, "execute_due_jobs");
  const { config, memory, operating, dryRun, duplicateCheckPolicy, now, maxActions } = ws;
  const input = ws.input;
  if (!config || !memory || !operating || dryRun === undefined || !duplicateCheckPolicy || !now || maxActions === undefined) {
    throw new Error("Reddit planner workspace missing context before execute_due_jobs.");
  }
  if (dryRun) {
    return;
  }

  const executed = await executeQueuedRedditJob(memory, {
    config,
    publishAction: input.publishAction,
    now,
    fetchImpl: input.fetchImpl
  });
  if (executed?.executed) {
    setTerminal(ws, {
      generatedAt: now.toISOString(),
      dryRun,
      duplicateCheckPolicy,
      readSource: operating.readController,
      memoryPath: operating.memoryPath,
      ingestion: emptyIngestionSummary(),
      actionCandidates: [],
      selectedActionBundle: chooseRedditActionBundle([], maxActions),
      queuedActionJobs: summarizeQueuedRedditJobs(executed.store),
      decision: {
        action: undefined,
        plannedCandidates: [],
        skipped: ["Executed one queued Reddit action instead of planning a new one."],
        candidates: [],
        filterSummary: emptyRedditFilterSummary()
      },
      planner: summarizePlanner({
        skipped: ["Executed one queued Reddit action instead of planning a new one."],
        pipeline: { llmDraft: "not_reached" }
      }),
      outcome: executed.outcome,
      recorded: executed.recorded
    });
  }
}
