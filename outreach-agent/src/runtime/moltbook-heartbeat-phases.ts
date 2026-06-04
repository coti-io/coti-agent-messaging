import type { MoltbookRuntimeConfig } from "../config.js";
import { createActionJob, type ActionJob } from "../action-planning.js";
import { scheduleActionJobNotBefore } from "../action-execution.js";
import {
  buildMoltbookActionCandidates,
  chooseMoltbookActionBundle,
  plannedActionFromCandidate
} from "../moltbook-action-planning.js";
import { MoltbookApiError } from "../moltbook-api.js";
import {
  chooseReplyTargetOrIgnore,
  chooseAndDraftWriteAction,
  isDuplicateDraftError,
  isMissingConcreteProofPointError,
  type GeneratedWriteDecision,
  type WriteCandidate
} from "../llm-content.js";
import {
  canComment,
  getCommentReadiness,
  getDailyCommentBreakdown,
  getPostReadiness,
  isNewAgent,
  listReplyTargets,
  normalizeState,
  selectFollowCandidatesFromComments,
  type OutreachAgentState,
  type PlannedAction
} from "../policy.js";
import { syncMoltbookAccountHealth } from "../moltbook-account-health.js";
import type { VenueAction } from "../venue.js";
import type { HeartbeatReport, QueuedWriteJobMetadata } from "../heartbeat-types.js";
import type { MoltbookHeartbeatSession } from "./moltbook-cycle-strategy.js";
import {
  enqueueMoltbookActionJobs,
  moltbookExecutionRecords,
  reconcilePendingWrites,
  summarizeMoltbookQueuedActionJobs,
  toHeartbeatError
} from "./moltbook-job-runtime.js";
import { loadMoltbookAgentState, saveMoltbookAgentState } from "./moltbook-state-persist.js";

function heartbeatReport(session: MoltbookHeartbeatSession): HeartbeatReport {
  return session.report as unknown as HeartbeatReport;
}

function describeCommentBlockReason(
  state: OutreachAgentState,
  isNew: boolean,
  policy: MoltbookRuntimeConfig["policy"],
  targetLabel: string
): string {
  const readiness = getCommentReadiness(state, isNew, policy);
  const breakdown = getDailyCommentBreakdown(state);
  const usage = `${readiness.usedCount}/${readiness.limitPerDay}`;
  const detail = `comments ${breakdown.topLevelComments}, replies ${breakdown.replies}`;
  if (readiness.reason === "daily_limit") {
    return `daily comment cap reached (${usage}; ${detail}); skipped "${targetLabel}" until the next UTC day.`;
  }

  if (readiness.reason === "paced_cooldown") {
    const waitMinutes = Math.max(1, Math.ceil(readiness.waitMs / 60_000));
    return `comment pacing blocked "${targetLabel}" at ${usage} (${detail}) for about ${waitMinutes} more minute${waitMinutes === 1 ? "" : "s"}.`;
  }

  return `comment gating blocked "${targetLabel}".`;
}

function describePostBlockReason(
  state: OutreachAgentState,
  isNew: boolean,
  policy: MoltbookRuntimeConfig["policy"]
): string | undefined {
  const readiness = getPostReadiness(state, isNew, policy);
  if (readiness.allowed) {
    return undefined;
  }

  if (readiness.reason === "daily_limit" && readiness.limitPerDay !== undefined) {
    return `daily post cap reached (${readiness.usedCount}/${readiness.limitPerDay}); skipped create_post until the next UTC day.`;
  }

  if (readiness.reason === "cooldown") {
    const waitMinutes = Math.max(1, Math.ceil(readiness.waitMs / 60_000));
    return `post cooldown blocked create_post after ${readiness.usedCount}${readiness.limitPerDay !== undefined ? `/${readiness.limitPerDay}` : ""} posts today for about ${waitMinutes} more minute${waitMinutes === 1 ? "" : "s"}.`;
  }

  if (readiness.reason === "moderation_pause") {
    const waitHours = Math.max(1, Math.ceil(readiness.waitMs / 3_600_000));
    const pauseLabel =
      readiness.pauseReason === "spam" ? "spam moderation" : "failed verification";
    return `${pauseLabel} blocked create_post for about ${waitHours} more hour${waitHours === 1 ? "" : "s"}.`;
  }

  return undefined;
}

