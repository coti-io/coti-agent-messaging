import { getOutreachAgentConfig, getRedditControllerConfig, getRedditOperatingAgentConfig, type MoltbookRuntimeConfig } from "../config.js";
import { createActionJob } from "../action-planning.js";
import { hasActiveQueuedActionId, scheduleActionJobNotBefore } from "../action-execution.js";
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

export async function redditPlannerDraftContent(session: RedditPlannerSession): Promise<void> {
  const ws = workspace(session);
  if (stopped(ws)) {
    return;
  }
  assertRedditPlannerWorkspaceReady(ws, "draft_content");
  const input = ws.input;
  const { config, memory, plannerContext, plannedAction, decision, gatedActionCandidates, selectedActionBundle, now, dryRun, operating } = ws;
  if (!config || !memory || !plannerContext || !decision || !gatedActionCandidates || !selectedActionBundle || !now || dryRun === undefined || !operating) {
    throw new Error("Reddit planner workspace missing context before draft_content.");
  }
  if (!plannedAction) {
    return;
  }

  const selectedVariant = await selectPromptVariant({
    config,
    venue: "reddit",
    actionType: plannedAction.type === "reply_to_comment" ? "reply_to_activity" : "comment_on_post",
    fetchImpl: input.fetchImpl
  });
  ws.selectedVariant = selectedVariant;
  const adaptiveOverrides = resolveAdaptiveRedditPromptOverrides(memory.history, plannedAction.item.source.subreddit, now);
  try {
    ws.draft = await draftRedditResponse({
      config,
      item: plannedAction.item,
      targeting: plannerContext.targeting,
      actionType: plannedAction.type === "reply_to_comment" ? "reply_to_activity" : "comment_on_post",
      recentContent: memory.history.slice(-20).map((entry) => entry.content),
      promptVariantId: selectedVariant.variantId,
      promptParameterOverrides: {
        ...selectedVariant.parameterOverrides,
        ...adaptiveOverrides
      },
      fetchImpl: input.fetchImpl
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const draftFailedDecision = {
      ...decision,
      action: undefined,
      skipped: [...(ws.upvoteNotes ?? []), `Reddit draft generation failed: ${reason}`, ...decision.skipped]
    };
    setTerminal(ws, buildPlannerSessionReport(ws, {
      decision: draftFailedDecision,
      selectedActionBundle,
      pipeline: {
        upvoteAttempted: false,
        upvoteSucceeded: false,
        llmDraft: "failed",
        selectionSource: selectedActionBundle.strategy === "llm" ? "llm" : "deterministic_fallback"
      }
    }));
    return;
  }

  const upvoteResult = await tryUpvoteBeforeReply({
    config,
    operating,
    plannedAction,
    memory: ws.memory!,
    ingestion: ws.ingestion!,
    dryRun,
    now,
    publishAction: input.publishAction
  });
  ws.memory = upvoteResult.memory;
  if (upvoteResult.skipped.length > 0) {
    ws.decision = { ...decision, skipped: [...upvoteResult.skipped, ...decision.skipped] };
  }
  if (!dryRun && upvoteResult.succeeded) {
    await ws.runtimeStore!.save(ws.memory);
  }
  ws.upvotePipeline = {
    upvoteAttempted: upvoteResult.attempted,
    upvoteSucceeded: upvoteResult.succeeded
  };
  ws.upvoteNotes = upvoteResult.notes;
  ws.action = toVenueAction(plannedAction, ws.draft.content);
}

export async function redditPlannerEnqueueJobs(session: RedditPlannerSession): Promise<void> {
  const ws = workspace(session);
  if (stopped(ws)) {
    return;
  }
  if (!ws.plannedAction || !ws.draft) {
    return;
  }
  assertRedditPlannerWorkspaceReady(ws, "enqueue_jobs");
  const input = ws.input;
  const {
    config,
    memory,
    dryRun,
    plannedAction,
    draft,
    selectedVariant,
    action,
    decision,
    gatedActionCandidates,
    selectedActionBundle,
    now,
    upvoteNotes,
    upvotePipeline
  } = ws;
  if (!config || !memory || dryRun === undefined || !plannedAction || !draft || !selectedVariant || !action || !decision || !gatedActionCandidates || !selectedActionBundle || !now) {
    return;
  }

  let nextQueuedJobs = memory.queuedJobs ?? [];
  const queuedActionId = action.id;
  if (!dryRun && queuedActionId && hasActiveQueuedActionId(nextQueuedJobs, queuedActionId)) {
    ws.decision = {
      ...decision,
      skipped: [`Reddit action ${queuedActionId} is already queued.`, ...decision.skipped]
    };
    return;
  }
  if (!dryRun) {
    nextQueuedJobs = enqueueActionJobs(nextQueuedJobs, [
      createActionJob({
        action: {
          ...action,
          raw: {
            kind: "queued_reddit_write",
            plannedAction,
            promptProfileId: draft.promptProfileId,
            promptParameters: draft.promptParameters,
            layout: draft.layout,
            promptVariantId: selectedVariant.variantId,
            promptVariantLabel: selectedVariant.label,
            promptVariantRationale: selectedVariant.rationale,
            rotateAfterActions: selectedVariant.rotateAfterActions,
            reusedExisting: selectedVariant.reusedExisting,
            selectionSource: selectedVariant.selectionSource,
            selectionDebugPath: selectedVariant.selectionDebugPath,
            scopeKey: selectedVariant.scopeKey
          }
        },
        candidateId: plannedAction.item.id,
        sourceDecisionId: plannedAction.item.id,
        notBefore: scheduleActionJobNotBefore({
          now,
          actionType: action.type,
          order: nextQueuedJobs.length,
          needsContent: true,
          existingJobs: nextQueuedJobs,
          records: redditExecutionRecords(memory.history),
          config: config.actionExecution,
          rng: ws.options.rng
        })
      })
    ]);
    await ws.runtimeStore!.save({
      ...memory,
      queuedJobs: nextQueuedJobs
    });
    ws.nextQueuedJobs = nextQueuedJobs;
  }
}

export async function redditPlannerPublish(session: RedditPlannerSession): Promise<void> {
  const ws = workspace(session);
  if (stopped(ws) || ws.dryRun || !ws.options.allowImmediatePublish) {
    return;
  }
  if (!ws.plannedAction || !ws.draft) {
    return;
  }
  assertRedditPlannerWorkspaceReady(ws, "publish");
  const input = ws.input;
  const {
    config,
    operating,
    plannedAction,
    draft,
    decision,
    gatedActionCandidates,
    selectedActionBundle,
    selectedVariant,
    now,
    upvoteNotes,
    upvotePipeline,
    nextQueuedJobs
  } = ws;
  if (!config || !operating || !plannedAction || !draft || !decision || !gatedActionCandidates || !selectedActionBundle || !selectedVariant || !now) {
    return;
  }

  const storeAfterQueue = await ws.runtimeStore!.load();
  const executed = await executeQueuedRedditJob(storeAfterQueue, {
    config,
    publishAction: input.publishAction,
    now,
    fetchImpl: input.fetchImpl
  });
  if (executed?.executed) {
    setTerminal(ws, buildPlannerSessionReport(ws, {
      decision: { ...decision, action: plannedAction },
      selectedActionBundle,
      draft,
      outcome: executed.outcome,
      recorded: executed.recorded,
      queuedActionJobs: summarizeQueuedRedditJobs(executed.store),
      pipeline: {
        ...upvotePipeline,
        llmDraft: "succeeded",
        selectionSource: selectedVariant.selectionSource
      }
    }));
  }
}

export async function redditPlannerBuildReport(session: RedditPlannerSession): Promise<void> {
  const ws = workspace(session);
  if (ws.terminalReport) {
    session.report = ws.terminalReport;
    return;
  }
  const {
    config,
    operating,
    memory,
    dryRun,
    duplicateCheckPolicy,
    ingestion,
    gatedActionCandidates,
    selectedActionBundle,
    plannedAction,
    draft,
    decision,
    now,
    upvoteNotes,
    upvotePipeline,
    selectedVariant,
    nextQueuedJobs
  } = ws;
  if (!operating || dryRun === undefined || !duplicateCheckPolicy || !now || !decision || !gatedActionCandidates || !selectedActionBundle) {
    throw new Error("Reddit planner workspace missing context before report.");
  }
  if (!plannedAction || !draft) {
    session.report = buildPlannerSessionReport(ws, { decision });
    return;
  }

  const recorded: RedditDecisionMemoryEntry = {
    id: `${dryRun ? "draft" : "outcome"}:${plannedAction.item.source.id}:${Date.now()}`,
    decisionId: plannedAction.item.id,
    subreddit: plannedAction.item.source.subreddit,
    kind: plannedAction.type === "reply_to_comment" ? "reply" : "comment",
    action: dryRun
      ? "skipped"
      : plannedAction.type === "reply_to_comment"
        ? "replied"
        : "commented",
    content: draft.content,
    createdAt: now.toISOString(),
    targetId: plannedAction.item.source.id,
    targetTitle: resolveRedditTargetTitle(plannedAction.item.source),
    targetUrl: resolveRedditTargetUrl(plannedAction.item.source),
    targetSummary: plannedAction.item.source.body ?? plannedAction.item.source.title,
    nextEligibleAt: dryRun ? undefined : plannedAction.nextEligibleAt,
    status: dryRun ? "drafted" : "posted",
    firstReply: true,
    productMentioned: false,
    linkIncluded: false,
    promptProfileId: draft.promptProfileId,
    promptVariantId: selectedVariant?.variantId,
    promptVariantRationale: selectedVariant?.rationale,
    promptParameters: draft.promptParameters,
    layout: draft.layout as RedditDecisionMemoryEntry["layout"],
    structuralFingerprint: structuralFingerprint(draft.content),
    controller: getRedditControllerConfig(config!).controller,
    decisionReason: plannedAction.reason,
    relevanceScore: plannedAction.item.relevanceScore,
    riskScore: plannedAction.item.riskScore,
    remoteContentUrl: ws.outcome?.remoteContentUrl,
    threadPostId: resolveThreadPostId(plannedAction, ws.outcome?.remoteContentUrl)
  };
  if (dryRun && config) {
    await appendRedditMemory(operating.memoryPath, recorded);
  }

  session.report = buildPlannerSessionReport(ws, {
    decision: { ...decision, action: plannedAction },
    draft,
    outcome: ws.outcome,
    recorded: dryRun ? recorded : undefined,
    selectedActionBundle,
    queuedActionJobs: dryRun
      ? summarizeQueuedRedditJobs(memory!)
      : summarizeQueuedRedditJobs({ ...memory!, queuedJobs: nextQueuedJobs }),
    pipeline: {
      ...upvotePipeline,
      llmDraft: "succeeded",
      selectionSource:
        selectedActionBundle.strategy === "llm"
          ? "llm"
          : selectedVariant?.selectionSource ?? "deterministic_fallback"
    }
  });
}
