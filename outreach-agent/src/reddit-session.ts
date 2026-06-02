import { readFile } from "node:fs/promises";

import { getOutreachAgentConfig, getRedditControllerConfig, getRedditOperatingAgentConfig, loadRuntimeConfig } from "./config.js";
import { appendHeartbeatRunHistory } from "./heartbeat-run-history.js";
import {
  checkRedditAccountHealth,
  isRedditAccountUsable,
  redditAccountHealthSkipReason,
  type RedditAccountHealth
} from "./reddit-account-health.js";
import { computeActionJobNotBefore, createActionJob, type ActionJob, type ConstrainedActionCandidate, type ActionConstraint } from "./action-planning.js";
import { draftRedditResponse } from "./reddit-drafting.js";
import {
  recordPromptRotationAction,
  selectPromptVariant,
  type PromptRotationHistoryEntry
} from "./prompt-rotation.js";
import {
  ingestRedditState,
  parseRedditThreadUrl,
  resolveRedditTargetTitle,
  resolveRedditTargetUrl
} from "./reddit-ingestion.js";
import { enqueueActionJobs, removeActionJob, summarizeActionJobs } from "./job-queue.js";
import {
  appendRedditMemory,
  loadRedditMemory,
  saveRedditMemory,
  writeJsonAtomic,
  type RedditMemoryStore
} from "./reddit-memory.js";
import {
  buildRedditActionCandidates,
  chooseRedditActionBundle,
  chooseRedditActionBundleWithLlm,
  plannedRedditActionFromCandidate
} from "./reddit-action-planning.js";
import { triageRedditSourceItems } from "./reddit-triage.js";
import { planRedditAction, emptyRedditFilterSummary, resolveRedditPlannerContext, type RedditPlannerFilterSummary } from "./reddit-policy.js";
import { type RedditDuplicateCheckPolicy } from "./reddit-outreach.js";
import { redditMemoryEntryCountsTowardPublishedLimits } from "./reddit-outreach.js";
import type { RedditDecisionMemoryEntry } from "./reddit-memory.js";
import { createVenueProvider } from "./venue-factory.js";
import type { VenueAction, VenueOutcome } from "./venue.js";
import type { MoltbookRuntimeConfig } from "./config.js";
import type { RedditIngestionDiagnostics, RedditIngestionResult } from "./reddit-ingestion.js";
import { verifyPublicRedditCommentVisibility } from "./reddit-visibility-verification.js";
import type { PromptParameterSet } from "./prompt-profile.js";

export interface RedditSessionReport {
  generatedAt: string;
  dryRun: boolean;
  duplicateCheckPolicy: RedditDuplicateCheckPolicy;
  readSource: "browser" | "api" | "auto" | "reddapi" | "unofficial";
  memoryPath: string;
  ingestion: {
    snapshotCount: number;
    sourceItemCount: number;
    ownThreadTargets: number;
    ownThreadSnapshots: number;
    discoveryThreadSnapshots: number;
    skipped: string[];
    diagnostics: RedditIngestionDiagnostics;
  };
  planner: {
    skipped: string[];
    blockedGateSample: Array<{ id: string; gates: string[] }>;
    filterSummary?: import("./reddit-policy.js").RedditPlannerFilterSummary;
    sessionLimits?: string[];
    pipeline?: {
      llmDraft: "not_reached" | "failed" | "succeeded";
      selectionSource?: "llm" | "deterministic_fallback";
    };
  };
  actionCandidates: Array<{
    id: string;
    type: string;
    source: string;
    score: number;
    allowed: boolean;
    needsContent: boolean;
    blockedBy: string[];
  }>;
  selectedActionBundle?: {
    selectedCandidateIds: string[];
    selectedWriteCandidateId?: string;
    selectedNoContentCandidateIds: string[];
    deferredCandidateIds: string[];
    rationale: string;
    strategy?: "llm" | "deterministic_fallback";
  };
  queuedActionJobs: Array<{
    id: string;
    type: string;
    candidateId: string;
    status: ActionJob["status"];
    notBefore: string;
  }>;
  decision: ReturnType<typeof planRedditAction>;
  draft?: {
    content: string;
    rationale: string;
  };
  outcome?: VenueOutcome;
  recorded?: RedditDecisionMemoryEntry;
}

interface RedditPlannerPhaseOptions {
  executeDueJobsFirst: boolean;
  allowImmediatePublish: boolean;
  now?: Date;
  rng?: () => number;
}

interface RedditRuntimeReport {
  runId: string;
  phase: "heartbeat" | "executor";
  startedAt: string;
  finishedAt: string;
  status: "ok" | "failed";
  summary: string;
  dryRun: boolean;
  skipped: string[];
  errors: Array<{ phase: string; message: string }>;
  actionCandidates: RedditSessionReport["actionCandidates"];
  selectedActionBundle?: RedditSessionReport["selectedActionBundle"];
  queuedActionJobs: RedditSessionReport["queuedActionJobs"];
  ingestion: RedditSessionReport["ingestion"];
  planner: RedditSessionReport["planner"];
  outcome?: VenueOutcome;
  recorded?: RedditDecisionMemoryEntry;
}

export async function runRedditSession(input: {
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
} = {}): Promise<RedditSessionReport> {
  return await runRedditPlannerPhase(input, {
    executeDueJobsFirst: true,
    allowImmediatePublish: shouldPublishQueuedActionImmediately(),
    now: input.now,
    rng: input.rng
  });
}

