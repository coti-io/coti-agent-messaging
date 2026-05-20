import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { appendRedditMemory, loadRedditMemory } from "../src/reddit-memory.js";
import { runRedditSession } from "../src/reddit-session.js";
import type { MoltbookRuntimeConfig } from "../src/config.js";
import type { RedditIngestionResult } from "../src/reddit-ingestion.js";
import type { VenueAction } from "../src/venue.js";

function createConfig(memoryPath: string): MoltbookRuntimeConfig {
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
    agent: {
      venue: "reddit",
      venueAccountId: "reddit-user",
      allowedSurfaces: ["sales"],
      mode: "approved_autopost"
    },
    reddit: {
      controller: "manual",
      browserBridge: {
        bridgeDir: path.join(os.tmpdir(), "reddit-browser-session-test"),
        responseTimeoutMs: 1000,
        pollIntervalMs: 10
      },
      api: {
        baseUrl: "https://oauth.reddit.test"
      }
    },
    redditOperating: {
      targetSubreddits: ["sales"],
      searchQueries: ["CRM messy data"],
      maxActionsPerSession: 1,
      maxActionsPerDay: 4,
      minJitterMinutes: 10,
      maxJitterMinutes: 20,
      readController: "api",
      dryRunDefault: true,
      memoryPath
    }
  };
}

const ingestion: RedditIngestionResult = {
  capturedAt: "2026-05-19T09:00:00.000Z",
  snapshots: [],
  skipped: [],
  sourceItems: [
    {
      id: "comment-1",
      kind: "comment",
      subreddit: "sales",
      title: "CRM messy data",
      parentTitle: "CRM messy data",
      body: "We keep breaking sales handoffs with duplicate CRM records. Any advice on fixing this manual workflow?",
      createdUtc: Date.parse("2026-05-19T08:00:00.000Z") / 1000,
      commentCount: 12,
      permalink: "/r/sales/comments/post-1/_/comment-1/"
    }
  ]
};

test("reddit session dry-run emits decision report and records draft without publishing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-session-dry-"));
  const memoryPath = path.join(tempDir, "memory.json");
  let published = false;
  const report = await runRedditSession({
    config: createConfig(memoryPath),
    ingestion,
    dryRun: true,
    publishAction: async () => {
      published = true;
      throw new Error("should not publish");
    }
  });

  assert.equal(published, false);
  assert.equal(report.dryRun, true);
  assert.equal(report.decision.action?.type, "reply_to_comment");
  assert.ok(report.draft?.content);
  const memory = await loadRedditMemory(memoryPath);
  assert.equal(memory.history.length, 1);
  assert.equal(memory.history[0]?.status, "drafted");
  assert.equal(memory.history[0]?.targetId, undefined);
  assert.ok(memory.history[0]?.promptVariantId);
  assert.ok(memory.history[0]?.promptParameters?.messageStyle);
});

test("reddit session live mode publishes at most one action and records outcome", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-session-live-"));
  const memoryPath = path.join(tempDir, "memory.json");
  const published: VenueAction[] = [];
  const report = await runRedditSession({
    config: createConfig(memoryPath),
    ingestion,
    dryRun: false,
    publishAction: async (action) => {
      published.push(action);
      return {
        id: "outcome-1",
        venue: "reddit",
        actionId: action.id,
        candidateId: action.candidateId,
        remoteContentId: "reply-1",
        remoteContentUrl: "https://www.reddit.com/r/sales/comments/post-1/_/reply-1/",
        type: "replied",
        occurredAt: new Date().toISOString()
      };
    }
  });

  assert.equal(published.length, 1);
  assert.equal(published[0]?.type, "reply_to_comment");
  assert.equal(report.outcome?.remoteContentId, "reply-1");
  const memory = await loadRedditMemory(memoryPath);
  assert.equal(memory.history.length, 1);
  assert.equal(memory.history[0]?.status, "posted");
  assert.ok(memory.history[0]?.promptVariantId);
  assert.ok(memory.history[0]?.nextEligibleAt);
});

test("reddit session ignores prior dry-run drafts when selecting a live target", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-session-reuse-"));
  const memoryPath = path.join(tempDir, "memory.json");
  await runRedditSession({
    config: createConfig(memoryPath),
    ingestion,
    dryRun: true
  });

  const published: VenueAction[] = [];
  const report = await runRedditSession({
    config: createConfig(memoryPath),
    ingestion,
    dryRun: false,
    publishAction: async (action) => {
      published.push(action);
      return {
        id: "outcome-2",
        venue: "reddit",
        actionId: action.id,
        candidateId: action.candidateId,
        remoteContentId: "reply-2",
        remoteContentUrl: "https://www.reddit.com/r/sales/comments/post-1/_/reply-2/",
        type: "replied",
        occurredAt: new Date().toISOString()
      };
    }
  });

  assert.equal(published.length, 1);
  assert.equal(report.recorded?.targetId, "comment-1");
});

test("reddit session enforces the daily live action cap", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-session-cap-"));
  const memoryPath = path.join(tempDir, "memory.json");
  const config = createConfig(memoryPath);
  await appendRedditMemory(memoryPath, {
    id: "posted-1",
    subreddit: "sales",
    kind: "reply",
    content: "Live reply",
    createdAt: new Date().toISOString(),
    targetId: "comment-older",
    status: "posted",
    firstReply: true
  });
  config.redditOperating = {
    targetSubreddits: [...config.redditOperating!.targetSubreddits],
    searchQueries: [...config.redditOperating!.searchQueries],
    maxActionsPerSession: config.redditOperating!.maxActionsPerSession,
    maxActionsPerDay: 1,
    minJitterMinutes: config.redditOperating!.minJitterMinutes,
    maxJitterMinutes: config.redditOperating!.maxJitterMinutes,
    readController: config.redditOperating!.readController,
    dryRunDefault: config.redditOperating!.dryRunDefault,
    memoryPath: config.redditOperating!.memoryPath
  };

  const report = await runRedditSession({
    config,
    ingestion,
    dryRun: false
  });

  assert.equal(report.decision.action, undefined);
  assert.ok(report.decision.skipped.some((entry) => entry.includes("Daily Reddit action cap reached")));
});

test("reddit session honors stored cooldown before another live action", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-session-cooldown-"));
  const memoryPath = path.join(tempDir, "memory.json");
  await appendRedditMemory(memoryPath, {
    id: "posted-2",
    subreddit: "sales",
    kind: "reply",
    content: "Live reply",
    createdAt: new Date().toISOString(),
    targetId: "comment-older",
    status: "posted",
    firstReply: true,
    nextEligibleAt: new Date(Date.now() + 20 * 60_000).toISOString()
  });

  const report = await runRedditSession({
    config: createConfig(memoryPath),
    ingestion,
    dryRun: false
  });

  assert.equal(report.decision.action, undefined);
  assert.ok(report.decision.skipped.some((entry) => entry.includes("cooldown active")));
});
