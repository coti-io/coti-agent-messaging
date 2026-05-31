import test from "node:test";
import assert from "node:assert/strict";

import { buildRedditControllerConfig, buildRedditOperatingAgentConfig } from "../src/config.js";
import { RedditReddapiController } from "../src/reddit-controller.js";
import {
  reddapiScrapeToThreadState,
  reddapiSearchPostsToResults,
  resolveReddapiPostUrl
} from "../src/reddit-reddapi.js";
import type { MoltbookRuntimeConfig } from "../src/config.js";
import path from "node:path";

function createConfig(overrides: Partial<MoltbookRuntimeConfig> = {}): MoltbookRuntimeConfig {
  const packageRoot = path.resolve(import.meta.dirname, "..");
  return {
    packageRoot,
    projectRoot: path.resolve(packageRoot, ".."),
    credentialsPath: path.join(packageRoot, ".runtime", "test-credentials.json"),
    statePath: path.join(packageRoot, ".runtime", "test-state.json"),
    heartbeatReportPath: path.join(packageRoot, ".runtime", "test-heartbeat.json"),
    moltbookBaseUrl: "https://www.moltbook.com/api/v1",
    defaultSubmolt: "general",
    dryRun: false,
    autoVerify: false,
    reddit: {
      ...buildRedditControllerConfig(packageRoot),
      controller: "reddapi",
      reddapi: {
        rapidApiKey: "rapid-key",
        proxy: "http://proxy.test:3128",
        storageStatePath: path.join(packageRoot, ".runtime", "reddit-storage-state.json"),
        rapidApiHost: "reddapi.test",
        bearerOverride: "test-bearer-token"
      }
    },
    agent: {
      venue: "reddit",
      venueAccountId: "reddit-user",
      allowedSurfaces: ["Moltbook"],
      mode: "approved_autopost",
      policyProfileId: "reddit-browser"
    },
    ...overrides
  };
}

test("reddit controller config defaults to reddapi", () => {
  const previousController = process.env.OUTREACH_REDDIT_CONTROLLER;
  const previousRead = process.env.OUTREACH_REDDIT_READ_CONTROLLER;
  delete process.env.OUTREACH_REDDIT_CONTROLLER;
  delete process.env.OUTREACH_REDDIT_READ_CONTROLLER;
  try {
    const reddit = buildRedditControllerConfig(path.resolve(import.meta.dirname, ".."));
    const operating = buildRedditOperatingAgentConfig(path.resolve(import.meta.dirname, ".."));
    assert.equal(reddit.controller, "reddapi");
    assert.equal(operating.readController, "reddapi");
  } finally {
    if (previousController === undefined) {
      delete process.env.OUTREACH_REDDIT_CONTROLLER;
    } else {
      process.env.OUTREACH_REDDIT_CONTROLLER = previousController;
    }
    if (previousRead === undefined) {
      delete process.env.OUTREACH_REDDIT_READ_CONTROLLER;
    } else {
      process.env.OUTREACH_REDDIT_READ_CONTROLLER = previousRead;
    }
  }
});

test("reddapi scrape mapping builds thread comments", () => {
  const postUrl =
    "https://www.reddit.com/r/Moltbook/comments/abc123/example_thread/";
  const thread = reddapiScrapeToThreadState({
    postUrl,
    subreddit: "Moltbook",
    title: "Example",
    body: "Body",
    comments: [{ comment: "Same issue here.", author: "peer", score: 2 }]
  });
  assert.equal(thread.id, "abc123");
  assert.equal(thread.comments.length, 1);
  assert.equal(thread.comments[0]?.body, "Same issue here.");
});

test("reddapi search results filter to target subreddit", () => {
  const results = reddapiSearchPostsToResults(
    [
      { id: "abc", title: "On topic", subreddit: "Moltbook", score: 3 },
      { id: "def", title: "Off topic", subreddit: "Other", score: 9 }
    ],
    "Moltbook"
  );
  assert.equal(results.length, 1);
  assert.equal(results[0]?.subreddit, "Moltbook");
});

test("resolveReddapiPostUrl prefers permalink from action raw", () => {
  const url = resolveReddapiPostUrl({
    type: "comment_on_post",
    raw: { permalink: "/r/Moltbook/comments/abc123/title/" }
  });
  assert.equal(url, "https://www.reddit.com/r/Moltbook/comments/abc123/title/");
});

test("ReddAPI controller posts comments through ReddAPI", async () => {
  const calls: Array<{ route: string; body?: Record<string, unknown> }> = [];
  const controller = new RedditReddapiController(createConfig(), async (input, init) => {
    const url = new URL(input instanceof URL ? input.toString() : String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ route: url.pathname, body });
    if (url.pathname === "/api/comment") {
      return new Response(JSON.stringify({ success: true, reddit_status_code: 200 }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });

  await controller.publishAction(
    {
      id: "action-1",
      venue: "reddit",
      type: "comment_on_post",
      surface: "Moltbook",
      parentId: "abc123",
      content: "Short helpful reply.",
      raw: { permalink: "/r/Moltbook/comments/abc123/title/" }
    },
    { mode: "approved_autopost", allowedSurfaces: ["Moltbook"] }
  );

  assert.equal(calls.some((entry) => entry.route === "/api/comment"), true);
  const commentCall = calls.find((entry) => entry.route === "/api/comment");
  assert.equal(commentCall?.body?.text, "Short helpful reply.");
  assert.equal(commentCall?.body?.proxy, "http://proxy.test:3128");
});