async function runRedditPlannerPhase(input: {
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
}, options: RedditPlannerPhaseOptions): Promise<RedditSessionReport> {
  const config = input.config ?? await loadRuntimeConfig({ requireVenue: true });
  const agent = getOutreachAgentConfig(config);
  if (agent.venue !== "reddit") {
    throw new Error("reddit-session requires OUTREACH_AGENT_VENUE=reddit.");
  }
  const operating = getRedditOperatingAgentConfig(config);
  const dryRun = input.dryRun ?? operating.dryRunDefault;
  const duplicateCheckPolicy = resolveRedditSessionDuplicateCheckPolicy(dryRun);
  const maxActions = input.maxActions ?? operating.maxActionsPerSession;
  let memory = await loadRedditMemory(operating.memoryPath);
  const now = options.now ?? new Date();
  const recentKillReason = findKillSwitch(memory.history);
  if (recentKillReason) {
    const decision: ReturnType<typeof planRedditAction> = {
      skipped: [recentKillReason],
      candidates: [],
      plannedCandidates: [],
      filterSummary: emptyRedditFilterSummary()
    };
    return buildRedditBlockedSessionReport({
      now,
      dryRun,
      duplicateCheckPolicy,
      operating,
      memory,
      decision,
      maxActions,
      sessionLimits: [recentKillReason],
      pipeline: { llmDraft: "not_reached" }
    });
  }

  const accountHealth = await verifyRedditAccountHealth({
    config,
    memory,
    memoryPath: operating.memoryPath,
    now,
    fetchImpl: input.fetchImpl
  });
  memory = accountHealth.memory;
  if (accountHealth.blockedReason) {
    const decision: ReturnType<typeof planRedditAction> = {
      skipped: [accountHealth.blockedReason],
      candidates: [],
      plannedCandidates: [],
      filterSummary: emptyRedditFilterSummary()
    };
    return buildRedditBlockedSessionReport({
      now,
      dryRun,
      duplicateCheckPolicy,
      operating,
      memory,
      decision,
      maxActions,
      sessionLimits: [accountHealth.blockedReason],
      pipeline: { llmDraft: "not_reached" },
      accountHealth: accountHealth.health
    });
  }

  if (!dryRun && options.executeDueJobsFirst) {
    const executed = await executeQueuedRedditJob(memory, {
      config,
      publishAction: input.publishAction,
      now,
      fetchImpl: input.fetchImpl
    });
    if (executed) {
      return {
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
      };
    }
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
  memory = { ...memory, scanLedger: ingestion.scanLedger };
  const plannerContext = resolveRedditPlannerContext(
    input.subreddits?.length
      ? input.subreddits
      : ingestion.sampledSubreddits.length > 0
        ? ingestion.sampledSubreddits
        : []
  );
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
  const decision = planRedditAction({
    items: ingestion.sourceItems,
    history: memory.history,
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
  const actionCandidates = buildRedditActionCandidates(decision);
  const subredditCooldowns = findRedditSubredditCooldowns(memory.history, now);
  const gatedActionCandidates =
    dryRun || subredditCooldowns.size === 0
      ? actionCandidates
      : applySubredditCooldownsToCandidates(actionCandidates, subredditCooldowns);
  const emptyBundle = chooseRedditActionBundle([], maxActions);

  const dailyLimitReason = findDailyActionLimitReason(memory.history, operating.maxActionsPerDay, now);
  if (dailyLimitReason) {
    const limitedDecision = {
      ...decision,
      action: undefined,
      skipped: [dailyLimitReason, ...decision.skipped]
    };
    return {
      generatedAt: now.toISOString(),
      dryRun,
      duplicateCheckPolicy,
      readSource: operating.readController,
      memoryPath: operating.memoryPath,
      ingestion: summarizeIngestion(ingestion),
      actionCandidates: summarizeActionCandidates(gatedActionCandidates),
      selectedActionBundle: emptyBundle,
      queuedActionJobs: summarizeQueuedRedditJobs(memory),
      planner: summarizePlanner({
        skipped: limitedDecision.skipped,
        filterSummary: decision.filterSummary,
        sessionLimits: [dailyLimitReason],
        pipeline: { llmDraft: "not_reached" }
      }),
      decision: limitedDecision
    };
  }

  const cooldownReason = dryRun ? undefined : findSessionCooldownReason(memory.history, now);
  if (cooldownReason) {
    const cooledDecision = {
      ...decision,
      action: undefined,
      skipped: [cooldownReason, ...decision.skipped]
    };
    return {
      generatedAt: now.toISOString(),
      dryRun,
      duplicateCheckPolicy,
      readSource: operating.readController,
      memoryPath: operating.memoryPath,
      ingestion: summarizeIngestion(ingestion),
      actionCandidates: summarizeActionCandidates(gatedActionCandidates),
      selectedActionBundle: emptyBundle,
      queuedActionJobs: summarizeQueuedRedditJobs(memory),
      planner: summarizePlanner({
        skipped: cooledDecision.skipped,
        filterSummary: decision.filterSummary,
        sessionLimits: [cooldownReason],
        pipeline: { llmDraft: "not_reached" }
      }),
      decision: cooledDecision
    };
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

  const selectedAction = selectedActionBundle.selectedWriteCandidateId
    ? gatedActionCandidates.find((candidate) => candidate.id === selectedActionBundle.selectedWriteCandidateId)
    : undefined;
  const plannedAction = selectedAction ? plannedRedditActionFromCandidate(selectedAction) : undefined;
  if (!plannedAction || maxActions < 1) {
    const subredditLimitReasons = summarizeRedditSubredditCooldowns(subredditCooldowns, now);
    const emptyDecision = {
      ...decision,
      action: undefined,
      skipped: [...subredditLimitReasons, ...decision.skipped]
    };
    return {
      generatedAt: now.toISOString(),
      dryRun,
      duplicateCheckPolicy,
      readSource: operating.readController,
      memoryPath: operating.memoryPath,
      ingestion: summarizeIngestion(ingestion),
      actionCandidates: summarizeActionCandidates(gatedActionCandidates),
      selectedActionBundle,
      queuedActionJobs: summarizeQueuedRedditJobs(memory),
      planner: summarizePlanner({
        skipped: emptyDecision.skipped,
        filterSummary: decision.filterSummary,
        sessionLimits: subredditLimitReasons,
        pipeline: {
          llmDraft: "not_reached",
          selectionSource:
            selectedActionBundle.strategy === "llm" ? "llm" : "deterministic_fallback"
        }
      }),
      decision: emptyDecision
    };
  }

  const selectedVariant = await selectPromptVariant({
    config,
    venue: "reddit",
    actionType: plannedAction.type === "reply_to_comment" ? "reply_to_activity" : "comment_on_post",
    fetchImpl: input.fetchImpl
  });
  const adaptiveOverrides = resolveAdaptiveRedditPromptOverrides(memory.history, plannedAction.item.source.subreddit, now);
  let draft;
  try {
    draft = await draftRedditResponse({
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
      skipped: [`Reddit draft generation failed: ${reason}`, ...decision.skipped]
    };
    return {
      generatedAt: now.toISOString(),
      dryRun,
      duplicateCheckPolicy,
      readSource: operating.readController,
      memoryPath: operating.memoryPath,
      ingestion: summarizeIngestion(ingestion),
      actionCandidates: summarizeActionCandidates(gatedActionCandidates),
      selectedActionBundle,
      queuedActionJobs: summarizeQueuedRedditJobs(memory),
      planner: summarizePlanner({
        skipped: draftFailedDecision.skipped,
        filterSummary: decision.filterSummary,
        pipeline: {
          llmDraft: "failed",
          selectionSource:
            selectedActionBundle.strategy === "llm" ? "llm" : "deterministic_fallback"
        }
      }),
      decision: draftFailedDecision
    };
  }
  const action = toVenueAction(plannedAction, draft.content);
  let outcome: VenueOutcome | undefined;
  let nextQueuedJobs = memory.queuedJobs ?? [];

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
        notBefore: computeActionJobNotBefore({
          now,
          order: 0,
          needsContent: true,
          rng: options.rng
        })
      })
    ]).slice(-1);
    await saveRedditMemory(operating.memoryPath, {
      ...memory,
      queuedJobs: nextQueuedJobs
    });
    if (options.allowImmediatePublish) {
      const storeAfterQueue = await loadRedditMemory(operating.memoryPath);
      const executed = await executeQueuedRedditJob(storeAfterQueue, {
        config,
        publishAction: input.publishAction,
        now,
        fetchImpl: input.fetchImpl
      });
      if (executed) {
        return {
          generatedAt: now.toISOString(),
          dryRun,
          duplicateCheckPolicy,
          readSource: operating.readController,
          memoryPath: operating.memoryPath,
          ingestion: summarizeIngestion(ingestion),
        actionCandidates: summarizeActionCandidates(gatedActionCandidates),
          selectedActionBundle,
          queuedActionJobs: summarizeQueuedRedditJobs(executed.store),
          planner: summarizePlanner({
            skipped: decision.skipped,
            filterSummary: decision.filterSummary,
            pipeline: {
              llmDraft: "succeeded",
              selectionSource: selectedVariant.selectionSource
            }
          }),
          decision: {
            ...decision,
            action: plannedAction
          },
          draft,
          outcome: executed.outcome,
          recorded: executed.recorded
        };
      }
    }
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
    promptVariantId: selectedVariant.variantId,
    promptVariantRationale: selectedVariant.rationale,
    promptParameters: draft.promptParameters,
    layout: draft.layout,
    structuralFingerprint: structuralFingerprint(draft.content),
    controller: getRedditControllerConfig(config).controller,
    decisionReason: plannedAction.reason,
    relevanceScore: plannedAction.item.relevanceScore,
    riskScore: plannedAction.item.riskScore,
    remoteContentUrl: outcome?.remoteContentUrl,
    threadPostId: resolveThreadPostId(plannedAction, outcome?.remoteContentUrl)
  };
  if (dryRun) {
    await appendRedditMemory(operating.memoryPath, recorded);
  }

  return {
    generatedAt: now.toISOString(),
    dryRun,
    duplicateCheckPolicy,
    readSource: operating.readController,
    memoryPath: operating.memoryPath,
    ingestion: summarizeIngestion(ingestion),
    actionCandidates: summarizeActionCandidates(gatedActionCandidates),
    selectedActionBundle,
    queuedActionJobs: dryRun ? summarizeQueuedRedditJobs(memory) : summarizeQueuedRedditJobs({ ...memory, queuedJobs: nextQueuedJobs }),
    planner: summarizePlanner({
      skipped: decision.skipped,
      filterSummary: decision.filterSummary,
      pipeline: {
        llmDraft: "succeeded",
        selectionSource:
          selectedActionBundle.strategy === "llm"
            ? "llm"
            : selectedVariant.selectionSource ?? "deterministic_fallback"
      }
    }),
    decision: {
      ...decision,
      action: plannedAction
    },
    draft,
    outcome,
    recorded: dryRun ? recorded : undefined
  };
}

