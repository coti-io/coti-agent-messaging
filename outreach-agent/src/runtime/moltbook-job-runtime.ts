import type { ActionJob } from "../action-planning.js";
import {
  pickNextExecutableJob,
  requeueFailedActionJob,
  type ActionExecutionRecord
} from "../action-execution.js";
import { removeActionJob, summarizeActionJobs, enqueueActionJobs as enqueueJobs } from "../job-queue.js";
import type { GeneratedWriteDecision, WriteCandidate } from "../llm-content.js";
import { MoltbookApiError, type MoltbookComment } from "../moltbook-api.js";
import { MoltbookVenueProvider } from "../moltbook-venue.js";
import {
  applyActionResult,
  contentFingerprint,
  normalizeState,
  replyParentKey,
  topLevelCommentParentKey,
  type EngagementEventType,
  type OutreachAgentState,
  type PendingWrite
} from "../policy.js";
import type { MoltbookRuntimeConfig } from "../config.js";
import { saveOutreachRefToAttributionStore, readRefAttributionCounts } from "../attribution-store.js";
import { recordPromptRotationAction } from "../prompt-rotation.js";
import type { OutreachRef } from "../outreach-attribution.js";
import type { VenueAction, VenueOutcome } from "../venue.js";
import {
  PENDING_WRITE_MAX_RECONCILIATION_MISSES,
  type HeartbeatErrorEntry,
  type HeartbeatReport,
  type QueuedWriteJobMetadata
} from "../heartbeat-types.js";

