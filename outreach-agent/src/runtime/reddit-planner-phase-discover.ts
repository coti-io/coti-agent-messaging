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


export async function redditPlannerDiscoverCandidates(session: RedditPlannerSession): Promise<void> {
  const ws = workspace(session);
  if (stopped(ws)) {
    return;
  }
  assertRedditPlannerWorkspaceReady(ws, "discover_candidates");
  const input = ws.input;
  const { config, operating, memory, redditVenue, now, dryRun, duplicateCheckPolicy, maxActions } = ws;
  if (!config || !operating || !memory || !redditVenue || !now || dryRun === undefined || !duplicateCheckPolicy || maxActions === undefined) {
    throw new Error("Reddit planner workspace missing context before discover_candidates.");
  }

  const ingestion = input.ingestion ?? await ingestRedditState({
    config,
    subreddits: input.subreddits?.length ? input.subreddits : undefined,
    subredditPool: operating.discoverySubredditPool,
    discoverySubsPerRun: operating.discoverySubsPerRun,
    scanLedger: memory.scanLedger ?? [],
    scanLedgerTtlHours: operating.scanLedgerTtlHours,
    scanLedgerMaxEntries: operating.scanLedgerMaxEntries,
    history: memory.history,
    source: operating.readController,
    limitPerSubreddit: operating.ingestionListLimit,
    maxOwnThreadReads: operating.ingestionMaxOwnThreadReads,
    maxDiscoveryThreadReads: operating.ingestionMaxDiscoveryThreadReads,
    maxSearchesPerSubreddit: operating.ingestionMaxSearchesPerSubreddit,
    ownThreadCommentLimit: operating.ingestionOwnThreadCommentLimit,
    discoverySeed: input.discoverySeed ?? parseDiscoverySeedFromEnv()
  });
  ws.memory = { ...memory, scanLedger: ingestion.scanLedger };
  redditVenue.applyIngestionResult(ingestion);
  ws.ingestion = ingestion;
  const plannerContext = resolveRedditPlannerContext(
    input.subreddits?.length
      ? input.subreddits
      : ingestion.sampledSubreddits.length > 0
        ? ingestion.sampledSubreddits
        : []
  );
  ws.plannerContext = plannerContext;
  const triageBatch = operating.llmTriageEnabled
    ? await triageRedditSourceItems({
        config,
        items: ingestion.sourceItems,
        targeting: plannerContext.targeting,
        activeSubredditNames: plannerContext.activeSubreddits,
        maxItems: operating.llmTriageMaxItems,
        fetchImpl: input.fetchImpl,
        now
      })
    : undefined;
  let decision = planRedditAction({
    items: ingestion.sourceItems,
    history: ws.memory.history,
    targeting: plannerContext.targeting,
    registry: plannerContext.registry,
    activeSubreddits: plannerContext.activeSubreddits,
    triageByItemId: triageBatch?.byItemId,
    duplicateCheckPolicy,
    config: {
      maxActionsPerSession: maxActions,
      minDelayMinutes: operating.minJitterMinutes,
      maxDelayMinutes: operating.maxJitterMinutes
    }
  });
  if (triageBatch) {
    decision.skipped.unshift(
      `LLM triage: ${triageBatch.triagedCount} items (${triageBatch.providerLabel ?? "unknown"}); ${triageBatch.skippedCount} not triaged (regex-only).`
    );
  }
  ws.decision = decision;
  const actionCandidates = buildRedditActionCandidates(decision);
  const subredditCooldowns = findRedditSubredditCooldowns(ws.memory.history, now);
  ws.subredditCooldowns = subredditCooldowns;
  ws.gatedActionCandidates =
    dryRun || subredditCooldowns.size === 0
      ? actionCandidates
      : applySubredditCooldownsToCandidates(actionCandidates, subredditCooldowns);
}