export async function runRedditHeartbeat(input: {
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
} = {}): Promise<RedditSessionReport> {
  const config = input.config ?? await loadRuntimeConfig({ requireVenue: true });
  const startedAt = new Date().toISOString();
  try {
    const report = await runRedditPlannerPhase(
      {
        ...input,
        config
      },
      {
        executeDueJobsFirst: false,
        allowImmediatePublish: false,
        now: input.now,
        rng: input.rng
      }
    );
    await persistRedditRuntimeSnapshot(config, {
      phase: "heartbeat",
      finishedAt: report.generatedAt,
      status: "ok"
    });
    await persistRedditHeartbeatReport(
      config,
      buildRedditRuntimeReport({
        phase: "heartbeat",
        startedAt,
        finishedAt: report.generatedAt,
        dryRun: report.dryRun,
        report,
        status: "ok",
        skipped: [],
        errors: []
      })
    );
    return report;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    await persistRedditRuntimeSnapshot(config, {
      phase: "heartbeat",
      finishedAt,
      status: "failed"
    }).catch(() => undefined);
    await persistRedditHeartbeatReport(
      config,
      buildRedditRuntimeReport({
        phase: "heartbeat",
        startedAt,
        finishedAt,
        dryRun: input.dryRun ?? getRedditOperatingAgentConfig(config).dryRunDefault,
        report: undefined,
        status: "failed",
        skipped: [],
        errors: [
          {
            phase: "heartbeat",
            message: error instanceof Error ? error.message : String(error)
          }
        ]
      })
    ).catch(() => undefined);
    throw error;
  }
}