export async function moltbookHeartbeatLoadContext(session: MoltbookHeartbeatSession): Promise<void> {
  const { config, venue, runId, startedAt } = session;
  const report = heartbeatReport(session);

  const [sources, storedState] = await Promise.all([
    venue.loadHeartbeatSources(),
    loadMoltbookAgentState(config.statePath, config.heartbeatReportPath)
  ]);
  const { home, me, factSheet } = sources;
  session.state = normalizeState(storedState);
  session.workspace.sources = sources;
  session.workspace.home = home;
  session.workspace.me = me;
  session.workspace.factSheet = factSheet;
  session.workspace.agentName = me.agent?.name ?? home.your_account.name;
  session.workspace.persistState = async (nextState: OutreachAgentState): Promise<void> => {
    session.state = normalizeState({
      ...nextState,
      agentId: config.agentId ?? nextState.agentId
    });
    session.state = await saveMoltbookAgentState(config.statePath, session.state, runId);
  };

  const accountHealth = await syncMoltbookAccountHealth({
    state: session.state,
    agentName: session.workspace.agentName,
    config,
    getAgentProfile: (name) => venue.getAgentProfile(name),
    getPost: async (postId) => {
      try {
        const response = await venue.getPost(postId);
        return response.post;
      } catch {
        return undefined;
      }
    },
    now: new Date(startedAt)
  });
  session.state = accountHealth.state;
  report.alerts.push(
    ...accountHealth.alerts.map((message) => ({
      severity: "warning" as const,
      message
    }))
  );
  if (accountHealth.changed) {
    await session.workspace.persistState!(session.state);
  }
}

export async function moltbookHeartbeatReconcilePending(session: MoltbookHeartbeatSession): Promise<void> {
  const { config, venue } = session;
  const report = heartbeatReport(session);
  const persistState = session.workspace.persistState;
  if (!persistState) {
    throw new Error("Moltbook heartbeat workspace missing persistState after load_context.");
  }

  session.state = await reconcilePendingWrites(
    venue,
    config,
    session.workspace.agentName,
    session.state,
    report,
    persistState
  );
}

export async function moltbookHeartbeatDiscoverCandidates(session: MoltbookHeartbeatSession): Promise<void> {
  const { config, venue, startedAt } = session;
  const report = heartbeatReport(session);
  const sources = session.workspace.sources;
  if (!sources) {
    throw new Error("Moltbook heartbeat workspace missing sources after load_context.");
  }

  session.workspace.newAgent = isNewAgent(session.workspace.me?.agent?.created_at, session.state);
  const actionCandidates = buildMoltbookActionCandidates({
    sources,
    state: session.state,
    config,
    policy: config.policy,
    now: new Date(startedAt),
    mode: venue.mode
  });
  session.workspace.actionCandidates = actionCandidates;
  report.actionCandidates = actionCandidates.map((candidate) => ({
    id: candidate.id,
    type: candidate.type,
    source: candidate.source,
    score: candidate.score,
    allowed: candidate.allowed,
    needsContent: candidate.needsContent,
    blockedBy: candidate.constraints.filter((constraint) => !constraint.passed).map((constraint) => constraint.id)
  }));
}

export async function moltbookHeartbeatSelectBundle(session: MoltbookHeartbeatSession): Promise<void> {
  const { config, runId } = session;
  const report = heartbeatReport(session);
  const sources = session.workspace.sources;
  const actionCandidates = session.workspace.actionCandidates;
  if (!sources || !actionCandidates) {
    throw new Error("Moltbook heartbeat workspace missing candidates before select_bundle.");
  }

  const selectedBundle = await chooseMoltbookActionBundle({
    candidates: actionCandidates,
    config,
    sources,
    state: session.state,
    runId
  });
  session.workspace.selectedBundle = selectedBundle;
  report.selectedActionBundle = selectedBundle;
}

