import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  loadRuntimeConfig,
  type MoltbookRuntimeConfig
} from "./config.js";
import { appendHeartbeatRunHistory } from "./heartbeat-run-history.js";
import {
  createActionJob,
  type ActionJob,
  type ConstrainedActionCandidate
} from "./action-planning.js";
import {
  pickNextExecutableJob,
  requeueFailedActionJob,
  scheduleActionJobNotBefore,
  type ActionExecutionRecord
} from "./action-execution.js";
import {
  enqueueActionJobs as enqueueJobs,
  removeActionJob,
  summarizeActionJobs
} from "./job-queue.js";
import {
  chooseReplyTargetOrIgnore,
  chooseAndDraftWriteAction,
  isDuplicateDraftError,
  isMissingConcreteProofPointError,
  type GeneratedWriteDecision,
  type WriteCandidate
} from "./llm-content.js";
import {
  buildMoltbookActionCandidates,
  chooseMoltbookActionBundle,
  plannedActionFromCandidate
} from "./moltbook-action-planning.js";
import { MoltbookVenueProvider } from "./moltbook-venue.js";
import { MoltbookApiError, type MoltbookComment } from "./moltbook-api.js";
import {
  applyActionResult,
  canComment,
  createInitialState,
  contentFingerprint,
  type EngagementEventType,
  getDailyCommentBreakdown,
  getEngagementSummary,
  getCommentReadiness,
  getPostReadiness,
  isNewAgent,
  listReplyTargets,
  normalizeState,
  replyParentKey,
  selectFollowCandidatesFromComments,
  topLevelCommentParentKey,
  type EngagementSummary,
  type PendingWrite,
  type OutreachAgentState,
  type PlannedAction
} from "./policy.js";
import {
  loadStateFromStorage,
  saveHeartbeatRunToStorage,
  saveStateToStorage
} from "./storage.js";
import { saveOutreachRefToAttributionStore, readRefAttributionCounts } from "./attribution-store.js";
import { syncMoltbookAccountHealth } from "./moltbook-account-health.js";
import type { OutreachRef } from "./outreach-attribution.js";
import {
  readPromptRotationDebugSnapshot,
  recordPromptRotationAction
} from "./prompt-rotation.js";
import type { VenueAction, VenueOutcome } from "./venue.js";
import { assertMoltbookVenueProvider, createVenueProvider } from "./venue-factory.js";
export interface HeartbeatResult {
  summary: string;
  performed: string[];
  skipped: string[];
  plannedActions: PlannedAction["type"][];
}

export interface ExecutorResult {
  summary: string;
  performed: string[];
  skipped: string[];
}

interface HeartbeatErrorEntry {
  phase: string;
  message: string;
  name?: string;
}

interface HeartbeatAlert {
  severity: "warning" | "critical";
  message: string;
}

interface HeartbeatReport {
  runId: string;
  agentId?: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "ok" | "degraded" | "failed";
  summary?: string;
  dryRun: boolean;
  failureStreak: number;
  alerts: HeartbeatAlert[];
  plannedActions: PlannedAction["type"][];
  performed: string[];
  skipped: string[];
  errors: HeartbeatErrorEntry[];
  reconciledPendingWrites: Array<{
    id: string;
    type: PendingWrite["type"];
    status: "recovered" | "still_pending" | "reconcile_failed" | "expired";
  }>;
  writeCandidates: Array<{
    id: string;
    type: WriteCandidate["type"];
    reason: string;
    targetSummary?: string;
  }>;
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
    debugInputPath?: string;
  };
  queuedActionJobs: Array<{
    id: string;
    type: string;
    candidateId: string;
    status: ActionJob["status"];
    notBefore: string;
  }>;
  selectedWriteDecision?: GeneratedWriteDecision;
  engagementSummary?: EngagementSummary;
  promptRotation?: {
    statePath: string;
    auditPath: string;
    currentScopeKey?: string;
    currentScope?: {
      scopeKey: string;
      currentPromptVariant?: string;
      currentPromptLabel?: string;
      actionsSinceRotation: number;
      rotateAfterActions: number;
      lastRotationAt?: string;
      lastSelectionRationale?: string;
      lastSelectionSource?: string;
      lastSelectedAt?: string;
      lastActionAt?: string;
      lastPublishedAt?: string;
    };
    buckets: Array<{
      scopeKey: string;
      currentPromptVariant?: string;
      currentPromptLabel?: string;
      actionsSinceRotation: number;
      rotateAfterActions: number;
      lastRotationAt?: string;
      lastSelectionRationale?: string;
      lastSelectionSource?: string;
      lastSelectedAt?: string;
      lastActionAt?: string;
      lastPublishedAt?: string;
    }>;
    recentHistory: Array<{
      id: string;
      scopeKey?: string;
      status?: string;
      eventType?: string;
      promptVariantId?: string;
      promptVariantLabel?: string;
      selectionSource?: string;
      reusedExisting?: boolean;
      rotateAfterActions?: number;
      actionsSinceRotation?: number;
      selectionRationale?: string;
      createdAt: string;
      correlationId?: string;
      debugInputPath?: string;
    }>;
  };
}