export async function runRedditExecutor(input: {
  config?: MoltbookRuntimeConfig;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  publishAction?: (action: VenueAction) => Promise<VenueOutcome>;
  now?: Date;
} = {}): Promise<RedditSessionReport> {
  const config = input.config ?? await loadRuntimeConfig({ requireVenue: true });
  const agent = getOutreachAgentConfig(config);
  if (agent.venue !== "reddit") {
    throw new Error("reddit-executor requires OUTREACH_AGENT_VENUE=reddit.");
  }
  const operating = getRedditOperatingAgentConfig(config);
  const dryRun = input.dryRun ?? operating.dryRunDefault;
  const now = input.now ?? new Date();

  if (dryRun) {
    const store = await loadRedditMemory(operating.memoryPath);
    const report = buildExecutorSessionReport({
      now,
      dryRun,
      operating,
      store,
      skipped: ["Reddit executor skipped because dry-run mode is enabled."]
    });
    await persistRedditRuntimeSnapshot(config, {
      phase: "executor",
      finishedAt: report.generatedAt,
      status: "ok"
    });
    return report;
  }

  try {
    const store = await loadRedditMemory(operating.memoryPath);
    const accountHealth = await verifyRedditAccountHealth({
      config,
      memory: store,
      memoryPath: operating.memoryPath,
      now,
      fetchImpl: input.fetchImpl
    });
    if (accountHealth.blockedReason) {
      const report = buildExecutorSessionReport({
        now,
        dryRun,
        operating,
        store: accountHealth.memory,
        skipped: [accountHealth.blockedReason]
      });
      await persistRedditRuntimeSnapshot(config, {
        phase: "executor",
        finishedAt: report.generatedAt,
        status: "ok"
      });
      return report;
    }

    const executed = await executeQueuedRedditJob(accountHealth.memory, {
      config,
      publishAction: input.publishAction,
      now,
      fetchImpl: input.fetchImpl
    });
    const nextStore = executed?.store ?? store;
    const report = buildExecutorSessionReport({
      now,
      dryRun,
      operating,
      store: nextStore,
      outcome: executed?.outcome,
      recorded: executed?.recorded,
      skipped: executed ? ["Executed one queued Reddit action."] : ["No queued Reddit actions were due."]
    });
    await persistRedditRuntimeSnapshot(config, {
      phase: "executor",
      finishedAt: report.generatedAt,
      status: "ok"
    });
    return report;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    await persistRedditRuntimeSnapshot(config, {
      phase: "executor",
      finishedAt,
      status: "failed"
    }).catch(() => undefined);
    throw error;
  }
}

async function persistRedditHeartbeatReport(
  config: MoltbookRuntimeConfig,
  report: RedditRuntimeReport
): Promise<void> {
  const operating = getRedditOperatingAgentConfig(config);
  const store = await loadRedditMemory(operating.memoryPath);
  const engagementSummary = summarizeRedditHistory(store.history, new Date(report.finishedAt));
  const enrichedReport = {
    ...report,
    engagementSummary
  };
  await writeJsonAtomic(config.heartbeatReportPath, enrichedReport);
  await appendHeartbeatRunHistory(config.heartbeatReportPath, enrichedReport);
}

async function persistRedditRuntimeSnapshot(
  config: MoltbookRuntimeConfig,
  input: {
    phase: "heartbeat" | "executor";
    finishedAt: string;
    status: "ok" | "failed";
  }
): Promise<void> {
  const operating = getRedditOperatingAgentConfig(config);
  const controller = getRedditControllerConfig(config);
  const store = await loadRedditMemory(operating.memoryPath);
  const previousState = await readOptionalJsonRecord(config.statePath);
  const engagementSummary = summarizeRedditHistory(store.history, new Date(input.finishedAt));
  const recentGeneratedArtifacts = store.history
    .filter((entry) => entry.status === "posted" || entry.status === "spam_filtered")
    .slice(-20)
    .map((entry) => ({
      id: entry.id,
      type: entry.kind,
      createdAt: entry.createdAt,
      title: entry.kind === "post" ? entry.targetTitle : undefined,
      content: entry.content,
      targetSummary: entry.targetSummary ?? entry.targetTitle,
      promptProfileId: entry.promptProfileId,
      promptVariantId: entry.promptVariantId,
      promptVariantRationale: entry.promptVariantRationale,
      promptParameters: entry.promptParameters,
      layout: entry.layout,
      outreachRef: entry.remoteContentUrl
        ? {
            remoteContentUrl: entry.remoteContentUrl
          }
        : undefined
    }));
  const latestComment = [...store.history]
    .filter((entry) => isRedditPublishedHistoryEntry(entry) && (entry.kind === "comment" || entry.kind === "reply"))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  const latestPost = [...store.history]
    .filter((entry) => isRedditPublishedHistoryEntry(entry) && entry.kind === "post")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];

  await writeJsonAtomic(config.statePath, {
    ...previousState,
    generatedAt: input.finishedAt,
    venue: "reddit",
    controller: controller.controller,
    readSource: operating.readController,
    memoryPath: operating.memoryPath,
    queuedActionJobs: store.queuedJobs ?? [],
    engagementEvents: buildRedditEngagementEvents(store.history),
    engagementTotals: engagementSummary.total,
    recentGeneratedArtifacts,
    lastCommentAt: latestComment?.createdAt,
    lastPostAt: latestPost?.createdAt,
    ...(input.phase === "heartbeat"
      ? {
          lastHeartbeatAt: input.finishedAt,
          latestStatus: input.status
        }
      : {
          lastExecutorAt: input.finishedAt,
          lastExecutorStatus: input.status
        })
  });
}

function buildExecutorSessionReport(input: {
  now: Date;
  dryRun: boolean;
  operating: ReturnType<typeof getRedditOperatingAgentConfig>;
  store: RedditMemoryStore;
  outcome?: VenueOutcome;
  recorded?: RedditDecisionMemoryEntry;
  skipped: string[];
}): RedditSessionReport {
  return {
    generatedAt: input.now.toISOString(),
    dryRun: input.dryRun,
    duplicateCheckPolicy: resolveRedditSessionDuplicateCheckPolicy(input.dryRun),
    readSource: input.operating.readController,
    memoryPath: input.operating.memoryPath,
    ingestion: emptyIngestionSummary(),
    planner: summarizePlanner({ skipped: input.skipped }),
    actionCandidates: [],
    selectedActionBundle: chooseRedditActionBundle([], 1),
    queuedActionJobs: summarizeQueuedRedditJobs(input.store),
    decision: {
      action: undefined,
      plannedCandidates: [],
      candidates: [],
      skipped: input.skipped,
      filterSummary: emptyRedditFilterSummary()
    },
    outcome: input.outcome,
    recorded: input.recorded
  };
}

function buildRedditRuntimeReport(input: {
  phase: "heartbeat" | "executor";
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  report?: RedditSessionReport;
  status: "ok" | "failed";
  skipped: string[];
  errors: Array<{ phase: string; message: string }>;
}): RedditRuntimeReport {
  const baseReport = input.report;
  const skipped = [
    ...(baseReport?.decision.skipped ?? []),
    ...input.skipped
  ];
  return {
    runId: `${input.phase}:${input.finishedAt}:${process.pid}`,
    phase: input.phase,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status: input.status,
    summary: summarizeRedditRuntimeReport(input.phase, input.status, skipped, input.errors),
    dryRun: input.dryRun,
    skipped,
    errors: input.errors,
    actionCandidates: baseReport?.actionCandidates ?? [],
    selectedActionBundle: baseReport?.selectedActionBundle,
    queuedActionJobs: baseReport?.queuedActionJobs ?? [],
    ingestion: baseReport?.ingestion ?? emptyIngestionSummary(),
    planner: baseReport?.planner ?? summarizePlanner({ skipped }),
    outcome: baseReport?.outcome,
    recorded: baseReport?.recorded
  };
}

