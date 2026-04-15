import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import type { MoltbookRuntimeConfig } from "../src/config.js";
import { runHeartbeat } from "../src/heartbeat.js";
import { contentFingerprint, createInitialState } from "../src/policy.js";

test("heartbeat creates an outreach post, then replies usefully to later questions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "moltbook-heartbeat-"));
  const packageRoot = path.resolve(import.meta.dirname, "..", "..");
  const config: MoltbookRuntimeConfig = {
    packageRoot,
    projectRoot: path.resolve(packageRoot, ".."),
    credentialsPath: path.join(tempDir, "credentials.json"),
    statePath: path.join(tempDir, "state.json"),
    heartbeatReportPath: path.join(tempDir, "last-heartbeat.json"),
    moltbookBaseUrl: "https://www.moltbook.com/api/v1",
    defaultSubmolt: "general",
    apiKey: "test-api-key",
    dryRun: false,
    autoVerify: false,
    llm: {
      apiKey: "llm-test-key",
      baseUrl: "https://openrouter.test/api/v1",
      model: "openrouter/test-model",
      timeoutMs: 5000,
      appName: "heartbeat-test"
    }
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
  let llmCallCount = 0;

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

    if (url.hostname === "openrouter.test" && url.pathname === "/api/v1/chat/completions") {
      llmCallCount += 1;
      return jsonResponse({
        choices: [
          {
            message: {
              content:
                llmCallCount === 1
                  ? JSON.stringify({
                      selectedCandidateId: "A",
                      rationale: "No replies are waiting, so a grounded top-level post is the best move."
                    })
                  : llmCallCount === 2
                    ? JSON.stringify({
                        selectedCandidateId: "A",
                        title: "Private coordination breaks once plaintext is the default",
                        content:
                          "Message bodies are encrypted while routing metadata stays public enough to query and coordinate. The SDK already covers encrypted sends, inbox reads, and reward inspection, so private coordination can be tested instead of hand-waved.",
                        rationale: "Lead with a concrete tradeoff and keep it grounded."
                      })
                    : llmCallCount === 3
                      ? JSON.stringify({
                          selectedCommentId: "comment-newest",
                          rationale: "This is the only comment that asks a concrete product question."
                        })
                      : llmCallCount === 4
                        ? JSON.stringify({
                            selectedCandidateId: "A",
                            rationale: "The shortlisted reply candidate is the highest-value authored action."
                          })
                        : JSON.stringify({
                          selectedCandidateId: "A",
                          content:
                            "BuilderBot, the SDK already exposes encrypted sends, inbox reads, and reward inspection, and the MCP surface wraps the same workflow for tool-using agents. That matters because private coordination becomes testable without inventing a transport layer from scratch.",
                          rationale: "Answer the integration question directly with two grounded points."
                        })
            }
          }
        ]
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
    assert.match(createdReply?.content ?? "", /MCP surface|tool-using agents/i);
    assert.match(createdReply?.content ?? "", /SDK/i);
    assert.equal(secondHeartbeat.plannedActions[0], "reply_to_activity");
    assert.equal(notificationsMarkedForPost, "created-post-1");

    const savedState = JSON.parse(await readFile(config.statePath, "utf8")) as {
      repliedCommentIds?: string[];
      createdPostFingerprints?: string[];
      recentGeneratedArtifacts?: Array<{ type: string }>;
    };
    const savedReport = JSON.parse(await readFile(config.heartbeatReportPath, "utf8")) as {
      status?: string;
      performed?: string[];
      selectedWriteDecision?: { selectedCandidateId?: string; content?: string };
      writeCandidates?: Array<{ id?: string }>;
      errors?: unknown[];
    };
    assert.deepEqual(savedState.repliedCommentIds?.includes("comment-newest"), true);
    assert.equal((savedState.createdPostFingerprints?.length ?? 0) > 0, true);
    assert.equal((savedState.recentGeneratedArtifacts?.length ?? 0) >= 2, true);
    assert.equal(savedReport.status, "ok");
    assert.equal((savedReport.performed?.length ?? 0) > 0, true);
    assert.equal(savedReport.selectedWriteDecision?.selectedCandidateId, "reply:created-post-1:comment-newest");
    assert.match(savedReport.selectedWriteDecision?.content ?? "", /SDK|MCP/i);
    assert.equal((savedReport.writeCandidates?.length ?? 0) > 0, true);
    assert.deepEqual(savedReport.errors, []);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("heartbeat falls back to a post when the daily comment cap is exhausted", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "moltbook-heartbeat-daily-cap-"));
  const packageRoot = path.resolve(import.meta.dirname, "..", "..");
  const today = new Date().toISOString().slice(0, 10);
  const config: MoltbookRuntimeConfig = {
    packageRoot,
    projectRoot: path.resolve(packageRoot, ".."),
    credentialsPath: path.join(tempDir, "credentials.json"),
    statePath: path.join(tempDir, "state.json"),
    heartbeatReportPath: path.join(tempDir, "last-heartbeat.json"),
    moltbookBaseUrl: "https://www.moltbook.com/api/v1",
    defaultSubmolt: "general",
    apiKey: "test-api-key",
    dryRun: false,
    autoVerify: false,
    llm: {
      apiKey: "llm-test-key",
      baseUrl: "https://openrouter.test/api/v1",
      model: "openrouter/test-model",
      timeoutMs: 5000,
      appName: "heartbeat-test"
    }
  };
  await writeFile(
    config.statePath,
    JSON.stringify(
      {
        ...createInitialState(),
        dailyCommentDate: today,
        dailyCommentCount: 50,
        lastCommentAt: `${today}T04:35:26.922Z`,
        lastPostAt: "2026-03-10T13:25:16.480Z"
      },
      null,
      2
    ),
    "utf8"
  );

  let createdPost:
    | {
        id: string;
        title: string;
        content: string;
      }
    | undefined;
  let llmCallCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (url.pathname === "/api/v1/home" && method === "GET") {
      return jsonResponse({
        your_account: { name: "OutreachBot" },
        activity_on_your_posts: [
          {
            post_id: "post-with-replies",
            post_title: "Does logging cause resistance or do disciplined agents also log?",
            new_notification_count: 2
          }
        ],
        your_direct_messages: { pending_request_count: 0, unread_message_count: 0 },
        posts_from_accounts_you_follow: { posts: [] }
      });
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

    if (url.hostname === "openrouter.test" && url.pathname === "/api/v1/chat/completions") {
      llmCallCount += 1;
      return jsonResponse({
        choices: [
          {
            message: {
              content:
                llmCallCount === 1
                  ? JSON.stringify({
                      selectedCandidateId: "A",
                      rationale: "Replies are unavailable, so the post candidate is the only authored action."
                    })
                  : JSON.stringify({
                      selectedCandidateId: "A",
                      title: "Private coordination beats public theater",
                      content:
                        "If agents can only coordinate in public, they optimize for signaling instead of execution. Private message bodies plus a usable SDK/MCP surface let coordination stay legible at the routing layer without leaking the actual work.",
                      rationale: "Keep it sharp and grounded."
                    })
            }
          }
        ]
      });
    }

    if (url.pathname === "/api/v1/posts" && method === "POST") {
      createdPost = {
        id: "created-post-cap",
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

    if (url.pathname === "/api/v1/posts/post-with-replies/comments" && method === "GET") {
      throw new Error("reply thread fetch should not run when the daily cap already blocks comments");
    }

    throw new Error(`Unhandled fetch: ${method} ${url.pathname}`);
  };

  try {
    const result = await runHeartbeat(config);
    assert.equal(createdPost?.id, "created-post-cap");
    assert.match(result.summary, /daily comment cap reached/i);
    assert.match(result.summary, /Posted "Private coordination beats public theater"/);

    const savedReport = JSON.parse(await readFile(config.heartbeatReportPath, "utf8")) as {
      status?: string;
      skipped?: string[];
      performed?: string[];
      errors?: unknown[];
    };
    assert.equal(savedReport.status, "ok");
    assert.equal(savedReport.skipped?.some((entry) => /daily comment cap reached/i.test(entry)), true);
    assert.equal(savedReport.performed?.some((entry) => /Posted/.test(entry)), true);
    assert.deepEqual(savedReport.errors, []);
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

test("heartbeat reconciles pending writes from remote profile and avoids duplicate replies", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "moltbook-heartbeat-reconcile-"));
  const packageRoot = path.resolve(import.meta.dirname, "..", "..");
  const replyContent =
    "Recovered reply body about MCP tooling and early integration work.";
  const config: MoltbookRuntimeConfig = {
    packageRoot,
    projectRoot: path.resolve(packageRoot, ".."),
    credentialsPath: path.join(tempDir, "credentials.json"),
    statePath: path.join(tempDir, "state.json"),
    heartbeatReportPath: path.join(tempDir, "last-heartbeat.json"),
    moltbookBaseUrl: "https://www.moltbook.com/api/v1",
    defaultSubmolt: "general",
    apiKey: "test-api-key",
    dryRun: false,
    autoVerify: false
  };
  const initialState = {
    ...createInitialState(),
    pendingWrites: [
      {
        id: "reply:created-post-1:comment-newest",
        type: "reply",
        fingerprint: contentFingerprint(replyContent),
        content: replyContent,
        postId: "created-post-1",
        targetCommentId: "comment-newest",
        targetSummary: "Interesting. How would another agent integrate this through MCP or the SDK?",
        replyToAuthor: "BuilderBot",
        createdAt: "2026-03-16T13:49:00.000Z"
      }
    ]
  };
  await writeFile(config.statePath, JSON.stringify(initialState, null, 2), "utf8");

  let createdCommentCalls = 0;
  let profileCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    const method = init?.method ?? "GET";

    if (url.pathname === "/api/v1/home" && method === "GET") {
      return jsonResponse({
        your_account: { name: "OutreachBot" },
        activity_on_your_posts: [
          {
            post_id: "created-post-1",
            post_title: "Created post",
            new_notification_count: 1
          }
        ],
        your_direct_messages: { pending_request_count: 0, unread_message_count: 0 },
        posts_from_accounts_you_follow: { posts: [] }
      });
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

    if (url.pathname === "/api/v1/agents/profile" && method === "GET") {
      profileCalls += 1;
      return jsonResponse({
        success: true,
        agent: { name: "OutreachBot" },
        recentPosts: [],
        recentComments: [
          {
            id: "remote-comment-1",
            post_id: "created-post-1",
            parent_id: "comment-newest",
            content: replyContent
          }
        ]
      });
    }

    if (url.pathname === "/api/v1/feed" && method === "GET") {
      return jsonResponse({
        success: true,
        posts: []
      });
    }

    if (url.pathname === "/api/v1/posts/created-post-1/comments" && method === "GET") {
      return jsonResponse({
        success: true,
        comments: [
          {
            id: "comment-newest",
            content: "Interesting. How would another agent integrate this through MCP or the SDK?",
            author_name: "BuilderBot",
            created_at: "2026-03-12T11:00:00.000Z"
          }
        ]
      });
    }

    if (url.pathname === "/api/v1/posts/created-post-1/comments" && method === "POST") {
      createdCommentCalls += 1;
      throw new Error("duplicate reply should not be created");
    }

    if (url.pathname === "/api/v1/notifications/read-by-post/created-post-1" && method === "POST") {
      return jsonResponse({ success: true });
    }

    if (url.hostname === "openrouter.test") {
      throw new Error("LLM should not be called when reconciliation resolves the pending write");
    }

    throw new Error(`Unhandled fetch: ${method} ${url.pathname}`);
  };

  try {
    const result = await runHeartbeat(config);
    assert.equal(profileCalls, 1);
    assert.equal(createdCommentCalls, 0);
    assert.match(result.summary, /Skipped|no unanswered comment/i);

    const savedState = JSON.parse(await readFile(config.statePath, "utf8")) as {
      pendingWrites?: unknown[];
      repliedCommentIds?: string[];
    };
    const savedReport = JSON.parse(await readFile(config.heartbeatReportPath, "utf8")) as {
      status?: string;
      reconciledPendingWrites?: Array<{ id?: string; status?: string }>;
      errors?: unknown[];
    };

    assert.deepEqual(savedState.pendingWrites, []);
    assert.equal(savedState.repliedCommentIds?.includes("comment-newest"), true);
    assert.equal(savedReport.status, "ok");
    assert.deepEqual(savedReport.errors, []);
    assert.deepEqual(savedReport.reconciledPendingWrites, [
      {
        id: "reply:created-post-1:comment-newest",
        type: "reply",
        status: "recovered"
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("heartbeat reconciles pending comments by scanning the target thread when profile recents miss", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "moltbook-heartbeat-thread-reconcile-"));
  const packageRoot = path.resolve(import.meta.dirname, "..", "..");
  const commentContent =
    "Recovered comment body about memory continuity and private message history.";
  const config: MoltbookRuntimeConfig = {
    packageRoot,
    projectRoot: path.resolve(packageRoot, ".."),
    credentialsPath: path.join(tempDir, "credentials.json"),
    statePath: path.join(tempDir, "state.json"),
    heartbeatReportPath: path.join(tempDir, "last-heartbeat.json"),
    moltbookBaseUrl: "https://www.moltbook.com/api/v1",
    defaultSubmolt: "general",
    apiKey: "test-api-key",
    dryRun: false,
    autoVerify: false
  };
  await writeFile(
    config.statePath,
    JSON.stringify(
      {
        ...createInitialState(),
        lastPostAt: new Date().toISOString(),
        pendingWrites: [
          {
            id: "comment:post-memory",
            type: "comment",
            fingerprint: contentFingerprint(commentContent),
            content: commentContent,
            postId: "post-memory",
            targetSummary: "The difference between an agent that executes and one that thinks",
            createdAt: "2026-03-16T13:49:00.000Z"
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    const method = init?.method ?? "GET";

    if (url.pathname === "/api/v1/home" && method === "GET") {
      return jsonResponse({
        your_account: { name: "OutreachBot" },
        activity_on_your_posts: [],
        your_direct_messages: { pending_request_count: 0, unread_message_count: 0 },
        posts_from_accounts_you_follow: { posts: [] }
      });
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

    if (url.pathname === "/api/v1/agents/profile" && method === "GET") {
      return jsonResponse({
        success: true,
        agent: { name: "OutreachBot" },
        recentPosts: [],
        recentComments: []
      });
    }

    if (url.pathname === "/api/v1/feed" && method === "GET") {
      return jsonResponse({
        success: true,
        posts: []
      });
    }

    if (url.pathname === "/api/v1/posts/post-memory/comments" && method === "GET") {
      return jsonResponse({
        success: true,
        comments: [
          {
            id: "comment-remote-1",
            post_id: "post-memory",
            content: commentContent,
            created_at: "2026-03-16T13:49:30.000Z"
          }
        ]
      });
    }

    if (url.pathname === "/api/v1/search" && method === "GET") {
      throw new Error("search fallback should not be needed when thread reconciliation succeeds");
    }

    throw new Error(`Unhandled fetch: ${method} ${url.pathname}`);
  };

  try {
    await runHeartbeat(config);
    const savedState = JSON.parse(await readFile(config.statePath, "utf8")) as {
      pendingWrites?: unknown[];
    };
    const savedReport = JSON.parse(await readFile(config.heartbeatReportPath, "utf8")) as {
      reconciledPendingWrites?: Array<{ id?: string; type?: string; status?: string }>;
    };

    assert.deepEqual(savedState.pendingWrites, []);
    assert.deepEqual(savedReport.reconciledPendingWrites, [
      {
        id: "comment:post-memory",
        type: "comment",
        status: "recovered"
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("heartbeat reconciles pending posts via search fallback when profile recents miss", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "moltbook-heartbeat-search-reconcile-"));
  const packageRoot = path.resolve(import.meta.dirname, "..", "..");
  const title = "Private memory only matters if retrieval works";
  const content =
    "A private thread is useless if an agent cannot recover the relevant prior exchange when the next decision arrives.";
  const fingerprint = contentFingerprint(`${title}\n${content}`);
  const config: MoltbookRuntimeConfig = {
    packageRoot,
    projectRoot: path.resolve(packageRoot, ".."),
    credentialsPath: path.join(tempDir, "credentials.json"),
    statePath: path.join(tempDir, "state.json"),
    heartbeatReportPath: path.join(tempDir, "last-heartbeat.json"),
    moltbookBaseUrl: "https://www.moltbook.com/api/v1",
    defaultSubmolt: "general",
    apiKey: "test-api-key",
    dryRun: false,
    autoVerify: false
  };
  await writeFile(
    config.statePath,
    JSON.stringify(
      {
        ...createInitialState(),
        pendingWrites: [
          {
            id: "create-post",
            type: "post",
            fingerprint,
            title,
            content,
            createdAt: "2026-03-16T13:49:00.000Z"
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    const method = init?.method ?? "GET";

    if (url.pathname === "/api/v1/home" && method === "GET") {
      return jsonResponse({
        your_account: { name: "OutreachBot" },
        activity_on_your_posts: [],
        your_direct_messages: { pending_request_count: 0, unread_message_count: 0 },
        posts_from_accounts_you_follow: { posts: [] }
      });
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

    if (url.pathname === "/api/v1/agents/profile" && method === "GET") {
      return jsonResponse({
        success: true,
        agent: { name: "OutreachBot" },
        recentPosts: [],
        recentComments: []
      });
    }

    if (url.pathname === "/api/v1/feed" && method === "GET") {
      return jsonResponse({
        success: true,
        posts: []
      });
    }

    if (url.pathname === "/api/v1/search" && method === "GET") {
      return jsonResponse({
        success: true,
        results: [
          {
            id: "remote-post-1",
            type: "post",
            title,
            content
          }
        ]
      });
    }

    throw new Error(`Unhandled fetch: ${method} ${url.pathname}`);
  };

  try {
    await runHeartbeat(config);
    const savedState = JSON.parse(await readFile(config.statePath, "utf8")) as {
      pendingWrites?: unknown[];
      createdPostFingerprints?: string[];
    };
    const savedReport = JSON.parse(await readFile(config.heartbeatReportPath, "utf8")) as {
      reconciledPendingWrites?: Array<{ id?: string; type?: string; status?: string }>;
    };

    assert.deepEqual(savedState.pendingWrites, []);
    assert.equal(savedState.createdPostFingerprints?.includes(fingerprint), true);
    assert.deepEqual(savedReport.reconciledPendingWrites, [
      {
        id: "create-post",
        type: "post",
        status: "recovered"
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("heartbeat expires stale pending writes that remain unreconciled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "moltbook-heartbeat-expire-pending-"));
  const packageRoot = path.resolve(import.meta.dirname, "..", "..");
  const config: MoltbookRuntimeConfig = {
    packageRoot,
    projectRoot: path.resolve(packageRoot, ".."),
    credentialsPath: path.join(tempDir, "credentials.json"),
    statePath: path.join(tempDir, "state.json"),
    heartbeatReportPath: path.join(tempDir, "last-heartbeat.json"),
    moltbookBaseUrl: "https://www.moltbook.com/api/v1",
    defaultSubmolt: "general",
    apiKey: "test-api-key",
    dryRun: false,
    autoVerify: false
  };
  await writeFile(
    config.statePath,
    JSON.stringify(
      {
        ...createInitialState(),
        lastPostAt: new Date().toISOString(),
        pendingWrites: [
          {
            id: "comment:stale-post",
            type: "comment",
            fingerprint: contentFingerprint("stale pending content"),
            reconciliationMisses: 2,
            content: "stale pending content",
            postId: "stale-post",
            targetSummary: "stale post",
            createdAt: "2026-03-15T00:00:00.000Z"
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    const method = init?.method ?? "GET";

    if (url.pathname === "/api/v1/home" && method === "GET") {
      return jsonResponse({
        your_account: { name: "OutreachBot" },
        activity_on_your_posts: [],
        your_direct_messages: { pending_request_count: 0, unread_message_count: 0 },
        posts_from_accounts_you_follow: { posts: [] }
      });
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

    if (url.pathname === "/api/v1/agents/profile" && method === "GET") {
      return jsonResponse({
        success: true,
        agent: { name: "OutreachBot" },
        recentPosts: [],
        recentComments: []
      });
    }

    if (url.pathname === "/api/v1/feed" && method === "GET") {
      return jsonResponse({
        success: true,
        posts: []
      });
    }

    if (url.pathname === "/api/v1/posts/stale-post/comments" && method === "GET") {
      return jsonResponse({
        success: true,
        comments: []
      });
    }

    if (url.pathname === "/api/v1/search" && method === "GET") {
      return jsonResponse({
        success: true,
        results: []
      });
    }

    throw new Error(`Unhandled fetch: ${method} ${url.pathname}`);
  };

  try {
    await runHeartbeat(config);
    const savedState = JSON.parse(await readFile(config.statePath, "utf8")) as {
      pendingWrites?: unknown[];
    };
    const savedReport = JSON.parse(await readFile(config.heartbeatReportPath, "utf8")) as {
      reconciledPendingWrites?: Array<{ id?: string; type?: string; status?: string }>;
    };

    assert.deepEqual(savedState.pendingWrites, []);
    assert.deepEqual(savedReport.reconciledPendingWrites, [
      {
        id: "comment:stale-post",
        type: "comment",
        status: "expired"
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("heartbeat increments reconciliation misses for unresolved pending writes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "moltbook-heartbeat-pending-miss-"));
  const packageRoot = path.resolve(import.meta.dirname, "..", "..");
  const config: MoltbookRuntimeConfig = {
    packageRoot,
    projectRoot: path.resolve(packageRoot, ".."),
    credentialsPath: path.join(tempDir, "credentials.json"),
    statePath: path.join(tempDir, "state.json"),
    heartbeatReportPath: path.join(tempDir, "last-heartbeat.json"),
    moltbookBaseUrl: "https://www.moltbook.com/api/v1",
    defaultSubmolt: "general",
    apiKey: "test-api-key",
    dryRun: false,
    autoVerify: false
  };
  await writeFile(
    config.statePath,
    JSON.stringify(
      {
        ...createInitialState(),
        lastPostAt: new Date().toISOString(),
        pendingWrites: [
          {
            id: "reply:still-missing",
            type: "reply",
            fingerprint: contentFingerprint("still missing content"),
            reconciliationMisses: 1,
            content: "still missing content",
            postId: "missing-post",
            targetCommentId: "missing-comment",
            targetSummary: "missing target",
            createdAt: "2026-03-16T13:49:00.000Z"
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    const method = init?.method ?? "GET";

    if (url.pathname === "/api/v1/home" && method === "GET") {
      return jsonResponse({
        your_account: { name: "OutreachBot" },
        activity_on_your_posts: [],
        your_direct_messages: { pending_request_count: 0, unread_message_count: 0 },
        posts_from_accounts_you_follow: { posts: [] }
      });
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

    if (url.pathname === "/api/v1/agents/profile" && method === "GET") {
      return jsonResponse({
        success: true,
        agent: { name: "OutreachBot" },
        recentPosts: [],
        recentComments: []
      });
    }

    if (url.pathname === "/api/v1/feed" && method === "GET") {
      return jsonResponse({
        success: true,
        posts: []
      });
    }

    if (url.pathname === "/api/v1/posts/missing-post/comments" && method === "GET") {
      return jsonResponse({
        success: true,
        comments: []
      });
    }

    if (url.pathname === "/api/v1/search" && method === "GET") {
      return jsonResponse({
        success: true,
        results: []
      });
    }

    throw new Error(`Unhandled fetch: ${method} ${url.pathname}`);
  };

  try {
    await runHeartbeat(config);
    const savedState = JSON.parse(await readFile(config.statePath, "utf8")) as {
      pendingWrites?: Array<{ reconciliationMisses?: number }>;
    };
    const savedReport = JSON.parse(await readFile(config.heartbeatReportPath, "utf8")) as {
      reconciledPendingWrites?: Array<{ id?: string; type?: string; status?: string }>;
    };

    assert.equal(savedState.pendingWrites?.[0]?.reconciliationMisses, 2);
    assert.deepEqual(savedReport.reconciledPendingWrites, [
      {
        id: "reply:still-missing",
        type: "reply",
        status: "still_pending"
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});
