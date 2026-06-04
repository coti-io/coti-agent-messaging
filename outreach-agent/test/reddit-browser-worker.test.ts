import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";

import { RedditLoginRequiredError, type RedditBrowserBridgeRequest } from "../src/reddit-controller.js";
import {
  parsePlaywrightProxy,
  resolveRedditBrowserWorkerConfig,
  startRedditBrowserWorker,
  type RedditBrowserAutomation,
  type RedditBrowserWorkerConfig
} from "../src/reddit-browser-worker.js";

function createConfig(tempDir: string): RedditBrowserWorkerConfig {
  return {
    bridgeDir: tempDir,
    requestsDir: path.join(tempDir, "requests"),
    processingDir: path.join(tempDir, "processing"),
    responsesDir: path.join(tempDir, "responses"),
    statusPath: path.join(tempDir, "status.json"),
    pollIntervalMs: 25,
    requestTimeoutMs: 1000,
    headless: true,
    baseUrl: "https://www.reddit.test",
    startupUrl: "https://www.reddit.test"
  };
}

test("reddit browser worker config reads browser proxy env", () => {
  const previousProxy = process.env.OUTREACH_REDDIT_BROWSER_PROXY;
  process.env.OUTREACH_REDDIT_BROWSER_PROXY = "http://user:pass@proxy.test:3128";

  try {
    const config = resolveRedditBrowserWorkerConfig();
    assert.equal(config.proxy, "http://user:pass@proxy.test:3128");
  } finally {
    if (previousProxy === undefined) {
      delete process.env.OUTREACH_REDDIT_BROWSER_PROXY;
    } else {
      process.env.OUTREACH_REDDIT_BROWSER_PROXY = previousProxy;
    }
  }
});

test("playwright proxy parser separates credentials from server", () => {
  assert.deepEqual(parsePlaywrightProxy("http://user:pass@proxy.test:3128"), {
    server: "http://proxy.test:3128/",
    username: "user",
    password: "pass"
  });
  assert.deepEqual(parsePlaywrightProxy("socks5://proxy.test:1080"), {
    server: "socks5://proxy.test:1080"
  });
});