interface QueuedWriteJobMetadata {
  kind: "queued_write";
  candidate: WriteCandidate;
  decision: GeneratedWriteDecision;
  successMessage: string;
  failureLabel: string;
  markNotificationsPostId?: string;
}

const PENDING_WRITE_MAX_RECONCILIATION_MISSES = 3;

async function loadState(
  statePath: string,
  heartbeatReportPath: string
): Promise<OutreachAgentState> {
  return await loadStateFromStorage(statePath, heartbeatReportPath);
}

function stateSidecarPaths(statePath: string) {
  const parsed = path.parse(statePath);
  return {
    previousPath: path.join(parsed.dir, `${parsed.name}.previous${parsed.ext}`),
    auditPath: path.join(parsed.dir, `${parsed.name}.audit.jsonl`)
  };
}

async function readOptionalUtf8(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeTextAtomic(filePath: string, contents: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tempPath, contents, "utf8");
  await rename(tempPath, filePath);
}

async function saveState(
  statePath: string,
  state: OutreachAgentState,
  runId?: string
): Promise<OutreachAgentState> {
  await mkdir(path.dirname(statePath), { recursive: true });
  const previousRaw = await readOptionalUtf8(statePath);
  const persistedState = await saveStateToStorage(statePath, state, runId);
  const nextRaw = JSON.stringify(persistedState, null, 2);
  const { previousPath, auditPath } = stateSidecarPaths(statePath);

  if (previousRaw !== undefined && previousRaw !== nextRaw) {
    await writeTextAtomic(previousPath, previousRaw);
  }

  await writeTextAtomic(statePath, nextRaw);

  const previousState =
    previousRaw === undefined ? undefined : (JSON.parse(previousRaw) as Partial<OutreachAgentState>);
  const auditEntry = {
    savedAt: new Date().toISOString(),
    path: statePath,
    previousEngagementTotals: previousState?.engagementTotals,
    nextEngagementTotals: persistedState.engagementTotals,
    previousDailyCounts:
      previousState === undefined
        ? undefined
        : {
            posts: previousState.dailyPostCount,
            comments: previousState.dailyCommentCount,
            topLevelComments: previousState.dailyTopLevelCommentCount,
            replies: previousState.dailyReplyCount
          },
    nextDailyCounts: {
      posts: persistedState.dailyPostCount,
      comments: persistedState.dailyCommentCount,
      topLevelComments: persistedState.dailyTopLevelCommentCount,
      replies: persistedState.dailyReplyCount
    },
    previousStateBytes: previousRaw ? Buffer.byteLength(previousRaw, "utf8") : 0,
    nextStateBytes: Buffer.byteLength(nextRaw, "utf8")
  };
  await appendFile(auditPath, `${JSON.stringify(auditEntry)}\n`, "utf8");
  return persistedState;
}

async function saveHeartbeatReport(
  statePath: string,
  heartbeatReportPath: string,
  report: HeartbeatReport
): Promise<void> {
  await saveHeartbeatRunToStorage(statePath, report);
  await mkdir(path.dirname(heartbeatReportPath), { recursive: true });
  await writeFile(heartbeatReportPath, JSON.stringify(report, null, 2), "utf8");
  await appendHeartbeatRunHistory(heartbeatReportPath, report);
}

async function readPreviousHeartbeatReport(heartbeatReportPath: string): Promise<Partial<HeartbeatReport> | undefined> {
  const raw = await readOptionalUtf8(heartbeatReportPath);
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as Partial<HeartbeatReport>;
  } catch {
    return undefined;
  }
}

