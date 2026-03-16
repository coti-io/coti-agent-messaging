import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadRuntimeConfig, type MoltbookRuntimeConfig } from "./config.js";
import {
  chooseAndDraftWriteAction,
  type GeneratedWriteDecision,
  type WriteCandidate
} from "./llm-content.js";
import { MoltbookApiClient, MoltbookApiError, type MoltbookComment } from "./moltbook-api.js";
import { loadProductFacts } from "./product-facts.js";
import {
  applyActionResult,
  canComment,
  chooseReplyTarget,
  createInitialState,
  contentFingerprint,
  isNewAgent,
  normalizeState,
  planHeartbeatActions,
  type PendingWrite,
  type OutreachAgentState,
  type PlannedAction
} from "./policy.js";
export interface HeartbeatResult {
  summary: string;
  performed: string[];
  skipped: string[];
  plannedActions: PlannedAction["type"][];
}

interface HeartbeatErrorEntry {
  phase: string;
  message: string;
  name?: string;
}

interface HeartbeatReport {
  startedAt: string;
  finishedAt?: string;
  status: "running" | "ok" | "failed";
  summary?: string;
  dryRun: boolean;
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
  selectedWriteDecision?: GeneratedWriteDecision;
}

const PENDING_WRITE_MAX_RECONCILIATION_MISSES = 3;

async function loadState(statePath: string): Promise<OutreachAgentState> {
  try {
    const raw = await readFile(statePath, "utf8");
    return normalizeState(JSON.parse(raw) as Partial<OutreachAgentState>);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return createInitialState();
    }

    throw error;
  }
}

async function saveState(statePath: string, state: OutreachAgentState): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