export async function moltbookHeartbeatPlanActions(session: MoltbookHeartbeatSession): Promise<void> {
  const { config } = session;
  const report = heartbeatReport(session);
  const { performed, skipped } = session;
  const actionCandidates = session.workspace.actionCandidates ?? [];
  const selectedBundle = session.workspace.selectedBundle;
  if (!selectedBundle) {
    throw new Error("Moltbook heartbeat workspace missing selectedBundle before plan_actions.");
  }

  const newAgent = session.workspace.newAgent ?? false;
  const selectedIds = new Set(selectedBundle.selectedCandidateIds);
  const selectedCandidates = actionCandidates.filter((candidate) => selectedIds.has(candidate.id));
  session.workspace.deferredWriteActions = actionCandidates
    .filter(
      (candidate) =>
        selectedBundle.deferredCandidateIds.includes(candidate.id) && candidate.needsContent
    )
    .map((candidate) => plannedActionFromCandidate(candidate));
  const planned =
    selectedCandidates.length > 0
      ? selectedCandidates.map((candidate) => plannedActionFromCandidate(candidate))
      : actionCandidates
          .filter((candidate) => candidate.type === "noop")
          .slice(0, 1)
          .map((candidate) => plannedActionFromCandidate(candidate));
  session.workspace.planned = planned;
  report.plannedActions = planned.map((entry) => entry.type);
  const plannedActionTypes = new Set(report.plannedActions);
  const postBlockReason = describePostBlockReason(session.state, newAgent, config.policy);
  const selectedCommentLikeAction = planned.some(
    (entry) => entry.type === "reply_to_activity" || entry.type === "comment_on_post"
  );
  if (!selectedCommentLikeAction && !canComment(session.state, newAgent, config.policy)) {
    const highestBlockedCommentCandidate = actionCandidates
      .filter((candidate) => candidate.type === "reply_to_activity" || candidate.type === "comment_on_post")
      .sort((left, right) => right.score - left.score)[0];
    if (highestBlockedCommentCandidate?.title) {
      skipped.push(
        describeCommentBlockReason(
          session.state,
          newAgent,
          config.policy,
          highestBlockedCommentCandidate.title
        )
      );
    }
  }
  if (!plannedActionTypes.has("create_post") && postBlockReason) {
    skipped.push(postBlockReason);
  }
}