function formatSummary(performed: string[], skipped: string[]): string {
  if (performed.length === 0 && skipped.length === 0) {
    return "HEARTBEAT_OK - Checked Moltbook, all good.";
  }

  const parts: string[] = [];
  if (performed.length > 0) {
    parts.push(performed.join(" "));
  }

  if (skipped.length > 0) {
    parts.push(`Skipped: ${skipped.join(" ")}`);
  }

  return parts.join(" ");
}

function formatExecutorSummary(performed: string[], skipped: string[]): string {
  if (performed.length === 0 && skipped.length === 0) {
    return "EXECUTOR_OK - No queued jobs were due.";
  }
  const parts: string[] = [];
  if (performed.length > 0) {
    parts.push(performed.join(" "));
  }
  if (skipped.length > 0) {
    parts.push(`Skipped: ${skipped.join(" ")}`);
  }
  return parts.join(" ");
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

export async function runHeartbeat(
  configInput?: MoltbookRuntimeConfig
): Promise<HeartbeatResult> {
  const config = configInput ?? (await loadRuntimeConfig({ requireVenue: true }));
  const venue = assertMoltbookVenueProvider(createVenueProvider(config));
  if (!config.apiKey) {
    throw new Error(
      "Missing Moltbook API key. Set MOLTBOOK_API_KEY or save credentials via the register command."
    );
  }
  const startedAt = new Date().toISOString();
  const runId = `${startedAt}:${process.pid}`;
  const previousReport = await readPreviousHeartbeatReport(config.heartbeatReportPath);
  const report: HeartbeatReport = {
    runId,
    agentId: config.agentId,
    startedAt,
    status: "running",
    dryRun: config.dryRun,
    failureStreak: 0,
    alerts: [],
    plannedActions: [],
    performed: [],
    skipped: [],
    errors: [],
    reconciledPendingWrites: [],
    writeCandidates: [],
    actionCandidates: [],
    queuedActionJobs: []
  };
  let state = createInitialState();

  try {
    const [sources, storedState] = await Promise.all([
      venue.loadHeartbeatSources(),
      loadState(config.statePath, config.heartbeatReportPath)
    ]);
    const { home, me, factSheet, followingFeed, hotFeed, exploreFeed } = sources;
    state = normalizeState(storedState);
    const persistState = async (nextState: OutreachAgentState): Promise<void> => {
      state = normalizeState({
        ...nextState,
        agentId: config.agentId ?? nextState.agentId
      });
      state = await saveState(config.statePath, state, runId);
    };
    const agentName = me.agent?.name ?? home.your_account.name;
    const accountHealth = await syncMoltbookAccountHealth({
      state,
      agentName,
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
    state = accountHealth.state;
    report.alerts.push(
      ...accountHealth.alerts.map((message) => ({
        severity: "warning" as const,
        message
      }))
    );
    if (accountHealth.changed) {
      await persistState(state);
    }
    state = await reconcilePendingWrites(
      venue,
      config,
      agentName,
      state,
      report,
      persistState
    );
    const performed: string[] = [];
    const skipped: string[] = [];
    const newAgent = isNewAgent(me.agent?.created_at, state);
    const actionCandidates = buildMoltbookActionCandidates({
      sources,
      state,
      config,
      policy: config.policy,
      now: new Date(startedAt),
      mode: venue.mode
    });
    report.actionCandidates = actionCandidates.map((candidate) => ({
      id: candidate.id,
      type: candidate.type,
      source: candidate.source,
      score: candidate.score,
      allowed: candidate.allowed,
      needsContent: candidate.needsContent,
      blockedBy: candidate.constraints.filter((constraint) => !constraint.passed).map((constraint) => constraint.id)
    }));
    const selectedBundle = await chooseMoltbookActionBundle({
      candidates: actionCandidates,
      config,
      sources,
      state,
      runId
    });
    report.selectedActionBundle = selectedBundle;
    const selectedIds = new Set(selectedBundle.selectedCandidateIds);
    const selectedCandidates = actionCandidates.filter((candidate) => selectedIds.has(candidate.id));
    const deferredWriteActions = actionCandidates
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
    report.plannedActions = planned.map((entry) => entry.type);
    const plannedActionTypes = new Set(report.plannedActions);
    const postBlockReason = describePostBlockReason(state, newAgent, config.policy);
    const selectedCommentLikeAction = planned.some(
      (entry) => entry.type === "reply_to_activity" || entry.type === "comment_on_post"
    );
    if (!selectedCommentLikeAction && !canComment(state, newAgent, config.policy)) {
      const highestBlockedCommentCandidate = actionCandidates
        .filter((candidate) => candidate.type === "reply_to_activity" || candidate.type === "comment_on_post")
        .sort((left, right) => right.score - left.score)[0];
      if (highestBlockedCommentCandidate?.title) {
        skipped.push(
          describeCommentBlockReason(state, newAgent, config.policy, highestBlockedCommentCandidate.title)
        );
      }
    }
    if (!plannedActionTypes.has("create_post") && postBlockReason) {
      skipped.push(postBlockReason);
    }
    const writeCandidates: WriteCandidate[] = [];
    let selectedWriteBlockedByConstraint = false;
    const followsAttempted = new Set<string>();
    const scheduledActionJobs: ActionJob[] = [];
    let queuedJobOrder = 0;
    const nextJobNotBefore = (actionType: VenueAction["type"], needsContent: boolean): string =>
      scheduleActionJobNotBefore({
        now: new Date(startedAt),
        actionType,
        order: queuedJobOrder++,
        needsContent,
        existingJobs: [...state.queuedActionJobs, ...scheduledActionJobs],
        records: moltbookExecutionRecords(state),
        config: config.actionExecution
      });
    const followBudget = Math.max(
      0,
      config.policy?.followMaxPerHeartbeat ?? 3
    );
    const plannedFollowCount = planned.filter((entry) => entry.type === "follow_agent").length;
    let commentFollowBudget = Math.max(0, followBudget - plannedFollowCount);

    const tryFollowAgent = (
      agentName: string,
      reason: string,
      sourceLabel: string
    ): boolean => {
      if (!agentName || followsAttempted.has(agentName) || state.followedAgentNames.includes(agentName)) {
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
            if (!canComment(state, newAgent, config.policy)) {
              selectedWriteBlockedByConstraint = true;
              skipped.push(
                describeCommentBlockReason(state, newAgent, config.policy, action.activity.post_title)
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
              state,
              agentName: home.your_account.name
            });

            if (commentFollowBudget > 0) {
              const followCandidates = selectFollowCandidatesFromComments({
                comments: comments.comments ?? [],
                state,
                agentName: home.your_account.name,
                policy: config.policy,
                alreadyQueued: followsAttempted,
                remainingBudget: commentFollowBudget
              });
              for (const candidate of followCandidates) {
                if (commentFollowBudget <= 0) {
                  break;
                }
                const followed = tryFollowAgent(
                  candidate.agentName,
                  candidate.reason,
                  "comment author"
                );
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
              state
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
            if (!canComment(state, newAgent, config.policy)) {
              selectedWriteBlockedByConstraint = true;
              skipped.push(
                describeCommentBlockReason(state, newAgent, config.policy, action.post.title)
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

    if (selectedWriteBlockedByConstraint && writeCandidates.length === 0) {
      for (const action of deferredWriteActions) {
        if (action.type === "comment_on_post") {
          if (!canComment(state, newAgent, config.policy)) {
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

    if (!config.dryRun && scheduledActionJobs.length > 0) {
      state = enqueueActionJobs(state, scheduledActionJobs);
      await persistState(state);
      report.queuedActionJobs = summarizeQueuedActionJobs(state);
    } else {
      report.queuedActionJobs = summarizeQueuedActionJobs(state);
    }

    const eligibleWriteCandidates =
      config.forceWriteMode === undefined
        ? writeCandidates
        : writeCandidates.filter((candidate) => candidate.type === config.forceWriteMode);
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

    if (eligibleWriteCandidates.length > 0) {
      let decision: GeneratedWriteDecision | undefined;
      try {
        decision = await chooseAndDraftWriteAction(
          config,
          eligibleWriteCandidates,
          factSheet,
          state
        );
      } catch (error) {
        if (isDuplicateDraftError(error)) {
          skipped.push("skipped authored write because the generated draft was too similar to recent authored history.");
        } else if (isMissingConcreteProofPointError(error)) {
          skipped.push("skipped authored write because the generated post still lacked a concrete proof point after retry.");
        } else {
          throw error;
        }
      }

      if (decision) {
        report.selectedWriteDecision = decision;
        const candidate = eligibleWriteCandidates.find(
          (entry) => entry.id === decision.selectedCandidateId
        );
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
              state = enqueueActionJobs(state, [
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
                  notBefore: nextJobNotBefore("reply_to_comment", true)
                })
              ]);
              await persistState(state);
              report.queuedActionJobs = summarizeQueuedActionJobs(state);
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
              state = enqueueActionJobs(state, [
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
                  notBefore: nextJobNotBefore("comment_on_post", true)
                })
              ]);
              await persistState(state);
              report.queuedActionJobs = summarizeQueuedActionJobs(state);
              performed.push(`Queued comment on "${candidate.post.title}".`);
            }
            break;
          }
          case "create_post":
            if (config.dryRun) {
              performed.push(`Would post "${decision.title ?? "Untitled post"}".`);
            } else {
              state = enqueueActionJobs(state, [
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
                  notBefore: nextJobNotBefore("create_post", true)
                })
              ]);
              await persistState(state);
              report.queuedActionJobs = summarizeQueuedActionJobs(state);
              performed.push(`Queued post "${decision.title}".`);
            }
            break;
        }

        if (eligibleWriteCandidates.length > 1) {
          skipped.push("deferred other write candidates after selecting one authored action for this heartbeat.");
        }
      }
    }

    state = normalizeState(
      {
        ...state,
        agentId: config.agentId ?? state.agentId,
        lastHeartbeatAt: new Date().toISOString()
      },
      new Date()
    );
    state = await saveState(config.statePath, state, runId);

    const result = {
      summary: formatSummary(performed, skipped),
      performed,
      skipped,
      plannedActions: planned.map((entry) => entry.type)
    };
    report.status = report.errors.length > 0 ? "degraded" : "ok";
    report.summary = result.summary;
    report.performed = result.performed;
    report.skipped = result.skipped;
    report.engagementSummary = getEngagementSummary(state);
    return result;
  } catch (error) {
    state = normalizeState(
      {
        ...state,
        agentId: config.agentId ?? state.agentId,
        lastHeartbeatAt: new Date().toISOString()
      },
      new Date()
    );
    state = await saveState(config.statePath, state, runId);
    report.status = "failed";
    report.errors.push(toHeartbeatError("heartbeat", error));
    report.summary = `HEARTBEAT_FAILED - ${formatErrorMessage(error)}`;
    report.engagementSummary = getEngagementSummary(state);
    throw error;
  } finally {
    finalizeHeartbeatAlerts(report, previousReport);
    report.promptRotation = await readPromptRotationDebugSnapshot(config).then((snapshot) => ({
      statePath: snapshot.statePath,
      auditPath: snapshot.auditPath,
      currentScopeKey: snapshot.currentScopeKey,
      currentScope: snapshot.currentScope,
      buckets: snapshot.buckets,
      recentHistory: snapshot.recentHistory.map((entry) => ({
        id: entry.id,
        scopeKey: entry.scopeKey,
        status: entry.status,
        eventType: entry.eventType,
        promptVariantId: entry.promptVariantId,
        promptVariantLabel: entry.promptVariantLabel,
        selectionSource: entry.selectionSource,
        reusedExisting: entry.reusedExisting,
        rotateAfterActions: entry.rotateAfterActions,
        actionsSinceRotation: entry.actionsSinceRotation,
        selectionRationale: entry.selectionRationale,
        createdAt: entry.createdAt,
        correlationId: entry.correlationId,
        debugInputPath: entry.debugInputPath
      }))
    })).catch(() => undefined);
    report.finishedAt = new Date().toISOString();
    await saveHeartbeatReport(config.statePath, config.heartbeatReportPath, report);
  }
}

export async function runExecutor(
  configInput?: MoltbookRuntimeConfig
): Promise<ExecutorResult> {
  const config = configInput ?? (await loadRuntimeConfig({ requireVenue: true }));
  const venue = assertMoltbookVenueProvider(createVenueProvider(config));
  if (!config.apiKey) {
    throw new Error(
      "Missing Moltbook API key. Set MOLTBOOK_API_KEY or save credentials via the register command."
    );
  }

  let state = createInitialState();
  const performed: string[] = [];
  const skipped: string[] = [];
  const report: HeartbeatReport = {
    runId: `executor:${new Date().toISOString()}:${process.pid}`,
    agentId: config.agentId,
    startedAt: new Date().toISOString(),
    status: "running",
    dryRun: config.dryRun,
    failureStreak: 0,
    alerts: [],
    plannedActions: [],
    performed: [],
    skipped: [],
    errors: [],
    reconciledPendingWrites: [],
    writeCandidates: [],
    actionCandidates: [],
    queuedActionJobs: []
  };

  const persistState = async (nextState: OutreachAgentState): Promise<void> => {
    state = normalizeState({
      ...nextState,
      agentId: config.agentId ?? nextState.agentId
    });
    state = await saveState(config.statePath, state);
  };

  try {
    state = normalizeState(await loadState(config.statePath, config.heartbeatReportPath));
    state = await executeDueActionJobs(
      venue,
      state,
      report,
      persistState,
      config,
      config.dryRun,
      performed,
      skipped
    );
    return {
      summary: formatExecutorSummary(performed, skipped),
      performed,
      skipped
    };
  } catch (error) {
    throw error;
  }
}

function finalizeHeartbeatAlerts(report: HeartbeatReport, previousReport: Partial<HeartbeatReport> | undefined): void {
  const previousStreak =
    previousReport?.status === "failed" || previousReport?.status === "degraded"
      ? Number(previousReport.failureStreak) || 1
      : 0;

  if (report.status === "failed") {
    report.failureStreak = previousStreak + 1;
    report.alerts.push({
      severity: report.failureStreak >= 2 ? "critical" : "warning",
      message: `Heartbeat failed; failure streak is ${report.failureStreak}.`
    });
    return;
  }

  if (report.status === "degraded") {
    report.failureStreak = previousStreak + 1;
    report.alerts.push({
      severity: report.failureStreak >= 3 ? "critical" : "warning",
      message: `Heartbeat completed with ${report.errors.length} error${report.errors.length === 1 ? "" : "s"}; failure streak is ${report.failureStreak}.`
    });
    return;
  }

  report.failureStreak = 0;
}

function toHeartbeatError(phase: string, error: unknown): HeartbeatErrorEntry {
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

function formatErrorMessage(error: unknown): string {
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

function enqueueActionJobs(state: OutreachAgentState, jobs: readonly ActionJob[]): OutreachAgentState {
  return normalizeState({
    ...state,
    queuedActionJobs: enqueueJobs(state.queuedActionJobs, jobs)
  });
}

function removeQueuedActionJob(state: OutreachAgentState, jobId: string): OutreachAgentState {
  return normalizeState({
    ...state,
    queuedActionJobs: removeActionJob(state.queuedActionJobs, jobId)
  });
}

function summarizeQueuedActionJobs(state: OutreachAgentState): HeartbeatReport["queuedActionJobs"] {
  return summarizeActionJobs(state.queuedActionJobs);
}

function getQueuedWriteJobMetadata(job: ActionJob): QueuedWriteJobMetadata | undefined {
  const raw = job.payload.raw;
  if (!raw || typeof raw !== "object" || !("kind" in raw)) {
    return undefined;
  }
  return raw.kind === "queued_write" ? (raw as QueuedWriteJobMetadata) : undefined;
}

function moltbookExecutionRecords(state: OutreachAgentState): ActionExecutionRecord[] {
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

async function executeDueActionJobs(
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
    report.queuedActionJobs = summarizeQueuedActionJobs(state);
    return state;
  }
  let nextState = state;
  for (const job of state.queuedActionJobs) {
    const writeMetadata = getQueuedWriteJobMetadata(job);
    if (job.status === "running" && writeMetadata) {
      if (!nextState.pendingWrites.some((entry) => entry.id === writeMetadata.candidate.id)) {
        nextState = removeQueuedActionJob(nextState, job.id);
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
    report.queuedActionJobs = summarizeQueuedActionJobs(nextState);
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
      nextState = removeQueuedActionJob(
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
    report.queuedActionJobs = summarizeQueuedActionJobs(nextState);
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
    nextState = removeQueuedActionJob(nextState, job.id);
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
  report.queuedActionJobs = summarizeQueuedActionJobs(nextState);
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

async function reconcilePendingWrites(
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

