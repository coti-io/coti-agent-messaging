import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadRuntimeConfig, type MoltbookRuntimeConfig } from "./config.js";
import { draftCommentOnPost, draftOutreachPost, draftReplyToComment } from "./content.js";
import { MoltbookApiClient, MoltbookApiError } from "./moltbook-api.js";
import { loadProductFacts } from "./product-facts.js";
import {
  applyActionResult,
  canComment,
  chooseReplyTarget,
  createInitialState,
  isNewAgent,
  normalizeState,
  planHeartbeatActions,
  templateFingerprint,
  type OutreachAgentState,
  type PlannedAction
} from "./policy.js";

export interface HeartbeatResult {
  summary: string;
  performed: string[];
  skipped: string[];
  plannedActions: PlannedAction["type"][];
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
    autoVerify: config.autoVerify
  });

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

          const reply = draftReplyToComment(target, factSheet);
          if (config.dryRun) {
            performed.push(
              `Would reply to ${target.authorName ?? "a commenter"} on "${action.activity.post_title}".`
            );
            break;
          }

          await api.createComment(action.activity.post_id, {
            content: reply,
            parent_id: target.commentId
          });
          await api.markNotificationsReadByPost(action.activity.post_id);
          state = applyActionResult(state, { type: "comment", commentId: target.commentId });
          performed.push(
            `Replied to ${target.authorName ?? "a commenter"} on "${action.activity.post_title}".`
          );
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

          const comment = draftCommentOnPost(action.post, factSheet);
          const postId = action.post.post_id ?? action.post.id;
          if (!postId) {
            skipped.push(`could not comment on "${action.post.title}" because the post id was missing.`);
            break;
          }

          if (config.dryRun) {
            performed.push(`Would comment on "${action.post.title}".`);
            break;
          }

          await api.createComment(postId, { content: comment });
          state = applyActionResult(state, { type: "comment", commentId: `post:${postId}` });
          performed.push(`Commented on "${action.post.title}".`);
          break;
        }
        case "create_post": {
          const draft = draftOutreachPost(action.templateId, factSheet);
          if (config.dryRun) {
            performed.push(`Would post "${draft.title}".`);
            break;
          }

          await api.createPost({
            submolt_name: config.defaultSubmolt,
            title: draft.title,
            content: draft.content
          });
          state = applyActionResult(state, {
            type: "create_post",
            fingerprint: templateFingerprint(action.templateId)
          });
          performed.push(`Posted "${draft.title}".`);
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

      throw error;
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

  return {
    summary: formatSummary(performed, skipped),
    performed,
    skipped,
    plannedActions: planned.map((entry) => entry.type)
  };
}

