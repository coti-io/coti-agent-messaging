import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import type { MoltbookRuntimeConfig } from "../src/config.js";
import { runHeartbeat } from "../src/heartbeat.js";

test("heartbeat creates an outreach post, then replies usefully to later questions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "moltbook-heartbeat-"));
  const packageRoot = path.resolve(import.meta.dirname, "..", "..");
  const config: MoltbookRuntimeConfig = {
    packageRoot,
    projectRoot: path.resolve(packageRoot, ".."),
    credentialsPath: path.join(tempDir, "credentials.json"),
    statePath: path.join(tempDir, "state.json"),
    moltbookBaseUrl: "https://www.moltbook.com/api/v1",
    defaultSubmolt: "general",
    apiKey: "test-api-key",
    dryRun: false,
    autoVerify: false
  };

  let heartbeatCount = 0;
  let createdPost:
    | {
        id: string;
        title: string;
        content: string;
      }
    | undefined;
  let createdReply:
    | {
        postId: string;
        parentId?: string;
        content: string;
      }
    | undefined;
  let notificationsMarkedForPost: string | undefined;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (url.pathname === "/api/v1/home" && method === "GET") {
      heartbeatCount += 1;

      return jsonResponse(
        heartbeatCount === 1
          ? {
              your_account: { name: "OutreachBot" },
              activity_on_your_posts: [],
              your_direct_messages: { pending_request_count: 0, unread_message_count: 0 },
              posts_from_accounts_you_follow: { posts: [] }
            }
          : {
              your_account: { name: "OutreachBot" },
              activity_on_your_posts: [
                {
                  post_id: createdPost?.id ?? "created-post-1",
                  post_title: createdPost?.title ?? "Created post",
                  new_notification_count: 3
                }
              ],
              your_direct_messages: { pending_request_count: 0, unread_message_count: 0 },
              posts_from_accounts_you_follow: { posts: [] }
            }
      );
    }

    if (url.pathname === "/api/v1/agents/me" && method === "GET") {
      return jsonResponse({
        success: true,
        agent: {
          name: "OutreachBot",
          created_at: "2026-03-10T08:00:00.000Z"
        }
      });
    }

    if (url.pathname === "/api/v1/feed" && method === "GET") {
      return jsonResponse({
        success: true,
        posts: []
      });
    }

    if (
      url.pathname === `/api/v1/posts/${createdPost?.id ?? "created-post-1"}/comments` &&
      method === "GET"
    ) {
      return jsonResponse({
        success: true,
        comments: [
          {
            id: "comment-older",
            content: "Privacy matters, but how do you route messages without exposing the body?",
            author_name: "PrivacyBot",
            created_at: "2026-03-12T10:00:00.000Z"
          },
          {
            id: "comment-self",
            content: "Our own comment should never be selected as a reply target.",
            author_name: "OutreachBot",
            created_at: "2026-03-12T10:30:00.000Z"
          },
          {
            id: "comment-newest",
            content: "Interesting. How would another agent integrate this through MCP or the SDK?",
            author_name: "BuilderBot",
            created_at: "2026-03-12T11:00:00.000Z"
          }
        ]
      });
    }

    if (url.pathname === "/api/v1/posts" && method === "POST") {
      createdPost = {
        id: "created-post-1",
        title: body.title,
        content: body.content
      };

      return jsonResponse({
        success: true,
        post: {
          id: createdPost.id,
          post_id: createdPost.id,
          title: createdPost.title,
          content: createdPost.content
        }
      });
    }

    if (
      url.pathname === `/api/v1/posts/${createdPost?.id ?? "created-post-1"}/comments` &&
      method === "POST"
    ) {
      createdReply = {
        postId: createdPost?.id ?? "created-post-1",
        parentId: body.parent_id,
        content: body.content
      };

      return jsonResponse({
        success: true,
        comment: {
          id: "reply-1",
          post_id: createdReply.postId,
          parent_id: createdReply.parentId,
          content: createdReply.content
        }
      });
    }

    if (
      url.pathname === `/api/v1/notifications/read-by-post/${createdPost?.id ?? "created-post-1"}` &&
      method === "POST"
    ) {
      notificationsMarkedForPost = createdPost?.id ?? "created-post-1";
      return jsonResponse({ success: true });
    }

    throw new Error(`Unhandled fetch: ${method} ${url.pathname}`);
  };

  try {
    const firstHeartbeat = await runHeartbeat(config);
    assert.equal(createdPost?.id, "created-post-1");
    assert.match(createdPost?.title ?? "", /plaintext|private|inbox|agent/i);
    assert.match(createdPost?.content ?? "", /encrypted|private/i);
    assert.equal(firstHeartbeat.plannedActions.includes("create_post"), true);

    const secondHeartbeat = await runHeartbeat(config);
    assert.equal(createdReply?.postId, "created-post-1");
    assert.equal(createdReply?.parentId, "comment-newest");
    assert.match(createdReply?.content ?? "", /^BuilderBot,/);
    assert.match(createdReply?.content ?? "", /MCP-compatible tool surface/i);
    assert.match(createdReply?.content ?? "", /SDK helpers/i);
    assert.equal(secondHeartbeat.plannedActions[0], "reply_to_activity");
    assert.equal(notificationsMarkedForPost, "created-post-1");

    const savedState = JSON.parse(await readFile(config.statePath, "utf8")) as {
      repliedCommentIds?: string[];
      createdPostFingerprints?: string[];
    };
    assert.deepEqual(savedState.repliedCommentIds?.includes("comment-newest"), true);
    assert.equal((savedState.createdPostFingerprints?.length ?? 0) > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
