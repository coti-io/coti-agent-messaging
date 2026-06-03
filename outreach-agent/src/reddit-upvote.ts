import {
  getRedditControllerConfig,
  type MoltbookRuntimeConfig,
  type RedditOperatingAgentConfig
} from "./config.js";
import { createActionJob } from "./action-planning.js";
import { scheduleActionJobNotBefore, type ActionExecutionRecord } from "./action-execution.js";
import { enqueueActionJobs } from "./job-queue.js";
import type { RedditConversationSnapshot } from "./reddit-controller.js";
import { formatRedditThingId } from "./reddit-unofficial.js";
import type { RedditPlannedAction } from "./reddit-policy.js";
import type { RedditIngestionResult } from "./reddit-ingestion.js";
import { resolveSourceThreadPostId, type RedditSourceItem } from "./reddit-outreach.js";
import { saveRedditMemory, type RedditDecisionMemoryEntry, type RedditMemoryStore } from "./reddit-memory.js";
import type { VenueAction, VenueOutcome } from "./venue.js";

export interface RedditUpvoteAttemptResult {
  memory: RedditMemoryStore;
  attempted: boolean;
  succeeded: boolean;
  notes: string[];
  skipped: string[];
}

export function resolveUpvoteTargetForPlannedAction(planned: RedditPlannedAction): {
  thingId: string;
  bareId: string;
  targetKind: "post" | "comment";
} {
  const source = planned.item.source;
  if (planned.type === "reply_to_comment" || source.kind === "comment") {
    return {
      thingId: formatRedditThingId(source.id, "t1"),
      bareId: source.id,
      targetKind: "comment"
    };
  }
  const postId = source.threadPostId ?? (source.kind === "post" ? source.id : undefined);
  if (!postId) {
    throw new Error("Missing post id for upvote target.");
  }
  return {
    thingId: formatRedditThingId(postId, "t3"),
    bareId: postId,
    targetKind: "post"
  };
}

export function findThreadSnapshotForSource(
  snapshots: readonly RedditConversationSnapshot[],
  source: RedditSourceItem
): RedditConversationSnapshot | undefined {
  const threadPostId = resolveSourceThreadPostId(source);
  if (!threadPostId) {
    return undefined;
  }
  return snapshots.find((snapshot) => snapshot.thread.id === threadPostId);
}

export async function tryUpvoteBeforeReply(input: {
  config: MoltbookRuntimeConfig;
  operating: RedditOperatingAgentConfig;
  plannedAction: RedditPlannedAction;
  memory: RedditMemoryStore;
  ingestion: Pick<RedditIngestionResult, "snapshots">;
  dryRun: boolean;
  now: Date;
  publishAction?: (action: VenueAction) => Promise<VenueOutcome>;
}): Promise<RedditUpvoteAttemptResult> {
  const notes: string[] = [];
  const skipped: string[] = [];
  if (!input.operating.upvoteEnabled || !input.operating.upvoteBeforeReply) {
    return { memory: input.memory, attempted: false, succeeded: false, notes, skipped };
  }

  const controller = getRedditControllerConfig(input.config).controller;
  if (controller !== "unofficial" && controller !== "api") {
    skipped.push(`Upvote skipped: Reddit ${controller} controller does not support voting.`);
    return { memory: input.memory, attempted: false, succeeded: false, notes, skipped };
  }

  if (input.operating.maxUpvotesPerSession < 1) {
    skipped.push("Upvote skipped: OUTREACH_REDDIT_MAX_UPVOTES_PER_SESSION is 0.");
    return { memory: input.memory, attempted: false, succeeded: false, notes, skipped };
  }

  const upvoted = new Set(input.memory.upvotedThingIds ?? []);

  let target: ReturnType<typeof resolveUpvoteTargetForPlannedAction>;
  try {
    target = resolveUpvoteTargetForPlannedAction(input.plannedAction);
  } catch (error) {
    skipped.push(`Upvote skipped: ${error instanceof Error ? error.message : String(error)}`);
    return { memory: input.memory, attempted: false, succeeded: false, notes, skipped };
  }

  if (upvoted.has(target.thingId)) {
    skipped.push(`Upvote skipped: already upvoted ${target.thingId}.`);
    return { memory: input.memory, attempted: false, succeeded: false, notes, skipped };
  }

  const snapshot = findThreadSnapshotForSource(input.ingestion.snapshots, input.plannedAction.item.source);
  if (snapshot?.thread.locked) {
    skipped.push(`Upvote skipped: thread locked (${target.thingId}).`);
    return { memory: input.memory, attempted: false, succeeded: false, notes, skipped };
  }
  if (snapshot?.thread.archived) {
    skipped.push(`Upvote skipped: thread archived (${target.thingId}).`);
    return { memory: input.memory, attempted: false, succeeded: false, notes, skipped };
  }
  if (snapshot?.thread.removed) {
    skipped.push(`Upvote skipped: thread removed (${target.thingId}).`);
    return { memory: input.memory, attempted: false, succeeded: false, notes, skipped };
  }

  const subreddit = input.plannedAction.item.source.subreddit;

  if (input.dryRun) {
    notes.push(`Would upvote ${target.targetKind} ${target.thingId} on r/${subreddit}.`);
    return { memory: input.memory, attempted: true, succeeded: false, notes, skipped };
  }

  const action: VenueAction = {
    id: `upvote:${target.bareId}:${input.now.getTime()}`,
    venue: "reddit",
    type: "upvote_post",
    surface: subreddit,
    parentId: target.thingId,
    candidateId: input.plannedAction.item.id,
    raw: { engagement: "upvote", targetKind: target.targetKind }
  };

  const queuedJobs = enqueueActionJobs(input.memory.queuedJobs ?? [], [
    createActionJob({
      action,
      candidateId: input.plannedAction.item.id,
      sourceDecisionId: input.plannedAction.item.id,
      notBefore: scheduleActionJobNotBefore({
        now: input.now,
        actionType: action.type,
        needsContent: false,
        existingJobs: input.memory.queuedJobs ?? [],
        records: redditExecutionRecords(input.memory.history),
        config: input.config.actionExecution
      })
    })
  ]);
  const nextMemory = {
    ...input.memory,
    queuedJobs
  };
  await saveRedditMemory(input.operating.memoryPath, nextMemory);
  notes.push(`Queued upvote ${target.targetKind} ${target.thingId} on r/${subreddit}.`);
  return { memory: nextMemory, attempted: true, succeeded: false, notes, skipped };
}

function redditExecutionRecords(history: readonly RedditDecisionMemoryEntry[]): ActionExecutionRecord[] {
  return history.map((entry) => ({
    venue: "reddit",
    type:
      entry.kind === "upvote" || entry.action === "upvoted"
        ? "upvote_post"
        : entry.kind === "reply" || entry.action === "replied"
          ? "reply_to_comment"
          : entry.kind === "post" || entry.action === "posted"
            ? "create_post"
            : "comment_on_post",
    createdAt: entry.createdAt,
    surface: entry.subreddit,
    status: entry.status ?? entry.action,
    nextEligibleAt: entry.nextEligibleAt
  }));
}