export async function moltbookHeartbeatEnqueueJobs(session: MoltbookHeartbeatSession): Promise<void> {
  const { config, venue, runId, startedAt } = session;
  const report = heartbeatReport(session);
  const { performed, skipped } = session;
  const planned = session.workspace.planned ?? [];
  const persistState = session.workspace.persistState;
  const home = session.workspace.home;
  const factSheet = session.workspace.factSheet;
  const newAgent = session.workspace.newAgent ?? false;
  const deferredWriteActions = session.workspace.deferredWriteActions ?? [];
  if (!persistState || !home || !factSheet) {
    throw new Error("Moltbook heartbeat workspace incomplete before enqueue_jobs.");
  }

  const writeCandidates: WriteCandidate[] = [];
  session.workspace.selectedWriteBlockedByConstraint = false;
  const followsAttempted = new Set<string>();
  const scheduledActionJobs: ActionJob[] = [];
  let queuedJobOrder = 0;
  const nextJobNotBefore = (actionType: VenueAction["type"], needsContent: boolean): string =>
    scheduleActionJobNotBefore({
      now: new Date(startedAt),
      actionType,
      order: queuedJobOrder++,
      needsContent,
      existingJobs: [...session.state.queuedActionJobs, ...scheduledActionJobs],
      records: moltbookExecutionRecords(session.state),
      config: config.actionExecution
    });
  session.workspace.nextJobNotBefore = nextJobNotBefore;

  const followBudget = Math.max(0, config.policy?.followMaxPerHeartbeat ?? 3);
  const plannedFollowCount = planned.filter((entry) => entry.type === "follow_agent").length;
  let commentFollowBudget = Math.max(0, followBudget - plannedFollowCount);

  const tryFollowAgent = (agentName: string, reason: string, sourceLabel: string): boolean => {
    if (!agentName || followsAttempted.has(agentName) || session.state.followedAgentNames.includes(agentName)) {
      return false;
    }

    followsAttempted.add(agentName);

    if (config.dryRun) {
      performed.push(`Would queue follow ${agentName} (${sourceLabel}).`);
      return true;
    }
    scheduledActionJobs.push(
      createActionJob({
        action: {
          id: `follow:${agentName}`,
          venue: "moltbook",
          type: "follow_account",
          parentId: agentName,
          raw: { type: "follow_agent", agentName, reason }
        },
        candidateId: `candidate:follow:${agentName}`,
        sourceDecisionId: runId,
        correlationId: report.correlationId,
        notBefore: nextJobNotBefore("follow_account", false)
      })
    );
    performed.push(`Queued follow ${agentName} (${sourceLabel}).`);
    return true;
  };

  for (const action of planned) {
    try {
      switch (action.type) {
        case "reply_to_activity": {
          if (!canComment(session.state, newAgent, config.policy)) {
            session.workspace.selectedWriteBlockedByConstraint = true;
            skipped.push(
              describeCommentBlockReason(session.state, newAgent, config.policy, action.activity.post_title)
            );
            break;
          }

          const comments = await venue.getPostComments(action.activity.post_id, {
            sort: "new",
            limit: 35
          });
          const replyTargets = listReplyTargets({
            postId: action.activity.post_id,
            postTitle: action.activity.post_title,
            comments: comments.comments ?? [],
            state: session.state,
            agentName: home.your_account.name
          });

          if (commentFollowBudget > 0) {
            const followCandidates = selectFollowCandidatesFromComments({
              comments: comments.comments ?? [],
              state: session.state,
              agentName: home.your_account.name,
              policy: config.policy,
              alreadyQueued: followsAttempted,
              remainingBudget: commentFollowBudget
            });
            for (const candidate of followCandidates) {
              if (commentFollowBudget <= 0) {
                break;
              }
              const followed = tryFollowAgent(candidate.agentName, candidate.reason, "comment author");
              if (followed) {
                commentFollowBudget -= 1;
              }
            }
          }

          if (replyTargets.length === 0) {
            skipped.push(`no reply-worthy comment found on "${action.activity.post_title}".`);
            if (!config.dryRun) {
              await venue.markNotificationsReadByPost(action.activity.post_id);
            }
            break;
          }

          const replyDecision = await chooseReplyTargetOrIgnore(
            config,
            {
              postTitle: action.activity.post_title,
              targets: replyTargets.slice(0, 3)
            },
            factSheet,
            session.state
          );
          const target = replyDecision.target;

          if (!target) {
            skipped.push(`LLM declined to reply on "${action.activity.post_title}".`);
            if (!config.dryRun) {
              await venue.markNotificationsReadByPost(action.activity.post_id);
            }
            break;
          }

          writeCandidates.push({
            id: `reply:${action.activity.post_id}:${target.commentId}`,
            type: "reply_to_activity",
            reason: action.reason,
            postId: action.activity.post_id,
            postTitle: action.activity.post_title,
            target
          });
          break;
        }
        case "inspect_dms":
          skipped.push("DM inspection is not automated yet; leaving that for a later iteration.");
          break;
        case "upvote_post": {
          const postId = action.post.post_id ?? action.post.id;
          if (!postId) {
            skipped.push("skipped an upvote because the post id was missing.");
            break;
          }

          if (config.dryRun) {
            performed.push(`Would queue upvote "${action.post.title}".`);
            break;
          }
          scheduledActionJobs.push(
            createActionJob({
              action: {
                id: `upvote:${postId}`,
                venue: "moltbook",
                type: "upvote_post",
                parentId: postId,
                raw: action
              },
              candidateId: `candidate:upvote:${postId}`,
              sourceDecisionId: runId,
              correlationId: report.correlationId,
              notBefore: nextJobNotBefore("upvote_post", false)
            })
          );
          performed.push(`Queued upvote "${action.post.title}".`);
          break;
        }
        case "follow_agent":
          tryFollowAgent(action.agentName, action.reason, "post author");
          break;
        case "comment_on_post": {
          if (!canComment(session.state, newAgent, config.policy)) {
            session.workspace.selectedWriteBlockedByConstraint = true;
            skipped.push(
              describeCommentBlockReason(session.state, newAgent, config.policy, action.post.title)
            );
            break;
          }

          const postId = action.post.post_id ?? action.post.id;
          if (!postId) {
            skipped.push(`could not comment on "${action.post.title}" because the post id was missing.`);
            break;
          }

          writeCandidates.push({
            id: `comment:${postId}`,
            type: "comment_on_post",
            reason: action.reason,
            post: action.post
          });
          break;
        }
        case "create_post": {
          writeCandidates.push({
            id: "create-post",
            type: "create_post",
            reason: action.reason
          });
          break;
        }
        case "noop":
          skipped.push(action.reason);
          break;
      }
    } catch (error) {
      if (error instanceof MoltbookApiError && error.statusCode === 429) {
        skipped.push(`hit a Moltbook rate limit: ${error.message}`);
        break;
      }

      report.errors.push(toHeartbeatError("action-planning", error));
      throw error;
    }
  }

  if (session.workspace.selectedWriteBlockedByConstraint && writeCandidates.length === 0) {
    for (const action of deferredWriteActions) {
      if (action.type === "comment_on_post") {
        if (!canComment(session.state, newAgent, config.policy)) {
          continue;
        }
        const postId = action.post.post_id ?? action.post.id;
        if (!postId) {
          continue;
        }
        writeCandidates.push({
          id: `comment:${postId}`,
          type: "comment_on_post",
          reason: action.reason,
          post: action.post
        });
        continue;
      }
      if (action.type === "create_post") {
        writeCandidates.push({
          id: "create-post",
          type: "create_post",
          reason: action.reason
        });
      }
    }
  }

  session.workspace.writeCandidates = writeCandidates;
  session.workspace.scheduledActionJobs = scheduledActionJobs;

  if (!config.dryRun && scheduledActionJobs.length > 0) {
    session.state = enqueueMoltbookActionJobs(session.state, scheduledActionJobs);
    await persistState(session.state);
  }
  report.queuedActionJobs = summarizeMoltbookQueuedActionJobs(session.state);
}