async function waitForSingleFile(directory: string, timeoutMs = 5000): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const files = (await readdir(directory).catch(() => [] as string[]))
      .filter((entry) => entry.endsWith(".json"))
      .sort();
    if (files.length > 0) {
      return files[0]!;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for file in ${directory}`);
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

test("reddit browser worker fulfills requests and writes responses", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-browser-worker-"));
  const seenRequests: string[] = [];
  const automation: RedditBrowserAutomation = {
    async fulfill(request) {
      seenRequests.push(request.requestId);
      return {
        remoteContentId: "reply-42",
        remoteContentUrl: "https://www.reddit.com/r/AI_Agents/comments/post/reply-42/"
      };
    },
    async close() {}
  };
  const config = createConfig(tempDir);
  const handle = await startRedditBrowserWorker(config, automation);

  try {
    const request: RedditBrowserBridgeRequest = {
      requestId: "reddit-browser-1",
      createdAt: new Date().toISOString(),
      controller: "browser",
      venue: "reddit",
      action: {
        id: "reply-1",
        type: "reply_to_comment",
        candidateId: "comment-1",
        content: "Useful reply.",
        raw: {
          permalink: "/r/AI_Agents/comments/post/comment-1/"
        }
      },
      context: {
        mode: "approved_autopost",
        allowedSurfaces: ["AI_Agents"],
        venueAccountId: "reddit-user"
      }
    };

    await writeFile(path.join(config.requestsDir, `${request.requestId}.json`), JSON.stringify(request), "utf8");
    const responseFile = await waitForSingleFile(config.responsesDir);
    assert.equal(responseFile, `${request.requestId}.json`);
    assert.deepEqual(JSON.parse(await readFile(path.join(config.responsesDir, responseFile), "utf8")), {
      requestId: "reddit-browser-1",
      ok: true,
      remoteContentId: "reply-42",
      remoteContentUrl: "https://www.reddit.com/r/AI_Agents/comments/post/reply-42/"
    });
    assert.deepEqual(seenRequests, ["reddit-browser-1"]);
    assert.deepEqual(await readdir(config.processingDir), []);
  } finally {
    await handle.close();
  }

  assert.equal(await exists(config.statusPath), true);
});

test("reddit browser worker maps automation failures into typed bridge responses", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-browser-worker-fail-"));
  const automation: RedditBrowserAutomation = {
    async fulfill() {
      throw new RedditLoginRequiredError("Login expired in browser profile.");
    },
    async close() {}
  };
  const config = createConfig(tempDir);
  const handle = await startRedditBrowserWorker(config, automation);

  try {
    const request: RedditBrowserBridgeRequest = {
      requestId: "reddit-browser-2",
      createdAt: new Date().toISOString(),
      controller: "browser",
      venue: "reddit",
      action: {
        id: "post-1",
        type: "create_post",
        surface: "AI_Agents",
        title: "Title",
        content: "Body"
      },
      context: {
        mode: "approved_autopost",
        allowedSurfaces: ["AI_Agents"]
      }
    };

    await writeFile(path.join(config.requestsDir, `${request.requestId}.json`), JSON.stringify(request), "utf8");
    const responseFile = await waitForSingleFile(config.responsesDir);
    assert.deepEqual(JSON.parse(await readFile(path.join(config.responsesDir, responseFile), "utf8")), {
      requestId: "reddit-browser-2",
      ok: false,
      code: "login_required",
      message: "Login expired in browser profile."
    });
  } finally {
    await handle.close();
  }
});

test("reddit browser worker fulfills read requests with normalized state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-browser-worker-read-"));
  const automation: RedditBrowserAutomation = {
    async fulfill(request) {
      assert.equal(request.action.type, "read_thread");
      return {
        result: {
          type: "read_thread",
          thread: {
            id: "post-1",
            subreddit: "sales",
            title: "CRM handoff is broken",
            body: "How do people fix this?",
            permalink: "/r/sales/comments/post-1/crm/",
            comments: [
              {
                id: "comment-1",
                body: "We keep duplicating records.",
                depth: 0
              }
            ]
          }
        }
      };
    },
    async close() {}
  };
  const config = createConfig(tempDir);
  const handle = await startRedditBrowserWorker(config, automation);

  try {
    const request: RedditBrowserBridgeRequest = {
      requestId: "reddit-browser-read-1",
      createdAt: new Date().toISOString(),
      controller: "browser",
      venue: "reddit",
      action: {
        id: "thread-post-1",
        type: "read_thread",
        url: "/r/sales/comments/post-1/crm/"
      },
      context: {
        mode: "approved_autopost",
        allowedSurfaces: ["sales"]
      }
    };

    await writeFile(path.join(config.requestsDir, `${request.requestId}.json`), JSON.stringify(request), "utf8");
    const responseFile = await waitForSingleFile(config.responsesDir);
    const response = JSON.parse(await readFile(path.join(config.responsesDir, responseFile), "utf8"));
    assert.equal(response.ok, true);
    assert.equal(response.result.type, "read_thread");
    assert.equal(response.result.thread.comments[0].id, "comment-1");
    assert.equal(response.remoteContentId, undefined);
  } finally {
    await handle.close();
  }
});

test("reddit browser worker restores abandoned processing files on startup", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-browser-worker-restore-"));
  const config = createConfig(tempDir);
  const automation: RedditBrowserAutomation = {
    async fulfill(request) {
      return {
        remoteContentId: request.requestId,
        remoteContentUrl: `https://www.reddit.com/comments/${request.requestId}`
      };
    },
    async close() {}
  };

  await mkdir(config.processingDir, { recursive: true });
  await writeFile(
    path.join(config.processingDir, "restored.json"),
    JSON.stringify({
      requestId: "restored",
      createdAt: new Date().toISOString(),
      controller: "browser",
      venue: "reddit",
      action: {
        id: "comment-1",
        type: "comment_on_post",
        parentId: "post-1",
        content: "Recovered request",
        raw: {
          permalink: "/comments/post-1"
        }
      },
      context: {
        mode: "approved_autopost",
        allowedSurfaces: ["AI_Agents"]
      }
    } satisfies RedditBrowserBridgeRequest),
    "utf8"
  );

  const handle = await startRedditBrowserWorker(config, automation);
  try {
    const responseFile = await waitForSingleFile(config.responsesDir);
    assert.equal(responseFile, "restored.json");
  } finally {
    await handle.close();
  }
});