function summarizeRedditRuntimeReport(
  phase: "heartbeat" | "executor",
  status: "ok" | "failed",
  skipped: readonly string[],
  errors: ReadonlyArray<{ phase: string; message: string }>
): string {
  if (status === "failed") {
    return `${phase.toUpperCase()}_FAILED - ${errors[0]?.message ?? "unknown error"}`;
  }
  if (skipped.length === 0) {
    return `${phase.toUpperCase()}_OK - Reddit runtime idle.`;
  }
  return `${phase.toUpperCase()}_OK - ${skipped.join(" ")}`;
}

async function readOptionalJsonRecord(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function buildRedditEngagementEvents(history: readonly RedditDecisionMemoryEntry[]) {
  return history
    .filter((entry) => isRedditPublishedHistoryEntry(entry))
    .map((entry) => ({
      type: entry.kind,
      createdAt: entry.createdAt
    }));
}

function summarizeRedditHistory(history: readonly RedditDecisionMemoryEntry[], now: Date) {
  const countsSince = (durationMs: number) => countRedditKinds(
    history.filter((entry) => {
      if (!isRedditPublishedHistoryEntry(entry)) {
        return false;
      }
      const createdAt = Date.parse(entry.createdAt);
      return !Number.isNaN(createdAt) && now.getTime() - createdAt <= durationMs;
    })
  );
  return {
    generatedAt: now.toISOString(),
    windows: {
      last2Hours: countsSince(2 * 60 * 60 * 1_000),
      lastDay: countsSince(24 * 60 * 60 * 1_000),
      lastWeek: countsSince(7 * 24 * 60 * 60 * 1_000)
    },
    total: countRedditKinds(history.filter((entry) => isRedditPublishedHistoryEntry(entry)))
  };
}

function countRedditKinds(history: readonly RedditDecisionMemoryEntry[]) {
  const counts = {
    posts: 0,
    comments: 0,
    replies: 0,
    upvotes: 0,
    follows: 0,
    total: 0
  };
  for (const entry of history) {
    if (entry.kind === "post") {
      counts.posts += 1;
    } else if (entry.kind === "comment") {
      counts.comments += 1;
    } else if (entry.kind === "reply") {
      counts.replies += 1;
    }
  }
  counts.total = counts.posts + counts.comments + counts.replies;
  return counts;
}

function isRedditPublishedHistoryEntry(entry: RedditDecisionMemoryEntry): boolean {
  return entry.status !== "drafted" && entry.action !== "skipped";
}

function resolveRedditSessionDuplicateCheckPolicy(dryRun: boolean): RedditDuplicateCheckPolicy {
  if (!dryRun) {
    return "block_posted_only";
  }
  const configured = process.env.OUTREACH_REDDIT_DRY_RUN_DUPLICATE_POLICY?.trim();
  if (configured === "block_all_outbound" || configured === "block_posted_only") {
    return configured;
  }
  return "block_posted_only";
}

function summarizeIngestion(ingestion: RedditIngestionResult): RedditSessionReport["ingestion"] {
  return {
    snapshotCount: ingestion.snapshots.length,
    sourceItemCount: ingestion.sourceItems.length,
    ownThreadTargets: ingestion.ownThreadTargets,
    ownThreadSnapshots: ingestion.ownThreadSnapshots,
    discoveryThreadSnapshots: ingestion.discoveryThreadSnapshots,
    skipped: ingestion.skipped,
    diagnostics: ingestion.diagnostics
  };
}

function emptyIngestionSummary(): RedditSessionReport["ingestion"] {
  return {
    snapshotCount: 0,
    sourceItemCount: 0,
    ownThreadTargets: 0,
    ownThreadSnapshots: 0,
    discoveryThreadSnapshots: 0,
    skipped: [],
    diagnostics: {
      discoverySubredditPool: [],
      sampledSubreddits: [],
      subreddits: [],
      discoverySearchQueries: [],
      discoveryListingSorts: [],
      discoveryListingPages: [],
      discoverySearchPages: [],
      excludedThreadPostIds: [],
      scanLedgerSkippedScrapes: 0,
      discoveryPickStrategy: "stochastic",
      browserHeadless: false,
      readViaBrowser: false,
      readViaReddapi: false,
      readViaUnofficial: false
    }
  };
}

function summarizePlanner(input: {
  skipped: string[];
  candidates?: Array<{ id: string }>;
  filterSummary?: RedditPlannerFilterSummary;
  sessionLimits?: string[];
  pipeline?: RedditSessionReport["planner"]["pipeline"];
}): RedditSessionReport["planner"] {
  const blockedGateSample = input.skipped
    .filter((entry) => entry.includes("blocked by"))
    .slice(0, 12)
    .map((entry) => {
      const separator = ": blocked by ";
      const separatorIndex = entry.indexOf(separator);
      if (separatorIndex === -1) {
        return { id: entry, gates: [] as string[] };
      }
      const id = entry.slice(0, separatorIndex);
      const gates = entry
        .slice(separatorIndex + separator.length)
        .split(",")
        .map((gate) => gate.trim())
        .filter(Boolean);
      return { id, gates };
    });
  return {
    skipped: input.skipped,
    blockedGateSample,
    filterSummary: input.filterSummary,
    sessionLimits: input.sessionLimits?.length ? input.sessionLimits : undefined,
    pipeline: input.pipeline
  };
}

function resolveThreadPostId(
  planned: NonNullable<ReturnType<typeof planRedditAction>["action"]>,
  remoteContentUrl?: string
): string | undefined {
  const fromUrl = remoteContentUrl ? parseRedditThreadUrl(remoteContentUrl)?.postId : undefined;
  if (fromUrl) {
    return fromUrl;
  }
  if (planned.item.source.threadPostId) {
    return planned.item.source.threadPostId;
  }
  if (planned.item.source.kind === "post") {
    return planned.item.source.id;
  }
  const fromPermalink = planned.item.source.permalink
    ? parseRedditThreadUrl(planned.item.source.permalink)?.postId
    : undefined;
  return fromPermalink;
}

function summarizeActionCandidates(
  candidates: ReturnType<typeof buildRedditActionCandidates>
): RedditSessionReport["actionCandidates"] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    type: candidate.type,
    source: candidate.source,
    score: candidate.score,
    allowed: candidate.allowed,
    needsContent: candidate.needsContent,
    blockedBy: candidate.constraints.filter((constraint) => !constraint.passed).map((constraint) => constraint.id)
  }));
}