export async function moltbookHeartbeatDraftContent(session: MoltbookHeartbeatSession): Promise<void> {
  const { config, runId } = session;
  const report = heartbeatReport(session);
  const { performed, skipped } = session;
  const persistState = session.workspace.persistState;
  const factSheet = session.workspace.factSheet;
  const writeCandidates = session.workspace.writeCandidates ?? [];
  const nextJobNotBefore = session.workspace.nextJobNotBefore;
  if (!persistState || !factSheet || !nextJobNotBefore) {
    throw new Error("Moltbook heartbeat workspace incomplete before draft_content.");
  }

  const eligibleWriteCandidates =
    config.forceWriteMode === undefined
      ? writeCandidates
      : writeCandidates.filter((candidate) => candidate.type === config.forceWriteMode);
  session.workspace.eligibleWriteCandidates = eligibleWriteCandidates;
  if (config.forceWriteMode && eligibleWriteCandidates.length === 0) {
    skipped.push(`forced write mode "${config.forceWriteMode}" found no eligible candidate this heartbeat.`);
  }

  report.writeCandidates = eligibleWriteCandidates.map((candidate) => ({
    id: candidate.id,
    type: candidate.type,
    reason: candidate.reason,
    targetSummary:
      candidate.type === "comment_on_post"
        ? `${candidate.post.title} ${candidate.post.content_preview ?? ""}`.trim()
        : candidate.type === "reply_to_activity"
          ? candidate.target.content
          : undefined
  }));

  if (eligibleWriteCandidates.length === 0) {
    return;
  }

  let decision: GeneratedWriteDecision | undefined;
  try {
    decision = await chooseAndDraftWriteAction(config, eligibleWriteCandidates, factSheet, session.state);
  } catch (error) {
    if (isDuplicateDraftError(error)) {
      skipped.push("skipped authored write because the generated draft was too similar to recent authored history.");
    } else if (isMissingConcreteProofPointError(error)) {
      skipped.push("skipped authored write because the generated post still lacked a concrete proof point after retry.");
    } else {
      throw error;
    }
  }

  if (!decision) {
    skipped.push("skipped authored write because the LLM declined all write candidates for this heartbeat.");
    return;
  }

  report.selectedWriteDecision = decision;
  const candidate = eligibleWriteCandidates.find((entry) => entry.id === decision.selectedCandidateId);
  if (!candidate) {
    throw new Error(`Selected write candidate not found: ${decision.selectedCandidateId}`);
  }

  switch (candidate.type) {
    case "reply_to_activity":
      if (config.dryRun) {
        performed.push(
          `Would reply to ${candidate.target.authorName ?? "a commenter"} on "${candidate.postTitle}".`
        );
      } else {
        session.state = enqueueMoltbookActionJobs(session.state, [
          createActionJob({
            action: {
              id: `reply:${candidate.postId}:${candidate.target.commentId}`,
              venue: "moltbook",
              type: "reply_to_comment",
              parentId: candidate.postId,
              candidateId: candidate.target.commentId,
              content: decision.content,
              raw: {
                kind: "queued_write",
                candidate,
                decision,
                failureLabel: `reply on "${candidate.postTitle}"`,
                successMessage: `Replied to ${candidate.target.authorName ?? "a commenter"} on "${candidate.postTitle}".`,
                markNotificationsPostId: candidate.postId
              } satisfies QueuedWriteJobMetadata
            },
            candidateId: candidate.id,
            sourceDecisionId: runId,
            correlationId: report.correlationId,
            notBefore: nextJobNotBefore("reply_to_comment", true)
          })
        ]);
        await persistState(session.state);
        report.queuedActionJobs = summarizeMoltbookQueuedActionJobs(session.state);
        performed.push(
          `Queued reply to ${candidate.target.authorName ?? "a commenter"} on "${candidate.postTitle}".`
        );
      }
      break;
    case "comment_on_post": {
      const postId = candidate.post.post_id ?? candidate.post.id;
      if (!postId) {
        skipped.push(`could not comment on "${candidate.post.title}" because the post id was missing.`);
        break;
      }

      if (config.dryRun) {
        performed.push(`Would comment on "${candidate.post.title}".`);
      } else {
        session.state = enqueueMoltbookActionJobs(session.state, [
          createActionJob({
            action: {
              id: `comment:${postId}`,
              venue: "moltbook",
              type: "comment_on_post",
              parentId: postId,
              content: decision.content,
              raw: {
                kind: "queued_write",
                candidate,
                decision,
                failureLabel: `comment on "${candidate.post.title}"`,
                successMessage: `Commented on "${candidate.post.title}".`
              } satisfies QueuedWriteJobMetadata
            },
            candidateId: candidate.id,
            sourceDecisionId: runId,
            correlationId: report.correlationId,
            notBefore: nextJobNotBefore("comment_on_post", true)
          })
        ]);
        await persistState(session.state);
        report.queuedActionJobs = summarizeMoltbookQueuedActionJobs(session.state);
        performed.push(`Queued comment on "${candidate.post.title}".`);
      }
      break;
    }
    case "create_post":
      if (config.dryRun) {
        performed.push(`Would post "${decision.title ?? "Untitled post"}".`);
      } else {
        session.state = enqueueMoltbookActionJobs(session.state, [
          createActionJob({
            action: {
              id: "create-post",
              venue: "moltbook",
              type: "create_post",
              surface: config.defaultSubmolt,
              title: decision.title!,
              content: decision.content,
              raw: {
                kind: "queued_write",
                candidate,
                decision,
                failureLabel: `post "${decision.title ?? "Untitled post"}"`,
                successMessage: `Posted "${decision.title}".`
              } satisfies QueuedWriteJobMetadata
            },
            candidateId: candidate.id,
            sourceDecisionId: runId,
            correlationId: report.correlationId,
            notBefore: nextJobNotBefore("create_post", true)
          })
        ]);
        await persistState(session.state);
        report.queuedActionJobs = summarizeMoltbookQueuedActionJobs(session.state);
        performed.push(`Queued post "${decision.title}".`);
      }
      break;
  }

  if (eligibleWriteCandidates.length > 1) {
    skipped.push("deferred other write candidates after selecting one authored action for this heartbeat.");
  }
}
