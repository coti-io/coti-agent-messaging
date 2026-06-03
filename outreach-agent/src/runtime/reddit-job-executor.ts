import { getRedditControllerConfig, getRedditOperatingAgentConfig, type MoltbookRuntimeConfig } from "../config.js";
import {
  nextActionCooldownAt,
  pickNextExecutableJob,
  requeueFailedActionJob,
  type ActionExecutionRecord
} from "../action-execution.js";
import { type ActionJob } from "../action-planning.js";
import { removeActionJob } from "../job-queue.js";
import {
  recordRedditUpvote,
  type RedditDecisionMemoryEntry,
  type RedditMemoryStore
} from "../reddit-memory.js";
import {
  recordPromptRotationAction,
  type PromptRotationHistoryEntry
} from "../prompt-rotation.js";
import {
  parseRedditThreadUrl,
  resolveRedditTargetTitle,
  resolveRedditTargetUrl
} from "../reddit-ingestion.js";
import { planRedditAction } from "../reddit-policy.js";
import { createVenueProvider } from "../venue-factory.js";
import { createRedditRuntimeStore } from "./reddit-runtime-store.js";
import { verifyPublicRedditCommentVisibility } from "../reddit-visibility-verification.js";
import type { VenueAction, VenueOutcome } from "../venue.js";
import { resolveThreadPostId, structuralFingerprint } from "./reddit-planner-support.js";

