import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import {
  RedditApiController,
  RedditBrowserController,
  RedditBrowserSubmitError,
  RedditManualController
} from "../src/reddit-controller.js";
import type { MoltbookRuntimeConfig } from "../src/config.js";

function createConfig(overrides: Partial<MoltbookRuntimeConfig> = {}): MoltbookRuntimeConfig {
  const packageRoot = path.resolve(import.meta.dirname, "..", "..");
  return {
    packageRoot,
    projectRoot: path.resolve(packageRoot, ".."),
    credentialsPath: path.join(os.tmpdir(), "outreach-agent-test-credentials.json"),
    statePath: path.join(os.tmpdir(), "outreach-agent-test-state.json"),
    heartbeatReportPath: path.join(os.tmpdir(), "outreach-agent-test-heartbeat.json"),
    moltbookBaseUrl: "https://www.moltbook.com/api/v1",
    defaultSubmolt: "general",
    dryRun: false,
    autoVerify: false,
    reddit: {
      controller: "manual",
      browserBridge: {
        bridgeDir: path.join(os.tmpdir(), "outreach-agent-test-reddit-browser"),
        responseTimeoutMs: 1000,
        pollIntervalMs: 10
      },
      api: {
        accessToken: "token",
        userAgent: "test-agent",
        baseUrl: "https://oauth.reddit.test"
      }
    },
    agent: {
      venue: "reddit",
      venueAccountId: "reddit-user",
      allowedSurfaces: ["AI_Agents"],
      mode: "approved_autopost",
      policyProfileId: "reddit-browser"
    },
    ...overrides
  };
}

test("Reddit API controller submits self posts", async () => {
  const controller = new RedditApiController(createConfig(), async (input, init) => {
    const url = new URL(input instanceof URL ? input.toString() : String(input));
    assert.equal(url.pathname, "/api/submit");
    assert.equal(init?.method, "POST");
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("sr"), "AI_Agents");
    assert.equal(body.get("title"), "Private coordination");
    assert.equal(body.get("text"), "Use explicit inbox state.");
    return new Response(
      JSON.stringify({
        json: {
          errors: [],
          data: {
            things: [
              {
                data: {
                  id: "post42",
                  name: "t3_post42",
                  permalink: "/r/AI_Agents/comments/post42/private_coordination/"
                }
              }
            ]
          }
        }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  const result = await controller.publishAction(
    {
      id: "post-1",
      venue: "reddit",
      type: "create_post",
      surface: "AI_Agents",
      title: "Private coordination",
      content: "Use explicit inbox state."
    },
    {
      mode: "approved_autopost",
      allowedSurfaces: ["AI_Agents"],
      venueAccountId: "reddit-user"
    }
  );

  assert.equal(result.remoteContentId, "post42");
  assert.equal(
    result.remoteContentUrl,
    "https://www.reddit.com/r/AI_Agents/comments/post42/private_coordination/"
  );
});

test("Reddit browser controller writes bridge requests and reads responses", async () => {
  const bridgeDir = path.join(os.tmpdir(), `reddit-browser-bridge-${Date.now()}`);
  const controller = new RedditBrowserController(
    createConfig({
      reddit: {
        controller: "browser",
        browserBridge: {
          bridgeDir,
          responseTimeoutMs: 2000,
          pollIntervalMs: 10
        },
        api: {
          accessToken: "token",
          userAgent: "test-agent",
          baseUrl: "https://oauth.reddit.test"
        }
      }
    })
  );

  const run = controller.publishAction(
    {
      id: "reply-1",
      venue: "reddit",
      type: "reply_to_comment",
      candidateId: "comment-1",
      content: "Useful reply.",
      raw: { permalink: "/r/AI_Agents/comments/thread/comment-1/" }
    },
    {
      mode: "approved_autopost",
      allowedSurfaces: ["AI_Agents"],
      venueAccountId: "reddit-user"
    }
  );

  const requestsDir = path.join(bridgeDir, "requests");
  const responsesDir = path.join(bridgeDir, "responses");
  await mkdir(responsesDir, { recursive: true });

  let requestFile: string | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const entries = await readDirFiles(requestsDir);
      requestFile = entries[0];
      if (requestFile) {
        break;
      }
    } catch {}
    await delay(10);
  }

  assert.ok(requestFile);
  const requestPath = path.join(requestsDir, requestFile);
  const request = JSON.parse(await readFile(requestPath, "utf8")) as {
    requestId: string;
    action: { type: string; candidateId?: string };
    context: { venueAccountId?: string };
  };
  assert.equal(request.action.type, "reply_to_comment");
  assert.equal(request.action.candidateId, "comment-1");
  assert.equal(request.context.venueAccountId, "reddit-user");

  await writeFile(
    path.join(responsesDir, `${request.requestId}.json`),
    JSON.stringify({
      requestId: request.requestId,
      ok: true,
      remoteContentId: "t1_reply42",
      remoteContentUrl: "https://www.reddit.com/r/AI_Agents/comments/thread/reply42/"
    }),
    "utf8"
  );

  const result = await run;
  assert.equal(result.remoteContentId, "t1_reply42");
});

test("Reddit browser controller maps typed bridge failures", async () => {
  const bridgeDir = path.join(os.tmpdir(), `reddit-browser-bridge-error-${Date.now()}`);
  const controller = new RedditBrowserController(
    createConfig({
      reddit: {
        controller: "browser",
        browserBridge: {
          bridgeDir,
          responseTimeoutMs: 2000,
          pollIntervalMs: 10
        },
        api: {
          accessToken: "token",
          userAgent: "test-agent",
          baseUrl: "https://oauth.reddit.test"
        }
      }
    })
  );

  const run = controller.publishAction(
    {
      id: "reply-2",
      venue: "reddit",
      type: "reply_to_comment",
      candidateId: "comment-2",
      content: "Useful reply."
    },
    {
      mode: "approved_autopost",
      allowedSurfaces: ["AI_Agents"],
      venueAccountId: "reddit-user"
    }
  );

  const requestsDir = path.join(bridgeDir, "requests");
  const responsesDir = path.join(bridgeDir, "responses");
  await mkdir(responsesDir, { recursive: true });

  let requestFile: string | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const entries = await readDirFiles(requestsDir);
      requestFile = entries[0];
      if (requestFile) {
        break;
      }
    } catch {}
    await delay(10);
  }

  assert.ok(requestFile);
  const requestPath = path.join(requestsDir, requestFile);
  const request = JSON.parse(await readFile(requestPath, "utf8")) as { requestId: string };
  await writeFile(
    path.join(responsesDir, `${request.requestId}.json`),
    JSON.stringify({
      requestId: request.requestId,
      ok: false,
      code: "submit_failed",
      message: "Reddit submit button stayed disabled."
    }),
    "utf8"
  );

  await assert.rejects(() => run, RedditBrowserSubmitError);
});

test("Reddit manual controller disables publishing", async () => {
  const controller = new RedditManualController();
  await assert.rejects(
    () =>
      controller.publishAction(
        {
          id: "reply-1",
          venue: "reddit",
          type: "reply_to_comment",
          candidateId: "comment-1",
          content: "Useful reply."
        },
        {
          mode: "approved_autopost",
          allowedSurfaces: ["AI_Agents"],
          venueAccountId: "reddit-user"
        }
      ),
    /publishing is disabled/
  );
});

async function readDirFiles(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(dir)).filter((entry) => entry.endsWith(".json")).sort();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