function summarizeQueuedRedditJobs(store: Pick<RedditMemoryStore, "queuedJobs">): RedditSessionReport["queuedActionJobs"] {
  return summarizeActionJobs(store.queuedJobs ?? []);
}

type QueuedRedditWriteMetadata = {
  kind: "queued_reddit_write";
  plannedAction: NonNullable<ReturnType<typeof planRedditAction>["action"]>;
  promptProfileId?: string;
  promptParameters?: RedditDecisionMemoryEntry["promptParameters"];
  layout?: RedditDecisionMemoryEntry["layout"];
  promptVariantId?: string;
  promptVariantLabel?: string;
  promptVariantRationale?: string;
  rotateAfterActions?: number;
  reusedExisting?: boolean;
  selectionSource?: "llm" | "deterministic_fallback";
  selectionDebugPath?: string;
  scopeKey?: "reddit:create_post" | "reddit:comment_on_post" | "reddit:reply_to_activity";
};

function buildRedditPromptRotationEntry(
  metadata: QueuedRedditWriteMetadata,
  createdAt: string,
  status: string,
  overrides: Partial<PromptRotationHistoryEntry> = {}
): PromptRotationHistoryEntry {
  return {
    id: overrides.id ?? `reddit:${metadata.plannedAction.item.id}:${status}`,
    venue: "reddit",
    actionType:
      metadata.plannedAction.type === "reply_to_comment" ? "reply_to_activity" : "comment_on_post",
    scopeKey: metadata.scopeKey,
    createdAt,
    status,
    promptProfileId: metadata.promptProfileId,
    promptVariantId: metadata.promptVariantId,
    promptVariantLabel: metadata.promptVariantLabel,
    promptParameters: metadata.promptParameters,
    layout: metadata.layout,
    messageStyle: metadata.promptParameters?.messageStyle,
    technicalDepth: metadata.promptParameters?.technicalDepth,
    tone: metadata.promptParameters?.tone,
    creativity: metadata.promptParameters?.creativity,
    selectionSource: metadata.selectionSource,
    rotateAfterActions: metadata.rotateAfterActions,
    selectionRationale: metadata.promptVariantRationale,
    correlationId: metadata.plannedAction.item.id,
    debugInputPath: metadata.selectionDebugPath,
    ...overrides
  };
}

async function recordRedditPromptRotationFailure(
  config: MoltbookRuntimeConfig,
  metadata: QueuedRedditWriteMetadata,
  now: Date
): Promise<void> {
  if (!metadata.promptVariantId) {
    return;
  }
  await recordPromptRotationAction({
    config,
    eventType: "failed",
    entry: buildRedditPromptRotationEntry(metadata, now.toISOString(), "failed")
  });
}

async function recordRedditPromptRotationPublished(
  config: MoltbookRuntimeConfig,
  metadata: QueuedRedditWriteMetadata,
  recorded: RedditDecisionMemoryEntry,
  now: Date
): Promise<void> {
  if (!metadata.promptVariantId) {
    return;
  }
  await recordPromptRotationAction({
    config,
    eventType: "published",
    selection: {
      variantId: metadata.promptVariantId,
      label: metadata.promptVariantLabel,
      rationale: metadata.promptVariantRationale ?? "",
      rotateAfterActions: metadata.rotateAfterActions ?? 10,
      reusedExisting: metadata.reusedExisting ?? true,
      selectionSource: metadata.selectionSource,
      selectedAt: now.toISOString(),
      selectionDebugPath: metadata.selectionDebugPath
    },
    entry: buildRedditPromptRotationEntry(metadata, recorded.createdAt, recorded.status ?? "posted", {
      id: `reddit:${recorded.id}`,
      promptVariantId: recorded.promptVariantId,
      promptParameters: recorded.promptParameters,
      layout: recorded.layout,
      clickCount: recorded.clickCount,
      privateMessageCount: recorded.privateMessageCount
    })
  });
}

async function executeQueuedRedditJob(
  store: RedditMemoryStore,
  input: {
    config: MoltbookRuntimeConfig;
    publishAction?: (action: VenueAction) => Promise<VenueOutcome>;
    now: Date;
    fetchImpl?: typeof fetch;
  }
): Promise<{ store: RedditMemoryStore; outcome: VenueOutcome; recorded: RedditDecisionMemoryEntry } | undefined> {
  const queuedJob = (store.queuedJobs ?? []).find(
    (job) => job.status === "queued" && Date.parse(job.notBefore) <= input.now.getTime()
  );
  if (!queuedJob) {
    return undefined;
  }
  const metadata = queuedJob.payload.raw as QueuedRedditWriteMetadata;
  let outcome: VenueOutcome;
  try {
    outcome = input.publishAction
      ? await input.publishAction(queuedJob.payload)
      : await createVenueProvider(input.config).publishAction(queuedJob.payload);
  } catch (error) {
    await recordRedditPromptRotationFailure(input.config, metadata, input.now).catch(() => undefined);
    throw error;
  }
  const operating = getRedditOperatingAgentConfig(input.config);
  const visibility =
    metadata.plannedAction.type === "comment_on_post" || metadata.plannedAction.type === "reply_to_comment"
      ? await verifyPublicRedditCommentVisibility({
          subreddit: metadata.plannedAction.item.source.subreddit,
          threadPostId: resolveThreadPostId(metadata.plannedAction, outcome.remoteContentUrl),
          remoteContentId: outcome.remoteContentId,
          remoteContentUrl: outcome.remoteContentUrl,
          content: queuedJob.payload.content ?? "",
          fetchImpl: input.fetchImpl,
          userAgent: getRedditControllerConfig(input.config).api.userAgent
        })
      : undefined;
  const recorded: RedditDecisionMemoryEntry = {
    id: `outcome:${metadata.plannedAction.item.source.id}:${input.now.getTime()}`,
    decisionId: metadata.plannedAction.item.id,
    subreddit: metadata.plannedAction.item.source.subreddit,
    kind: metadata.plannedAction.type === "reply_to_comment" ? "reply" : "comment",
    action: metadata.plannedAction.type === "reply_to_comment" ? "replied" : "commented",
    content: queuedJob.payload.content ?? "",
    createdAt: input.now.toISOString(),
    targetId: metadata.plannedAction.item.source.id,
    targetTitle: resolveRedditTargetTitle(metadata.plannedAction.item.source),
    targetUrl: resolveRedditTargetUrl(metadata.plannedAction.item.source),
    targetSummary: metadata.plannedAction.item.source.body ?? metadata.plannedAction.item.source.title,
    nextEligibleAt: new Date(
      input.now.getTime() +
        (operating.minJitterMinutes + Math.max(0, operating.maxJitterMinutes - operating.minJitterMinutes) / 2) *
          60_000
    ).toISOString(),
    status: visibility?.visible === false ? "spam_filtered" : "posted",
    firstReply: true,
    productMentioned: false,
    linkIncluded: false,
    promptProfileId: metadata.promptProfileId,
    promptVariantId: metadata.promptVariantId,
    promptVariantRationale: metadata.promptVariantRationale,
    promptParameters: metadata.promptParameters,
    layout: metadata.layout,
    structuralFingerprint: structuralFingerprint(queuedJob.payload.content ?? ""),
    controller: getRedditControllerConfig(input.config).controller,
    decisionReason: metadata.plannedAction.reason,
    relevanceScore: metadata.plannedAction.item.relevanceScore,
    riskScore: metadata.plannedAction.item.riskScore,
    remoteContentUrl: outcome.remoteContentUrl,
    threadPostId: resolveThreadPostId(metadata.plannedAction, outcome.remoteContentUrl)
  };
  const nextStore: RedditMemoryStore = {
    ...store,
    history: [...store.history, recorded].slice(-500),
    queuedJobs: removeActionJob(store.queuedJobs ?? [], queuedJob.id)
  };
  await saveRedditMemory(operating.memoryPath, nextStore);
  await recordRedditPromptRotationPublished(input.config, metadata, recorded, input.now);
  return {
    store: nextStore,
    outcome,
    recorded
  };
}