export type QueuedRedditWriteMetadata = {
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

export function isQueuedRedditWriteMetadata(input: unknown): input is QueuedRedditWriteMetadata {
  return Boolean(input && typeof input === "object" && "kind" in input && input.kind === "queued_reddit_write");
}

export function redditExecutionRecords(history: readonly RedditDecisionMemoryEntry[]): ActionExecutionRecord[] {
  return history.map((entry) => ({
    venue: "reddit",
    type: redditActionTypeFromMemoryEntry(entry),
    createdAt: entry.createdAt,
    surface: entry.subreddit,
    status: entry.status ?? entry.action,
    nextEligibleAt: entry.nextEligibleAt
  }));
}

export function redditActionTypeFromMemoryEntry(entry: RedditDecisionMemoryEntry): VenueAction["type"] {
  if (entry.kind === "post" || entry.action === "posted") {
    return "create_post";
  }
  if (entry.kind === "reply" || entry.action === "replied") {
    return "reply_to_comment";
  }
  if (entry.kind === "upvote" || entry.action === "upvoted") {
    return "upvote_post";
  }
  return "comment_on_post";
}

export function buildRedditPromptRotationEntry(
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

export async function recordRedditPromptRotationFailure(
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

export async function recordRedditPromptRotationPublished(
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

export function recordNonWriteRedditExecution(input: {
  store: RedditMemoryStore;
  job: ActionJob;
  outcome: VenueOutcome;
  now: Date;
  config: MoltbookRuntimeConfig;
}): RedditMemoryStore {
  if (input.job.type === "upvote_post" && input.job.payload.parentId) {
    return recordRedditUpvote(input.store, {
      thingId: input.job.payload.parentId,
      subreddit: input.job.payload.surface ?? "unknown",
      targetTitle: undefined,
      targetUrl: input.outcome.remoteContentUrl,
      createdAt: input.outcome.occurredAt ?? input.now.toISOString(),
      controller: getRedditControllerConfig(input.config).controller
    });
  }
  const entry: RedditDecisionMemoryEntry = {
    id: `outcome:${input.job.id}:${input.now.getTime()}`,
    decisionId: input.job.sourceDecisionId,
    subreddit: input.job.payload.surface ?? "unknown",
    kind:
      input.job.type === "create_post"
        ? "post"
        : input.job.type === "reply_to_comment"
          ? "reply"
          : input.job.type === "comment_on_post"
            ? "comment"
            : "comment",
    action:
      input.job.type === "create_post"
        ? "posted"
        : input.job.type === "reply_to_comment"
          ? "replied"
          : input.job.type === "comment_on_post"
            ? "commented"
            : "skipped",
    content: input.job.payload.content ?? "",
    createdAt: input.outcome.occurredAt ?? input.now.toISOString(),
    targetId: input.job.payload.parentId ?? input.job.candidateId,
    targetTitle: input.job.payload.title,
    targetUrl: input.outcome.remoteContentUrl,
    nextEligibleAt: nextActionCooldownAt({
      actionType: input.job.type,
      now: input.now,
      config: input.config.actionExecution
    }),
    status: "posted",
    controller: getRedditControllerConfig(input.config).controller,
    decisionReason: `Executed queued ${input.job.type}.`
  };
  return {
    ...input.store,
    history: [...input.store.history, entry].slice(-500)
  };
}

export type QueuedRedditExecutionResult =
  | {
      executed: true;
      store: RedditMemoryStore;
      outcome: VenueOutcome;
      recorded?: RedditDecisionMemoryEntry;
      skipped?: undefined;
    }
  | {
      executed: false;
      store: RedditMemoryStore;
      outcome?: undefined;
      recorded?: undefined;
      skipped?: string;
    };

export async function executeQueuedRedditJob(
  store: RedditMemoryStore,
  input: {
    config: MoltbookRuntimeConfig;
    publishAction?: (action: VenueAction) => Promise<VenueOutcome>;
    now: Date;
    fetchImpl?: typeof fetch;
  }
): Promise<QueuedRedditExecutionResult | undefined> {
  let outcome: VenueOutcome;
  const operating = getRedditOperatingAgentConfig(input.config);
  const selection = pickNextExecutableJob({
    jobs: store.queuedJobs ?? [],
    records: redditExecutionRecords(store.history),
    now: input.now,
    config: input.config.actionExecution
  });
  if (!selection.selectedJob) {
    const nextStore = { ...store, queuedJobs: selection.jobs };
    if (selection.skipped || selection.jobs !== (store.queuedJobs ?? [])) {
      await createRedditRuntimeStore(input.config).save( nextStore);
    }
    return selection.skipped
      ? { executed: false, store: nextStore, skipped: selection.skipped }
      : undefined;
  }

  let currentJobs = selection.jobs;
  const queuedJob = selection.selectedJob;
  await createRedditRuntimeStore(input.config).save( { ...store, queuedJobs: currentJobs });
  const metadata = isQueuedRedditWriteMetadata(queuedJob.payload.raw)
    ? queuedJob.payload.raw
    : undefined;
  try {
    outcome = input.publishAction
      ? await input.publishAction(queuedJob.payload)
      : await createVenueProvider(input.config).publishAction(queuedJob.payload);
  } catch (error) {
    if (metadata) {
      await recordRedditPromptRotationFailure(input.config, metadata, input.now).catch(() => undefined);
    }
    const requeued = requeueFailedActionJob({
      jobs: currentJobs,
      jobId: queuedJob.id,
      error,
      now: input.now,
      config: input.config.actionExecution
    });
    const nextStore = { ...store, queuedJobs: requeued.jobs };
    await createRedditRuntimeStore(input.config).save( nextStore);
    if (requeued.retrying) {
      const retryJob = requeued.jobs.find((job) => job.id === queuedJob.id);
      return {
        executed: false,
        store: nextStore,
        skipped: `Queued Reddit ${queuedJob.type} failed and will retry after ${retryJob?.notBefore ?? "backoff"}.`
      };
    }
    throw error;
  }

  if (!metadata) {
    const nextStore = recordNonWriteRedditExecution({
      store,
      job: queuedJob,
      outcome,
      now: input.now,
      config: input.config
    });
    const savedStore = {
      ...nextStore,
      queuedJobs: removeActionJob(currentJobs, queuedJob.id)
    };
    await createRedditRuntimeStore(input.config).save( savedStore);
    return {
      executed: true,
      store: savedStore,
      outcome,
      recorded: savedStore.history.at(-1)
    };
  }

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
    nextEligibleAt: nextActionCooldownAt({
      actionType: queuedJob.type,
      now: input.now,
      config: input.config.actionExecution
    }),
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
    queuedJobs: removeActionJob(currentJobs, queuedJob.id)
  };
  await createRedditRuntimeStore(input.config).save( nextStore);
  await recordRedditPromptRotationPublished(input.config, metadata, recorded, input.now);
  return {
    executed: true,
    store: nextStore,
    outcome,
    recorded
  };
}