async function saveHeartbeatReport(
  heartbeatReportPath: string,
  report: HeartbeatReport
): Promise<void> {
  await mkdir(path.dirname(heartbeatReportPath), { recursive: true });
  await writeFile(heartbeatReportPath, JSON.stringify(report, null, 2), "utf8");
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

export async function runHeartbeat(
  configInput?: MoltbookRuntimeConfig
): Promise<HeartbeatResult> {
  const config = configInput ?? (await loadRuntimeConfig({ requireApiKey: true }));
  const api = new MoltbookApiClient({
    baseUrl: config.moltbookBaseUrl,
    apiKey: config.apiKey,
    autoVerify: config.autoVerify,
    verificationLlm: config.verificationLlm ?? config.llm
  });
  const startedAt = new Date().toISOString();
  const report: HeartbeatReport = {
    startedAt,
    status: "running",
    dryRun: config.dryRun,
    plannedActions: [],
    performed: [],
    skipped: [],
    errors: [],
    reconciledPendingWrites: [],
    writeCandidates: []
  };
  let state = createInitialState();

  try {
    const [home, me, factSheet, storedState] = await Promise.all([
      api.getHome(),
      api.getMe(),
      loadProductFacts(config),
      loadState(config.statePath)
    ]);
    const exploreFeed = await api.getFeed({ sort: "new", limit: 10 });
    state = normalizeState(storedState);
    const persistState = async (nextState: OutreachAgentState): Promise<void> => {
      state = normalizeState(nextState);
      await saveState(config.statePath, state);
    };
    state = await reconcilePendingWrites(
      api,
      me.agent?.name ?? home.your_account.name,
      state,
      report,
      persistState
    );
    const newAgent = isNewAgent(me.agent?.created_at, state);
    const performed: string[] = [];
    const skipped: string[] = [];
    const planned = planHeartbeatActions({
      home,
      exploreFeed,
      state,
      factSheet,
      profileCreatedAt: me.agent?.created_at
    });
    report.plannedActions = planned.map((entry) => entry.type);
    const writeCandidates: WriteCandidate[] = [];

    for (const action of planned) {
      try {
        switch (action.type) {
          case "reply_to_activity": {
            if (!canComment(state, newAgent)) {
              skipped.push(`comment cooldown blocked a reply on "${action.activity.post_title}".`);
              break;
            }

            const comments = await api.getPostComments(action.activity.post_id, {
              sort: "new",
              limit: 35
            });
            const target = chooseReplyTarget({
              postId: action.activity.post_id,
              comments: comments.comments ?? [],
              state,
              agentName: home.your_account.name
            });

            if (!target) {
              skipped.push(`no unanswered comment found on "${action.activity.post_title}".`);
              if (!config.dryRun) {
                await api.markNotificationsReadByPost(action.activity.post_id);
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
              performed.push(`Would upvote "${action.post.title}".`);
              break;
            }

            await api.upvotePost(postId);
            state = applyActionResult(state, { type: "upvote_post", postId });
            performed.push(`Upvoted "${action.post.title}".`);
            break;
          }
          case "follow_agent":
            if (config.dryRun) {
              performed.push(`Would follow ${action.agentName}.`);
              break;
            }

            await api.followAgent(action.agentName);
            state = applyActionResult(state, { type: "follow_agent", agentName: action.agentName });
            performed.push(`Followed ${action.agentName}.`);
            break;
          case "comment_on_post": {
            if (!canComment(state, newAgent)) {
              skipped.push(`comment cooldown blocked a reply on "${action.post.title}".`);
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
      const decision = await chooseAndDraftWriteAction(
        config,
        eligibleWriteCandidates,
        factSheet,
        state
      );
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
            const pendingWrite = buildPendingWrite(candidate, decision);
            await persistState(addPendingWrite(state, pendingWrite));
            await api.createComment(candidate.postId, {
              content: decision.content,
              parent_id: candidate.target.commentId
            });
            await persistState(removePendingWrite(recoverPendingWrite(state, pendingWrite), pendingWrite.id));
            await api.markNotificationsReadByPost(candidate.postId);
            performed.push(
              `Replied to ${candidate.target.authorName ?? "a commenter"} on "${candidate.postTitle}".`
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
            const pendingWrite = buildPendingWrite(candidate, decision);
            await persistState(addPendingWrite(state, pendingWrite));
            await api.createComment(postId, { content: decision.content });
            await persistState(removePendingWrite(recoverPendingWrite(state, pendingWrite), pendingWrite.id));
            performed.push(`Commented on "${candidate.post.title}".`);
          }
          break;
        }
        case "create_post":
          if (config.dryRun) {
            performed.push(`Would post "${decision.title ?? "Untitled post"}".`);
          } else {
            const pendingWrite = buildPendingWrite(candidate, decision);
            await persistState(addPendingWrite(state, pendingWrite));
            await api.createPost({
              submolt_name: config.defaultSubmolt,
              title: decision.title!,
              content: decision.content
            });
            await persistState(removePendingWrite(recoverPendingWrite(state, pendingWrite), pendingWrite.id));
            performed.push(`Posted "${decision.title}".`);
          }
          break;
      }

      if (eligibleWriteCandidates.length > 1) {
        skipped.push("deferred other write candidates after selecting one authored action for this heartbeat.");
      }
    }

    state = normalizeState(
      {
        ...state,
        lastHeartbeatAt: new Date().toISOString()
      },
      new Date()
    );
    await saveState(config.statePath, state);

    const result = {
      summary: formatSummary(performed, skipped),
      performed,
      skipped,
      plannedActions: planned.map((entry) => entry.type)
    };
    report.status = "ok";
    report.summary = result.summary;
    report.performed = result.performed;
    report.skipped = result.skipped;
    return result;
  } catch (error) {
    await saveState(
      config.statePath,
      normalizeState(
        {
          ...state,
          lastHeartbeatAt: new Date().toISOString()
        },
        new Date()
      )
    );
    report.status = "failed";
    report.errors.push(toHeartbeatError("heartbeat", error));
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await saveHeartbeatReport(config.heartbeatReportPath, report);
  }
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
        createdAt
      };
  }
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
        content: pendingWrite.content
      });
    case "comment":
      return applyActionResult(state, {
        type: "comment",
        commentId: `post:${pendingWrite.postId ?? pendingWrite.id}`,
        content: pendingWrite.content,
        targetSummary: pendingWrite.targetSummary
      });
    case "reply":
      return applyActionResult(state, {
        type: "comment",
        commentId: pendingWrite.targetCommentId ?? pendingWrite.id,
        content: pendingWrite.content,
        targetSummary: pendingWrite.targetSummary,
        replyToAuthor: pendingWrite.replyToAuthor
      });
  }
}