function toVenueAction(
  planned: NonNullable<ReturnType<typeof planRedditAction>["action"]>,
  content: string
): VenueAction {
  const source = planned.item.source;
  return {
    id: planned.item.id,
    venue: "reddit",
    type: planned.type,
    candidateId: planned.type === "reply_to_comment" ? source.id : undefined,
    parentId: planned.type === "comment_on_post" ? source.id : undefined,
    surface: source.subreddit,
    content,
    raw: {
      permalink: source.permalink,
      url: source.url,
      reason: planned.reason
    }
  };
}

async function verifyRedditAccountHealth(input: {
  config: MoltbookRuntimeConfig;
  memory: RedditMemoryStore;
  memoryPath: string;
  now: Date;
  fetchImpl?: typeof fetch;
}): Promise<{ memory: RedditMemoryStore; blockedReason?: string; health?: RedditAccountHealth }> {
  const health = await checkRedditAccountHealth(input.config, input.fetchImpl ?? fetch);
  if (isRedditAccountUsable(health)) {
    return { memory: input.memory, health };
  }

  const blockedReason = redditAccountHealthSkipReason(health);
  const hasRecentBan = input.memory.history.some((entry) => entry.status === "banned");
  let memory = input.memory;
  if (!hasRecentBan) {
    memory = await appendRedditMemory(input.memoryPath, {
      id: `account-health:${input.now.getTime()}`,
      subreddit: "account",
      kind: "comment",
      action: "skipped",
      content: health.reason,
      createdAt: input.now.toISOString(),
      status: "banned",
      controller: getRedditControllerConfig(input.config).controller,
      decisionReason: health.reason
    });
  }

  if ((memory.queuedJobs?.length ?? 0) > 0) {
    memory = {
      ...memory,
      queuedJobs: []
    };
    await saveRedditMemory(input.memoryPath, memory);
  }

  return { memory, blockedReason, health };
}

function buildRedditBlockedSessionReport(input: {
  now: Date;
  dryRun: boolean;
  duplicateCheckPolicy: RedditDuplicateCheckPolicy;
  operating: ReturnType<typeof getRedditOperatingAgentConfig>;
  memory: RedditMemoryStore;
  decision: ReturnType<typeof planRedditAction>;
  maxActions: number;
  sessionLimits?: string[];
  pipeline: { llmDraft: "not_reached" | "failed" | "succeeded" };
  accountHealth?: RedditAccountHealth;
}): RedditSessionReport {
  return {
    generatedAt: input.now.toISOString(),
    dryRun: input.dryRun,
    duplicateCheckPolicy: input.duplicateCheckPolicy,
    readSource: input.operating.readController,
    memoryPath: input.operating.memoryPath,
    ingestion: emptyIngestionSummary(),
    actionCandidates: [],
    selectedActionBundle: chooseRedditActionBundle([], input.maxActions),
    queuedActionJobs: summarizeQueuedRedditJobs(input.memory),
    planner: summarizePlanner({
      skipped: input.decision.skipped,
      filterSummary: input.decision.filterSummary,
      sessionLimits: input.sessionLimits,
      pipeline: input.pipeline
    }),
    decision: input.decision
  };
}

function findKillSwitch(history: readonly RedditDecisionMemoryEntry[]): string | undefined {
  const recent = history.slice(-50);
  if (recent.some((entry) => entry.status === "banned")) {
    return "Kill switch: a ban was recorded in Reddit memory.";
  }
  if (recent.filter((entry) => entry.status === "spam_accusation").length > 0) {
    return "Kill switch: spam accusation recorded in Reddit memory.";
  }
  if (recent.filter((entry) => entry.status === "removed" || entry.status === "mod_warning").length >= 2) {
    return "Kill switch: repeated removals or mod warnings recorded in Reddit memory.";
  }
  return undefined;
}

function findDailyActionLimitReason(
  history: readonly RedditDecisionMemoryEntry[],
  maxActionsPerDay: number,
  now: Date
): string | undefined {
  if (maxActionsPerDay < 1) {
    return "Reddit session daily action cap is set to zero.";
  }
  const today = now.toISOString().slice(0, 10);
  const postedToday = history.filter((entry) => {
    if (!redditMemoryEntryCountsTowardPublishedLimits(entry)) {
      return false;
    }
    return entry.createdAt.slice(0, 10) === today;
  }).length;
  return postedToday >= maxActionsPerDay
    ? `Daily Reddit action cap reached (${postedToday}/${maxActionsPerDay}).`
    : undefined;
}

