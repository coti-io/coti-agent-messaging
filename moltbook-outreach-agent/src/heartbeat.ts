import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadRuntimeConfig, type MoltbookRuntimeConfig } from "./config.js";
import {
  chooseAndDraftWriteAction,
  type GeneratedWriteDecision,
  type WriteCandidate
} from "./llm-content.js";
import { MoltbookApiClient, MoltbookApiError } from "./moltbook-api.js";
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
  writeCandidates: Array<{
    id: string;
    type: WriteCandidate["type"];
    reason: string;
    targetSummary?: string;
  }>;
  selectedWriteDecision?: GeneratedWriteDecision;
}

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
    writeCandidates: []
  };

  try {
    const [home, me, factSheet, storedState] = await Promise.all([
      api.getHome(),
      api.getMe(),
      loadProductFacts(config),
      loadState(config.statePath)
    ]);
    const exploreFeed = await api.getFeed({ sort: "new", limit: 10 });
    let state = normalizeState(storedState);
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

    report.writeCandidates = writeCandidates.map((candidate) => ({
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

    if (writeCandidates.length > 0) {
      const decision = await chooseAndDraftWriteAction(config, writeCandidates, factSheet, state);
      report.selectedWriteDecision = decision;
      const candidate = writeCandidates.find((entry) => entry.id === decision.selectedCandidateId);
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
            await api.createComment(candidate.postId, {
              content: decision.content,
              parent_id: candidate.target.commentId
            });
            await api.markNotificationsReadByPost(candidate.postId);
            state = applyActionResult(state, {
              type: "comment",
              commentId: candidate.target.commentId,
              content: decision.content,
              targetSummary: candidate.target.content,
              replyToAuthor: candidate.target.authorName
            });
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
            await api.createComment(postId, { content: decision.content });
            state = applyActionResult(state, {
              type: "comment",
              commentId: `post:${postId}`,
              content: decision.content,
              targetSummary: `${candidate.post.title} ${candidate.post.content_preview ?? ""}`.trim()
            });
            performed.push(`Commented on "${candidate.post.title}".`);
          }
          break;
        }
        case "create_post":
          if (config.dryRun) {
            performed.push(`Would post "${decision.title ?? "Untitled post"}".`);
          } else {
            await api.createPost({
              submolt_name: config.defaultSubmolt,
              title: decision.title!,
              content: decision.content
            });
            state = applyActionResult(state, {
              type: "create_post",
              fingerprint: decision.fingerprint || contentFingerprint(`${decision.title}\n${decision.content}`),
              title: decision.title!,
              content: decision.content
            });
            performed.push(`Posted "${decision.title}".`);
          }
          break;
      }

      if (writeCandidates.length > 1) {
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

