import { getOutreachAgentConfig, getRedditControllerConfig, getRedditOperatingAgentConfig, loadRuntimeConfig } from "./config.js";
import { createActionJob, type ActionJob } from "./action-planning.js";
import { draftRedditResponse } from "./reddit-drafting.js";
import { recordPromptRotationAction, selectPromptVariant } from "./prompt-rotation.js";
import { ingestRedditState } from "./reddit-ingestion.js";
import { enqueueActionJobs, removeActionJob, summarizeActionJobs } from "./job-queue.js";
import { appendRedditMemory, loadRedditMemory, saveRedditMemory, type RedditMemoryStore } from "./reddit-memory.js";
import {
  buildRedditActionCandidates,
  chooseRedditActionBundle,
  plannedRedditActionFromCandidate
} from "./reddit-action-planning.js";
import {
  DEFAULT_REDDIT_OPERATING_RULES,
  DEFAULT_REDDIT_OPERATING_TARGETING,
  planRedditAction
} from "./reddit-policy.js";
import { redditMemoryEntryCountsTowardPublishedLimits } from "./reddit-outreach.js";
import type { RedditDecisionMemoryEntry } from "./reddit-memory.js";
import { createVenueProvider } from "./venue-factory.js";
import type { VenueAction, VenueOutcome } from "./venue.js";
import type { MoltbookRuntimeConfig } from "./config.js";
import type { RedditIngestionResult } from "./reddit-ingestion.js";