function findSessionCooldownReason(
  history: readonly RedditDecisionMemoryEntry[],
  now: Date
): string | undefined {
  const recent = [...history]
    .filter((entry) => redditMemoryEntryCountsTowardPublishedLimits(entry))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  if (!recent?.nextEligibleAt) {
    return undefined;
  }
  const nextEligibleAt = Date.parse(recent.nextEligibleAt);
  if (Number.isNaN(nextEligibleAt) || nextEligibleAt <= now.getTime()) {
    return undefined;
  }
  const waitMinutes = Math.max(1, Math.ceil((nextEligibleAt - now.getTime()) / 60_000));
  return `Reddit session cooldown active for about ${waitMinutes} more minute${waitMinutes === 1 ? "" : "s"}.`;
}

function findRedditSubredditCooldowns(
  history: readonly RedditDecisionMemoryEntry[],
  now: Date
): Map<string, { subreddit: string; until: string; reason: string }> {
  const recentWindowMs = 72 * 60 * 60 * 1_000;
  const pauseMs = 12 * 60 * 60 * 1_000;
  const bySubreddit = new Map<string, RedditDecisionMemoryEntry[]>();
  for (const entry of history) {
    if (entry.status !== "spam_filtered") {
      continue;
    }
    const createdAt = Date.parse(entry.createdAt);
    if (Number.isNaN(createdAt) || now.getTime() - createdAt > recentWindowMs) {
      continue;
    }
    const key = entry.subreddit.trim().toLowerCase();
    if (!key) {
      continue;
    }
    const existing = bySubreddit.get(key) ?? [];
    existing.push(entry);
    bySubreddit.set(key, existing);
  }

  const pauses = new Map<string, { subreddit: string; until: string; reason: string }>();
  for (const [key, entries] of bySubreddit.entries()) {
    if (entries.length < 2) {
      continue;
    }
    const latest = entries
      .map((entry) => ({ entry, timestamp: Date.parse(entry.createdAt) }))
      .filter((row) => !Number.isNaN(row.timestamp))
      .sort((left, right) => right.timestamp - left.timestamp)[0];
    if (!latest) {
      continue;
    }
    const untilTs = latest.timestamp + pauseMs;
    if (untilTs <= now.getTime()) {
      continue;
    }
    pauses.set(key, {
      subreddit: entries[0]?.subreddit ?? key,
      until: new Date(untilTs).toISOString(),
      reason: `Subreddit pause for ${entries[0]?.subreddit ?? key}: repeated hidden comments detected.`
    });
  }
  return pauses;
}

function applySubredditCooldownsToCandidates(
  candidates: readonly ConstrainedActionCandidate[],
  cooldowns: ReadonlyMap<string, { subreddit: string; until: string; reason: string }>
): ConstrainedActionCandidate[] {
  return candidates.map((candidate) => {
    const surface = candidate.surface?.trim().toLowerCase();
    if (!surface) {
      return candidate;
    }
    const cooldown = cooldowns.get(surface);
    if (!cooldown) {
      return candidate;
    }
    const constraint: ActionConstraint = {
      id: "subreddit_pause_hidden_comments",
      passed: false,
      severity: "block",
      reason: cooldown.reason
    };
    return {
      ...candidate,
      allowed: false,
      constraints: [...candidate.constraints, constraint]
    };
  });
}

function summarizeRedditSubredditCooldowns(
  cooldowns: ReadonlyMap<string, { subreddit: string; until: string; reason: string }>,
  now: Date
): string[] {
  return [...cooldowns.values()]
    .sort((left, right) => left.subreddit.localeCompare(right.subreddit))
    .map((cooldown) => {
      const waitMinutes = Math.max(1, Math.ceil((Date.parse(cooldown.until) - now.getTime()) / 60_000));
      return `${cooldown.reason} Cooldown active for about ${waitMinutes} more minute${waitMinutes === 1 ? "" : "s"}.`;
    });
}

function resolveAdaptiveRedditPromptOverrides(
  history: readonly RedditDecisionMemoryEntry[],
  subreddit: string,
  now: Date
): Partial<PromptParameterSet> {
  const windowMs = 7 * 24 * 60 * 60 * 1_000;
  const hiddenCount = history.filter((entry) => {
    if (entry.status !== "spam_filtered") {
      return false;
    }
    if (entry.subreddit.trim().toLowerCase() !== subreddit.trim().toLowerCase()) {
      return false;
    }
    const createdAt = Date.parse(entry.createdAt);
    return !Number.isNaN(createdAt) && now.getTime() - createdAt <= windowMs;
  }).length;
  if (hiddenCount < 1) {
    return {};
  }
  return {
    messageStyle: "informative",
    layout: "regular_paragraph",
    tone: "operator",
    technicalDepth: "simple",
    responseLength: "brief",
    creativity: "conservative",
    humor: "none",
    aggression: "low"
  };
}

function structuralFingerprint(content: string): string {
  return (content.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).slice(0, 20).join("-");
}

function shouldPublishQueuedActionImmediately(): boolean {
  return process.env.OUTREACH_REDDIT_PUBLISH_IMMEDIATELY?.trim() === "true";
}

function parseDiscoverySeedFromEnv(): number | undefined {
  const raw = process.env.OUTREACH_REDDIT_DISCOVERY_SEED?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

export async function runRedditSessionCli(): Promise<void> {
  const subreddits = getArg("--subreddits")?.split(",").map((entry) => entry.trim()).filter(Boolean);
  const maxActions = Number(getArg("--max-actions") ?? "1");
  const report = await runRedditSession({
    dryRun: hasFlag("--dry-run") ? true : hasFlag("--live") ? false : undefined,
    maxActions: Number.isFinite(maxActions) && maxActions >= 0 ? maxActions : 1,
    subreddits,
    once: hasFlag("--once")
  });
  console.log(JSON.stringify(report, null, 2));
}

export async function runRedditHeartbeatCli(): Promise<void> {
  const subreddits = getArg("--subreddits")?.split(",").map((entry) => entry.trim()).filter(Boolean);
  const maxActions = Number(getArg("--max-actions") ?? "1");
  const report = await runRedditHeartbeat({
    dryRun: hasFlag("--dry-run") ? true : hasFlag("--live") ? false : undefined,
    maxActions: Number.isFinite(maxActions) && maxActions >= 0 ? maxActions : 1,
    subreddits,
    once: hasFlag("--once")
  });
  console.log(JSON.stringify(report, null, 2));
}

export async function runRedditExecutorCli(): Promise<void> {
  const report = await runRedditExecutor({
    dryRun: hasFlag("--dry-run") ? true : hasFlag("--live") ? false : undefined
  });
  console.log(JSON.stringify(report, null, 2));
}