export function toHeartbeatError(phase: string, error: unknown): HeartbeatErrorEntry {
  if (error instanceof Error) {
    return {
      phase,
      message: error.message,
      name: error.name
    };
  }

  return {
    phase,
    message: String(error)
  };
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof MoltbookApiError) {
    return `Moltbook API ${error.statusCode}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function buildPendingWrite(candidate: WriteCandidate, decision: GeneratedWriteDecision): PendingWrite {
  const createdAt = new Date().toISOString();
  switch (candidate.type) {
    case "create_post":
      return {
        id: candidate.id,
        type: "post",
        fingerprint: decision.fingerprint || contentFingerprint(`${decision.title}\n${decision.content}`),
        title: decision.title,
        content: decision.content,
        promptProfileId: decision.promptProfileId,
        promptVariantId: decision.promptVariantId,
        promptVariantRationale: decision.promptVariantRationale,
        promptParameters: decision.promptParameters,
        layout: decision.layout,
        ctaUrl: decision.ctaUrl,
        outreachRef: decision.outreachRef,
        structuralFingerprint: decision.structuralFingerprint,
        createdAt
      };
    case "comment_on_post": {
      const postId = candidate.post.post_id ?? candidate.post.id;
      return {
        id: candidate.id,
        type: "comment",
        fingerprint: contentFingerprint(decision.content),
        content: decision.content,
        postId,
        targetSummary: `${candidate.post.title} ${candidate.post.content_preview ?? ""}`.trim(),
        promptProfileId: decision.promptProfileId,
        promptVariantId: decision.promptVariantId,
        promptVariantRationale: decision.promptVariantRationale,
        promptParameters: decision.promptParameters,
        layout: decision.layout,
        ctaUrl: decision.ctaUrl,
        outreachRef: decision.outreachRef,
        structuralFingerprint: decision.structuralFingerprint,
        createdAt
      };
    }
    case "reply_to_activity":
      return {
        id: candidate.id,
        type: "reply",
        fingerprint: contentFingerprint(decision.content),
        content: decision.content,
        postId: candidate.postId,
        targetCommentId: candidate.target.commentId,
        targetSummary: candidate.target.content,
        replyToAuthor: candidate.target.authorName,
        promptProfileId: decision.promptProfileId,
        promptVariantId: decision.promptVariantId,
        promptVariantRationale: decision.promptVariantRationale,
        promptParameters: decision.promptParameters,
        layout: decision.layout,
        ctaUrl: decision.ctaUrl,
        outreachRef: decision.outreachRef,
        structuralFingerprint: decision.structuralFingerprint,
        createdAt
      };
  }
}

function enrichPendingWriteWithOutcome(pendingWrite: PendingWrite, outcome: VenueOutcome): PendingWrite {
  const outreachRef = enrichOutreachRef(pendingWrite.outreachRef, outcome);
  if (outreachRef === pendingWrite.outreachRef) {
    return pendingWrite;
  }
  return {
    ...pendingWrite,
    outreachRef
  };
}

function enrichOutreachRef(
  outreachRef: OutreachRef | undefined,
  outcome: Pick<VenueOutcome, "remoteContentId" | "remoteContentUrl">
): OutreachRef | undefined {
  if (!outreachRef) {
    return undefined;
  }
  const remoteContentId = outcome.remoteContentId ?? outreachRef.remoteContentId;
  const remoteContentUrl = outcome.remoteContentUrl ?? outreachRef.remoteContentUrl;
  if (remoteContentId === outreachRef.remoteContentId && remoteContentUrl === outreachRef.remoteContentUrl) {
    return outreachRef;
  }
  return {
    ...outreachRef,
    remoteContentId,
    remoteContentUrl
  };
}

async function persistPublishedOutreachRef(
  config: MoltbookRuntimeConfig,
  outreachRef: OutreachRef | undefined
): Promise<void> {
  if (!outreachRef?.remoteContentId && !outreachRef?.remoteContentUrl) {
    return;
  }
  await saveOutreachRefToAttributionStore(config.attributionDbPath, outreachRef).catch(() => undefined);
}

async function recordMoltbookPromptRotation(
  config: MoltbookRuntimeConfig,
  actionType: WriteCandidate["type"],
  pendingWrite: PendingWrite,
  decision: GeneratedWriteDecision,
  status: "posted" | "commented" | "replied" | "recovered" | "failed",
  eventType: "published" | "recovered" | "failed",
  createdAt = new Date().toISOString()
): Promise<void> {
  if (!pendingWrite.promptVariantId) {
    return;
  }
  const refAttribution =
    pendingWrite.outreachRef?.id && config.attributionDbPath
      ? await readRefAttributionCounts(config.attributionDbPath, pendingWrite.outreachRef.id).catch(
          () => undefined
        )
      : undefined;
  await recordPromptRotationAction({
    config,
    selection: {
      variantId: pendingWrite.promptVariantId,
      label: decision.promptVariantLabel,
      rationale: pendingWrite.promptVariantRationale ?? decision.promptVariantRationale ?? "",
      rotateAfterActions: decision.promptRotateAfterActions ?? 10,
      reusedExisting: decision.promptRotationReusedExisting ?? true,
      selectionSource:
        decision.promptSelectionSource === "llm" || decision.promptSelectionSource === "deterministic_fallback"
          ? decision.promptSelectionSource
          : undefined,
      selectedAt: createdAt,
      selectionDebugPath: decision.promptSelectionDebugPath
    },
    entry: {
      id: `moltbook:${pendingWrite.id}:${status}`,
      venue: "moltbook",
      actionType,
      scopeKey:
        decision.promptRotationScopeKey === "moltbook:create_post" ||
        decision.promptRotationScopeKey === "moltbook:comment_on_post" ||
        decision.promptRotationScopeKey === "moltbook:reply_to_activity"
          ? decision.promptRotationScopeKey
          : undefined,
      createdAt,
      status,
      promptProfileId: pendingWrite.promptProfileId,
      promptVariantId: pendingWrite.promptVariantId,
      promptVariantLabel: decision.promptVariantLabel,
      promptParameters: pendingWrite.promptParameters,
      layout: pendingWrite.layout,
      messageStyle: pendingWrite.promptParameters?.messageStyle,
      technicalDepth: pendingWrite.promptParameters?.technicalDepth,
      tone: pendingWrite.promptParameters?.tone,
      creativity: pendingWrite.promptParameters?.creativity,
      clickCount: refAttribution?.clicks,
      grantClaimCount: refAttribution?.grantClaimsSucceeded,
      privateMessageCount: refAttribution?.privateMessagesReceived,
      selectionSource:
        decision.promptSelectionSource === "llm" || decision.promptSelectionSource === "deterministic_fallback"
          ? decision.promptSelectionSource
          : undefined,
      rotateAfterActions: decision.promptRotateAfterActions,
      selectionRationale: pendingWrite.promptVariantRationale ?? decision.promptVariantRationale,
      correlationId: pendingWrite.id,
      debugInputPath: decision.promptSelectionDebugPath
    },
    eventType
  });
}

export function enqueueMoltbookActionJobs(state: OutreachAgentState, jobs: readonly ActionJob[]): OutreachAgentState {
  return normalizeState({
    ...state,
    queuedActionJobs: enqueueJobs(state.queuedActionJobs, jobs)
  });
}

export function removeMoltbookQueuedActionJob(state: OutreachAgentState, jobId: string): OutreachAgentState {
  return normalizeState({
    ...state,
    queuedActionJobs: removeActionJob(state.queuedActionJobs, jobId)
  });
}

export function summarizeMoltbookQueuedActionJobs(state: OutreachAgentState): HeartbeatReport["queuedActionJobs"] {
  return summarizeActionJobs(state.queuedActionJobs);
}

function getQueuedWriteJobMetadata(job: ActionJob): QueuedWriteJobMetadata | undefined {
  const raw = job.payload.raw;
  if (!raw || typeof raw !== "object" || !("kind" in raw)) {
    return undefined;
  }
  return raw.kind === "queued_write" ? (raw as QueuedWriteJobMetadata) : undefined;
}

export function moltbookExecutionRecords(state: OutreachAgentState): ActionExecutionRecord[] {
  const records = state.engagementEvents.map((event) => ({
    venue: "moltbook" as const,
    type: moltbookActionTypeFromEngagement(event.type),
    createdAt: event.createdAt,
    status: "posted"
  }));
  if (state.lastPostAt && !records.some((record) => record.type === "create_post")) {
    records.push({
      venue: "moltbook",
      type: "create_post",
      createdAt: state.lastPostAt,
      status: "posted"
    });
  }
  if (state.lastCommentAt && !records.some((record) => record.type === "comment_on_post" || record.type === "reply_to_comment")) {
    records.push({
      venue: "moltbook",
      type: "comment_on_post",
      createdAt: state.lastCommentAt,
      status: "posted"
    });
  }
  return records;
}

function moltbookActionTypeFromEngagement(type: EngagementEventType): VenueAction["type"] {
  switch (type) {
    case "post":
      return "create_post";
    case "reply":
      return "reply_to_comment";
    case "upvote":
      return "upvote_post";
    case "follow":
      return "follow_account";
    case "comment":
      return "comment_on_post";
  }
}

export async function executeDueActionJobs(
  venue: MoltbookVenueProvider,
  state: OutreachAgentState,
  report: HeartbeatReport,
  persistState: (state: OutreachAgentState) => Promise<void>,
  config: MoltbookRuntimeConfig,
  dryRun: boolean,
  performed: string[],
  skipped: string[]
): Promise<OutreachAgentState> {
  if (dryRun || state.queuedActionJobs.length === 0) {
    report.queuedActionJobs = summarizeMoltbookQueuedActionJobs(state);
    return state;
  }
  let nextState = state;
  for (const job of state.queuedActionJobs) {
    const writeMetadata = getQueuedWriteJobMetadata(job);
    if (job.status === "running" && writeMetadata) {
      if (!nextState.pendingWrites.some((entry) => entry.id === writeMetadata.candidate.id)) {
        nextState = removeMoltbookQueuedActionJob(nextState, job.id);
        await persistState(nextState);
      }
      continue;
    }
  }

  const selection = pickNextExecutableJob({
    jobs: nextState.queuedActionJobs,
    records: moltbookExecutionRecords(nextState),
    now: new Date(),
    config: config.actionExecution
  });
  nextState = normalizeState({
    ...nextState,
    queuedActionJobs: selection.jobs
  });
  if (!selection.selectedJob) {
    if (selection.skipped) {
      skipped.push(selection.skipped);
    }
    await persistState(nextState);
    report.queuedActionJobs = summarizeMoltbookQueuedActionJobs(nextState);
    return nextState;
  }

  const job = selection.selectedJob;
  const writeMetadata = getQueuedWriteJobMetadata(job);
  if (writeMetadata) {
    const pendingWrite = buildPendingWrite(writeMetadata.candidate, writeMetadata.decision);
    nextState = addPendingWrite(nextState, pendingWrite);
    await persistState(nextState);
    try {
      const outcome = await venue.publishAction(job.payload);
      const publishedWrite = enrichPendingWriteWithOutcome(pendingWrite, outcome);
      await persistPublishedOutreachRef(config, publishedWrite.outreachRef);
      await recordMoltbookPromptRotation(
        config,
        writeMetadata.candidate.type,
        publishedWrite,
        writeMetadata.decision,
        queuedWriteStatus(writeMetadata.candidate.type),
        "published"
      );
      nextState = removeMoltbookQueuedActionJob(
        removePendingWrite(recoverPendingWrite(nextState, publishedWrite), pendingWrite.id),
        job.id
      );
      if (writeMetadata.markNotificationsPostId) {
        await venue.markNotificationsReadByPost(writeMetadata.markNotificationsPostId);
      }
      performed.push(writeMetadata.successMessage);
    } catch (error) {
      report.errors.push(toHeartbeatError(`publish:${writeMetadata.failureLabel}`, error));
      await recordMoltbookPromptRotation(
        config,
        writeMetadata.candidate.type,
        pendingWrite,
        writeMetadata.decision,
        "failed",
        "failed"
      ).catch(() => undefined);
      const requeued = requeueFailedActionJob({
        jobs: nextState.queuedActionJobs,
        jobId: job.id,
        error,
        now: new Date(),
        config: config.actionExecution
      });
      nextState = removePendingWrite(
        normalizeState({ ...nextState, queuedActionJobs: requeued.jobs }),
        pendingWrite.id
      );
      skipped.push(
        requeued.retrying
          ? `skipped ${writeMetadata.failureLabel} because Moltbook publish failed; retry queued.`
          : `skipped ${writeMetadata.failureLabel} because Moltbook publish failed: ${formatErrorMessage(error)}`
      );
    }
    await persistState(nextState);
    report.queuedActionJobs = summarizeMoltbookQueuedActionJobs(nextState);
    return nextState;
  }

  const actionLabel = describeQueuedActionLabel(job);
  await persistState(nextState);
  try {
    await venue.publishAction(job.payload);
    if (job.type === "upvote_post" && job.payload.parentId) {
      nextState = applyActionResult(nextState, { type: "upvote_post", postId: job.payload.parentId });
      performed.push(actionLabel.replace(/^upvote /, "Upvoted "));
    } else if (job.type === "follow_account" && job.payload.parentId) {
      nextState = applyActionResult(nextState, { type: "follow_agent", agentName: job.payload.parentId });
      performed.push(actionLabel.replace(/^follow /, "Followed "));
    } else {
      performed.push(`Executed queued ${actionLabel}.`);
    }
    nextState = removeMoltbookQueuedActionJob(nextState, job.id);
  } catch (error) {
    report.errors.push(toHeartbeatError(`publish:${actionLabel}`, error));
    const requeued = requeueFailedActionJob({
      jobs: nextState.queuedActionJobs,
      jobId: job.id,
      error,
      now: new Date(),
      config: config.actionExecution
    });
    nextState = normalizeState({ ...nextState, queuedActionJobs: requeued.jobs });
    skipped.push(
      requeued.retrying
        ? `skipped ${actionLabel} because Moltbook publish failed; retry queued.`
        : `skipped ${actionLabel} because Moltbook publish failed: ${formatErrorMessage(error)}`
    );
  }
  await persistState(nextState);
  report.queuedActionJobs = summarizeMoltbookQueuedActionJobs(nextState);
  return nextState;
}

function queuedWriteStatus(
  type: WriteCandidate["type"]
): "posted" | "commented" | "replied" {
  switch (type) {
    case "create_post":
      return "posted";
    case "comment_on_post":
      return "commented";
    case "reply_to_activity":
      return "replied";
  }
}

function describeQueuedActionLabel(job: ActionJob): string {
  if (job.type === "upvote_post") {
    const title =
      typeof job.payload.raw === "object" &&
      job.payload.raw &&
      "post" in job.payload.raw &&
      typeof job.payload.raw.post === "object" &&
      job.payload.raw.post &&
      "title" in job.payload.raw.post
        ? String(job.payload.raw.post.title)
        : job.payload.parentId;
    return `upvote "${title ?? job.payload.parentId ?? job.candidateId}"`;
  }
  if (job.type === "follow_account") {
    return `follow ${job.payload.parentId ?? job.candidateId}`;
  }
  return job.type;
}

function addPendingWrite(state: OutreachAgentState, pendingWrite: PendingWrite): OutreachAgentState {
  return normalizeState({
    ...state,
    pendingWrites: [
      ...state.pendingWrites.filter((entry) => entry.id !== pendingWrite.id),
      {
        ...pendingWrite,
        reconciliationMisses: pendingWrite.reconciliationMisses ?? 0
      }
    ]
  });
}

function removePendingWrite(state: OutreachAgentState, pendingWriteId: string): OutreachAgentState {
  return normalizeState({
    ...state,
    pendingWrites: state.pendingWrites.filter((entry) => entry.id !== pendingWriteId)
  });
}

function updatePendingWrite(
  state: OutreachAgentState,
  pendingWriteId: string,
  updater: (pendingWrite: PendingWrite) => PendingWrite
): OutreachAgentState {
  return normalizeState({
    ...state,
    pendingWrites: state.pendingWrites.map((pendingWrite) =>
      pendingWrite.id === pendingWriteId ? updater(pendingWrite) : pendingWrite
    )
  });
}

function recoverPendingWrite(state: OutreachAgentState, pendingWrite: PendingWrite): OutreachAgentState {
  switch (pendingWrite.type) {
    case "post":
      return applyActionResult(state, {
        type: "create_post",
        fingerprint: pendingWrite.fingerprint,
        title: pendingWrite.title ?? "Untitled post",
        content: pendingWrite.content,
        promptProfileId: pendingWrite.promptProfileId,
        promptVariantId: pendingWrite.promptVariantId,
        promptVariantRationale: pendingWrite.promptVariantRationale,
        promptParameters: pendingWrite.promptParameters,
        layout: pendingWrite.layout,
        ctaUrl: pendingWrite.ctaUrl,
        outreachRef: pendingWrite.outreachRef,
        structuralFingerprint: pendingWrite.structuralFingerprint,
        createdAt: pendingWrite.createdAt
      });
    case "comment":
      return applyActionResult(state, {
        type: "comment",
        commentId: topLevelCommentParentKey(pendingWrite.postId ?? pendingWrite.id),
        content: pendingWrite.content,
        targetSummary: pendingWrite.targetSummary,
        promptProfileId: pendingWrite.promptProfileId,
        promptVariantId: pendingWrite.promptVariantId,
        promptVariantRationale: pendingWrite.promptVariantRationale,
        promptParameters: pendingWrite.promptParameters,
        layout: pendingWrite.layout,
        ctaUrl: pendingWrite.ctaUrl,
        outreachRef: pendingWrite.outreachRef,
        structuralFingerprint: pendingWrite.structuralFingerprint,
        createdAt: pendingWrite.createdAt
      });
    case "reply":
      return applyActionResult(state, {
        type: "comment",
        commentId: replyParentKey(pendingWrite.targetCommentId ?? pendingWrite.id),
        content: pendingWrite.content,
        targetSummary: pendingWrite.targetSummary,
        replyToAuthor: pendingWrite.replyToAuthor,
        promptProfileId: pendingWrite.promptProfileId,
        promptVariantId: pendingWrite.promptVariantId,
        promptVariantRationale: pendingWrite.promptVariantRationale,
        promptParameters: pendingWrite.promptParameters,
        layout: pendingWrite.layout,
        ctaUrl: pendingWrite.ctaUrl,
        outreachRef: pendingWrite.outreachRef,
        structuralFingerprint: pendingWrite.structuralFingerprint,
        createdAt: pendingWrite.createdAt
      });
  }
}

export async function reconcilePendingWrites(
  venue: MoltbookVenueProvider,
  config: MoltbookRuntimeConfig,
  agentName: string | undefined,
  state: OutreachAgentState,
  report: HeartbeatReport,
  persistState: (state: OutreachAgentState) => Promise<void>
): Promise<OutreachAgentState> {
  if (!agentName || state.pendingWrites.length === 0) {
    return state;
  }

  try {
    const profile = await venue.getAgentProfile(agentName);
    let nextState = state;
    let recoveredAny = false;
    let expiredAny = false;
    let updatedAny = false;
    for (const pendingWrite of state.pendingWrites) {
      const recovered = await matchesPendingWrite(venue, profile, pendingWrite);
      if (recovered) {
        if (pendingWrite.promptVariantId) {
          await recordPromptRotationAction({
            config,
            eventType: "recovered",
            entry: {
              id: `moltbook:${pendingWrite.id}:recovered`,
              venue: "moltbook",
              actionType:
                pendingWrite.type === "post"
                  ? "create_post"
                  : pendingWrite.type === "comment"
                    ? "comment_on_post"
                    : "reply_to_activity",
              createdAt: new Date().toISOString(),
              status: "recovered",
              promptProfileId: pendingWrite.promptProfileId,
              promptVariantId: pendingWrite.promptVariantId,
              promptParameters: pendingWrite.promptParameters,
              layout: pendingWrite.layout,
              messageStyle: pendingWrite.promptParameters?.messageStyle,
              technicalDepth: pendingWrite.promptParameters?.technicalDepth,
              tone: pendingWrite.promptParameters?.tone,
              creativity: pendingWrite.promptParameters?.creativity,
              selectionRationale: pendingWrite.promptVariantRationale,
              correlationId: pendingWrite.id
            }
          }).catch(() => undefined);
        }
        nextState = removePendingWrite(recoverPendingWrite(nextState, pendingWrite), pendingWrite.id);
        report.reconciledPendingWrites.push({
          id: pendingWrite.id,
          type: pendingWrite.type,
          status: "recovered"
        });
        recoveredAny = true;
      } else {
        const nextMissCount = (pendingWrite.reconciliationMisses ?? 0) + 1;
        if (shouldExpirePendingWrite(nextMissCount)) {
          nextState = removePendingWrite(nextState, pendingWrite.id);
          report.reconciledPendingWrites.push({
            id: pendingWrite.id,
            type: pendingWrite.type,
            status: "expired"
          });
          expiredAny = true;
          continue;
        }

        nextState = updatePendingWrite(nextState, pendingWrite.id, (entry) => ({
          ...entry,
          reconciliationMisses: nextMissCount
        }));
        updatedAny = true;
        report.reconciledPendingWrites.push({
          id: pendingWrite.id,
          type: pendingWrite.type,
          status: "still_pending"
        });
      }
    }

    if (recoveredAny || expiredAny || updatedAny) {
      await persistState(nextState);
    }

    return nextState;
  } catch {
    for (const pendingWrite of state.pendingWrites) {
      report.reconciledPendingWrites.push({
        id: pendingWrite.id,
        type: pendingWrite.type,
        status: "reconcile_failed"
      });
    }

    return state;
  }
}

async function matchesPendingWrite(
  venue: MoltbookVenueProvider,
  profile: Awaited<ReturnType<MoltbookVenueProvider["getAgentProfile"]>>,
  pendingWrite: PendingWrite
): Promise<boolean> {
  switch (pendingWrite.type) {
    case "post":
      return matchPendingPost(venue, profile, pendingWrite);
    case "comment":
      return matchPendingComment(venue, profile, pendingWrite);
    case "reply":
      return matchPendingReply(venue, profile, pendingWrite);
  }
}

function shouldExpirePendingWrite(reconciliationMisses: number): boolean {
  return reconciliationMisses >= PENDING_WRITE_MAX_RECONCILIATION_MISSES;
}

async function matchPendingPost(
  venue: MoltbookVenueProvider,
  profile: Awaited<ReturnType<MoltbookVenueProvider["getAgentProfile"]>>,
  pendingWrite: PendingWrite
): Promise<boolean> {
  const profileMatch = (profile.recentPosts ?? []).some((post) => {
    const remoteFingerprint = contentFingerprint(`${post.title ?? ""}\n${post.content ?? post.content_preview ?? ""}`);
    return remoteFingerprint === pendingWrite.fingerprint;
  });
  if (profileMatch) {
    return true;
  }

  const searchMatch = await searchForPendingWrite(venue, pendingWrite);
  return searchMatch;
}

async function matchPendingComment(
  venue: MoltbookVenueProvider,
  profile: Awaited<ReturnType<MoltbookVenueProvider["getAgentProfile"]>>,
  pendingWrite: PendingWrite
): Promise<boolean> {
  const profileMatch = (profile.recentComments ?? []).some((comment) =>
    matchesCommentFingerprint(comment, pendingWrite)
  );
  if (profileMatch) {
    return true;
  }

  const threadMatch = await matchPendingWriteInThread(venue, pendingWrite);
  if (threadMatch) {
    return true;
  }

  return searchForPendingWrite(venue, pendingWrite);
}

async function matchPendingReply(
  venue: MoltbookVenueProvider,
  profile: Awaited<ReturnType<MoltbookVenueProvider["getAgentProfile"]>>,
  pendingWrite: PendingWrite
): Promise<boolean> {
  const profileMatch = (profile.recentComments ?? []).some((comment) =>
    matchesCommentFingerprint(comment, pendingWrite)
  );
  if (profileMatch) {
    return true;
  }

  const threadMatch = await matchPendingWriteInThread(venue, pendingWrite);
  if (threadMatch) {
    return true;
  }

  return searchForPendingWrite(venue, pendingWrite);
}

function matchesCommentFingerprint(comment: MoltbookComment, pendingWrite: PendingWrite): boolean {
  if (pendingWrite.postId && comment.post_id && comment.post_id !== pendingWrite.postId) {
    return false;
  }

  if (pendingWrite.type === "reply" && pendingWrite.targetCommentId) {
    if (comment.parent_id !== pendingWrite.targetCommentId) {
      return false;
    }
  }

  return contentFingerprint(comment.content) === pendingWrite.fingerprint;
}

async function matchPendingWriteInThread(
  venue: MoltbookVenueProvider,
  pendingWrite: PendingWrite
): Promise<boolean> {
  if (!pendingWrite.postId) {
    return false;
  }

  const comments = await venue.getPostComments(pendingWrite.postId, {
    sort: "new",
    limit: 100
  });
  return flattenComments(comments.comments ?? []).some((comment) =>
    matchesCommentFingerprint(comment, pendingWrite)
  );
}

function flattenComments(comments: readonly MoltbookComment[]): MoltbookComment[] {
  const flattened: MoltbookComment[] = [];
  for (const comment of comments) {
    flattened.push(comment);
    if (comment.replies?.length) {
      flattened.push(...flattenComments(comment.replies));
    }
  }

  return flattened;
}

async function searchForPendingWrite(
  venue: MoltbookVenueProvider,
  pendingWrite: PendingWrite
): Promise<boolean> {
  const query = buildPendingWriteSearchQuery(pendingWrite);
  if (!query) {
    return false;
  }

  const response = await venue.search({
    q: query,
    type: pendingWrite.type === "post" ? "posts" : "comments",
    limit: 10
  });
  return (response.results ?? []).some((result) => {
    const remoteFingerprint = contentFingerprint(
      `${result.title ?? result.post?.title ?? ""}\n${result.content ?? ""}`
    );
    if (remoteFingerprint !== pendingWrite.fingerprint) {
      return false;
    }

    if (
      pendingWrite.type !== "post" &&
      pendingWrite.postId &&
      result.post_id &&
      result.post_id !== pendingWrite.postId
    ) {
      return false;
    }

    return true;
  });
}

function buildPendingWriteSearchQuery(pendingWrite: PendingWrite): string {
  const source = pendingWrite.type === "post" ? `${pendingWrite.title ?? ""} ${pendingWrite.content}` : pendingWrite.content;
  return source
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