async function reconcilePendingWrites(
  api: MoltbookApiClient,
  agentName: string | undefined,
  state: OutreachAgentState,
  report: HeartbeatReport,
  persistState: (state: OutreachAgentState) => Promise<void>
): Promise<OutreachAgentState> {
  if (!agentName || state.pendingWrites.length === 0) {
    return state;
  }

  try {
    const profile = await api.getAgentProfile(agentName);
    let nextState = state;
    let recoveredAny = false;
    let expiredAny = false;
    let updatedAny = false;
    for (const pendingWrite of state.pendingWrites) {
      const recovered = await matchesPendingWrite(api, profile, pendingWrite);
      if (recovered) {
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
  api: MoltbookApiClient,
  profile: Awaited<ReturnType<MoltbookApiClient["getAgentProfile"]>>,
  pendingWrite: PendingWrite
): Promise<boolean> {
  switch (pendingWrite.type) {
    case "post":
      return matchPendingPost(api, profile, pendingWrite);
    case "comment":
      return matchPendingComment(api, profile, pendingWrite);
    case "reply":
      return matchPendingReply(api, profile, pendingWrite);
  }
}

function shouldExpirePendingWrite(reconciliationMisses: number): boolean {
  return reconciliationMisses >= PENDING_WRITE_MAX_RECONCILIATION_MISSES;
}

async function matchPendingPost(
  api: MoltbookApiClient,
  profile: Awaited<ReturnType<MoltbookApiClient["getAgentProfile"]>>,
  pendingWrite: PendingWrite
): Promise<boolean> {
  const profileMatch = (profile.recentPosts ?? []).some((post) => {
    const remoteFingerprint = contentFingerprint(`${post.title ?? ""}\n${post.content ?? post.content_preview ?? ""}`);
    return remoteFingerprint === pendingWrite.fingerprint;
  });
  if (profileMatch) {
    return true;
  }

  const searchMatch = await searchForPendingWrite(api, pendingWrite);
  return searchMatch;
}

async function matchPendingComment(
  api: MoltbookApiClient,
  profile: Awaited<ReturnType<MoltbookApiClient["getAgentProfile"]>>,
  pendingWrite: PendingWrite
): Promise<boolean> {
  const profileMatch = (profile.recentComments ?? []).some((comment) =>
    matchesCommentFingerprint(comment, pendingWrite)
  );
  if (profileMatch) {
    return true;
  }

  const threadMatch = await matchPendingWriteInThread(api, pendingWrite);
  if (threadMatch) {
    return true;
  }

  return searchForPendingWrite(api, pendingWrite);
}

async function matchPendingReply(
  api: MoltbookApiClient,
  profile: Awaited<ReturnType<MoltbookApiClient["getAgentProfile"]>>,
  pendingWrite: PendingWrite
): Promise<boolean> {
  const profileMatch = (profile.recentComments ?? []).some((comment) =>
    matchesCommentFingerprint(comment, pendingWrite)
  );
  if (profileMatch) {
    return true;
  }

  const threadMatch = await matchPendingWriteInThread(api, pendingWrite);
  if (threadMatch) {
    return true;
  }

  return searchForPendingWrite(api, pendingWrite);
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
  api: MoltbookApiClient,
  pendingWrite: PendingWrite
): Promise<boolean> {
  if (!pendingWrite.postId) {
    return false;
  }

  const comments = await api.getPostComments(pendingWrite.postId, {
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
  api: MoltbookApiClient,
  pendingWrite: PendingWrite
): Promise<boolean> {
  const query = buildPendingWriteSearchQuery(pendingWrite);
  if (!query) {
    return false;
  }

  const response = await api.search({
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