export interface RedditSessionReport {
  generatedAt: string;
  dryRun: boolean;
  readSource: "browser" | "api" | "auto";
  memoryPath: string;
  ingestion: {
    snapshotCount: number;
    sourceItemCount: number;
    skipped: string[];
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

export async function runRedditSession(input: {
  config?: MoltbookRuntimeConfig;
  dryRun?: boolean;
  maxActions?: number;
  subreddits?: readonly string[];
  once?: boolean;
  fetchImpl?: typeof fetch;
  ingestion?: RedditIngestionResult;
  publishAction?: (action: VenueAction) => Promise<VenueOutcome>;
} = {}): Promise<RedditSessionReport> {
  const config = input.config ?? await loadRuntimeConfig({ requireVenue: true });
  const agent = getOutreachAgentConfig(config);
  if (agent.venue !== "reddit") {
    throw new Error("reddit-session requires OUTREACH_AGENT_VENUE=reddit.");
  }
  const operating = getRedditOperatingAgentConfig(config);
  const dryRun = input.dryRun ?? operating.dryRunDefault;
  const maxActions = input.maxActions ?? operating.maxActionsPerSession;
  const memory = await loadRedditMemory(operating.memoryPath);
  const now = new Date();
  const recentKillReason = findKillSwitch(memory.history);
  if (recentKillReason) {
    const decision = { skipped: [recentKillReason], candidates: [], plannedCandidates: [] };
    return {
      generatedAt: now.toISOString(),
      dryRun,
      readSource: operating.readController,
      memoryPath: operating.memoryPath,
      ingestion: { snapshotCount: 0, sourceItemCount: 0, skipped: [] },
      actionCandidates: [],
      selectedActionBundle: chooseRedditActionBundle([], maxActions),
      queuedActionJobs: summarizeQueuedRedditJobs(memory),
      decision
    };
  }

  if (!dryRun) {
    const executed = await executeQueuedRedditJob(memory, {
      config,
      publishAction: input.publishAction,
      now
    });
    if (executed) {
      return {
        generatedAt: now.toISOString(),
        dryRun,
        readSource: operating.readController,
        memoryPath: operating.memoryPath,
        ingestion: { snapshotCount: 0, sourceItemCount: 0, skipped: [] },
        actionCandidates: [],
        selectedActionBundle: chooseRedditActionBundle([], maxActions),
        queuedActionJobs: summarizeQueuedRedditJobs(executed.store),
        decision: {
          action: undefined,
          plannedCandidates: [],
          skipped: ["Executed one queued Reddit action instead of planning a new one."],
          candidates: []
        },
        outcome: executed.outcome,
        recorded: executed.recorded
      };
    }
  }

  const ingestion = input.ingestion ?? await ingestRedditState({
    config,
    subreddits:
      input.subreddits?.length
        ? input.subreddits
        : operating.targetSubreddits.length > 0
          ? operating.targetSubreddits
          : undefined,
    queries: operating.searchQueries.length > 0 ? operating.searchQueries : undefined,
    history: memory.history,
    source: operating.readController
  });
  const decision = planRedditAction({
    items: ingestion.sourceItems,
    history: memory.history,
    targeting: DEFAULT_REDDIT_OPERATING_TARGETING,
    registry: DEFAULT_REDDIT_OPERATING_RULES,
    config: {
      maxActionsPerSession: maxActions,
      minDelayMinutes: operating.minJitterMinutes,
      maxDelayMinutes: operating.maxJitterMinutes
    }
  });
  const actionCandidates = buildRedditActionCandidates(decision);
  const selectedActionBundle = chooseRedditActionBundle(actionCandidates, maxActions);

  const dailyLimitReason = findDailyActionLimitReason(memory.history, operating.maxActionsPerDay, now);
  if (dailyLimitReason) {
    return {
      generatedAt: now.toISOString(),
      dryRun,
      readSource: operating.readController,
      memoryPath: operating.memoryPath,
      ingestion: {
        snapshotCount: ingestion.snapshots.length,
        sourceItemCount: ingestion.sourceItems.length,
        skipped: ingestion.skipped
      },
      actionCandidates: summarizeActionCandidates(actionCandidates),
      selectedActionBundle,
      queuedActionJobs: summarizeQueuedRedditJobs(memory),
      decision: {
        ...decision,
        action: undefined,
        skipped: [dailyLimitReason, ...decision.skipped]
      }
    };
  }

  const cooldownReason = findSessionCooldownReason(memory.history, now);
  if (cooldownReason) {
    return {
      generatedAt: now.toISOString(),
      dryRun,
      readSource: operating.readController,
      memoryPath: operating.memoryPath,
      ingestion: {
        snapshotCount: ingestion.snapshots.length,
        sourceItemCount: ingestion.sourceItems.length,
        skipped: ingestion.skipped
      },
      actionCandidates: summarizeActionCandidates(actionCandidates),
      selectedActionBundle,
      queuedActionJobs: summarizeQueuedRedditJobs(memory),
      decision: {
        ...decision,
        action: undefined,
        skipped: [cooldownReason, ...decision.skipped]
      }
    };
  }

  const selectedAction = selectedActionBundle.selectedWriteCandidateId
    ? actionCandidates.find((candidate) => candidate.id === selectedActionBundle.selectedWriteCandidateId)
    : undefined;
  const plannedAction = selectedAction ? plannedRedditActionFromCandidate(selectedAction) : undefined;
  if (!plannedAction || maxActions < 1) {
    return {
      generatedAt: now.toISOString(),
      dryRun,
      readSource: operating.readController,
      memoryPath: operating.memoryPath,
      ingestion: {
        snapshotCount: ingestion.snapshots.length,
        sourceItemCount: ingestion.sourceItems.length,
        skipped: ingestion.skipped
      },
      actionCandidates: summarizeActionCandidates(actionCandidates),
      selectedActionBundle,
      queuedActionJobs: summarizeQueuedRedditJobs(memory),
      decision: {
        ...decision,
        action: undefined
      }
    };
  }

  const selectedVariant = await selectPromptVariant({
    config,
    venue: "reddit",
    actionType: plannedAction.type === "reply_to_comment" ? "reply_to_activity" : "comment_on_post",
    fetchImpl: input.fetchImpl
  });
  const draft = await draftRedditResponse({
    config,
    item: plannedAction.item,
    targeting: DEFAULT_REDDIT_OPERATING_TARGETING,
    actionType: plannedAction.type === "reply_to_comment" ? "reply_to_activity" : "comment_on_post",
    recentContent: memory.history.slice(-20).map((entry) => entry.content),
    promptVariantId: selectedVariant.variantId,
    promptParameterOverrides: selectedVariant.parameterOverrides,
    fetchImpl: input.fetchImpl
  });
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
        notBefore: now.toISOString()
      })
    ]).slice(-1);
    await saveRedditMemory(operating.memoryPath, {
      ...memory,
      queuedJobs: nextQueuedJobs
    });
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
    targetId: dryRun ? undefined : plannedAction.item.source.id,
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
    remoteContentUrl: outcome?.remoteContentUrl
  };
  if (dryRun) {
    await appendRedditMemory(operating.memoryPath, recorded);
  }

  return {
    generatedAt: now.toISOString(),
    dryRun,
    readSource: operating.readController,
    memoryPath: operating.memoryPath,
    ingestion: {
      snapshotCount: ingestion.snapshots.length,
      sourceItemCount: ingestion.sourceItems.length,
      skipped: ingestion.skipped
    },
    actionCandidates: summarizeActionCandidates(actionCandidates),
    selectedActionBundle,
    queuedActionJobs: dryRun ? summarizeQueuedRedditJobs(memory) : summarizeQueuedRedditJobs({ ...memory, queuedJobs: nextQueuedJobs }),
    decision: {
      ...decision,
      action: plannedAction
    },
    draft,
    outcome,
    recorded: dryRun ? recorded : undefined
  };
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

async function executeQueuedRedditJob(
  store: RedditMemoryStore,
  input: {
    config: MoltbookRuntimeConfig;
    publishAction?: (action: VenueAction) => Promise<VenueOutcome>;
    now: Date;
  }
): Promise<{ store: RedditMemoryStore; outcome: VenueOutcome; recorded: RedditDecisionMemoryEntry } | undefined> {
  const queuedJob = (store.queuedJobs ?? []).find(
    (job) => job.status === "queued" && Date.parse(job.notBefore) <= input.now.getTime()
  );
  if (!queuedJob) {
    return undefined;
  }
  const metadata = queuedJob.payload.raw as {
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
  let outcome: VenueOutcome;
  try {
    outcome = input.publishAction
      ? await input.publishAction(queuedJob.payload)
      : await createVenueProvider(input.config).publishAction(queuedJob.payload);
  } catch (error) {
    if (metadata.promptVariantId) {
      await recordPromptRotationAction({
        config: input.config,
        eventType: "failed",
        entry: {
          id: `reddit:${metadata.plannedAction.item.id}:failed`,
          venue: "reddit",
          actionType:
            metadata.plannedAction.type === "reply_to_comment"
              ? "reply_to_activity"
              : "comment_on_post",
          scopeKey: metadata.scopeKey,
          createdAt: input.now.toISOString(),
          status: "failed",
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
          debugInputPath: metadata.selectionDebugPath
        }
      }).catch(() => undefined);
    }
    throw error;
  }
  const operating = getRedditOperatingAgentConfig(input.config);
  const recorded: RedditDecisionMemoryEntry = {
    id: `outcome:${metadata.plannedAction.item.source.id}:${input.now.getTime()}`,
    decisionId: metadata.plannedAction.item.id,
    subreddit: metadata.plannedAction.item.source.subreddit,
    kind: metadata.plannedAction.type === "reply_to_comment" ? "reply" : "comment",
    action: metadata.plannedAction.type === "reply_to_comment" ? "replied" : "commented",
    content: queuedJob.payload.content ?? "",
    createdAt: input.now.toISOString(),
    targetId: metadata.plannedAction.item.source.id,
    targetSummary: metadata.plannedAction.item.source.body ?? metadata.plannedAction.item.source.title,
    nextEligibleAt: new Date(
      input.now.getTime() +
        (operating.minJitterMinutes + Math.max(0, operating.maxJitterMinutes - operating.minJitterMinutes) / 2) *
          60_000
    ).toISOString(),
    status: "posted",
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
    remoteContentUrl: outcome.remoteContentUrl
  };
  const nextStore: RedditMemoryStore = {
    ...store,
    history: [...store.history, recorded].slice(-500),
    queuedJobs: removeActionJob(store.queuedJobs ?? [], queuedJob.id)
  };
  await saveRedditMemory(operating.memoryPath, nextStore);
  if (metadata.promptVariantId) {
    await recordPromptRotationAction({
      config: input.config,
      eventType: "published",
      selection: {
        variantId: metadata.promptVariantId,
        label: metadata.promptVariantLabel,
        rationale: metadata.promptVariantRationale ?? "",
        rotateAfterActions: metadata.rotateAfterActions ?? 10,
        reusedExisting: metadata.reusedExisting ?? true,
        selectionSource: metadata.selectionSource,
        selectedAt: input.now.toISOString(),
        selectionDebugPath: metadata.selectionDebugPath
      },
      entry: {
        id: `reddit:${recorded.id}`,
        venue: "reddit",
        actionType: metadata.plannedAction.type === "reply_to_comment" ? "reply_to_activity" : "comment_on_post",
        scopeKey: metadata.scopeKey,
        createdAt: recorded.createdAt,
        status: recorded.action,
        promptProfileId: recorded.promptProfileId,
        promptVariantId: recorded.promptVariantId,
        promptVariantLabel: metadata.promptVariantLabel,
        promptParameters: recorded.promptParameters,
        layout: recorded.layout,
        messageStyle: recorded.promptParameters?.messageStyle,
        technicalDepth: recorded.promptParameters?.technicalDepth,
        tone: recorded.promptParameters?.tone,
        creativity: recorded.promptParameters?.creativity,
        clickCount: recorded.clickCount,
        privateMessageCount: recorded.privateMessageCount,
        selectionSource: metadata.selectionSource,
        rotateAfterActions: metadata.rotateAfterActions,
        selectionRationale: metadata.promptVariantRationale,
        correlationId: metadata.plannedAction.item.id,
        debugInputPath: metadata.selectionDebugPath
      }
    });
  }
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

function structuralFingerprint(content: string): string {
  return (content.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).slice(0, 20).join("-");
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
