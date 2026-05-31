import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { appendRedditMemory, loadRedditMemory, pruneDraftedRedditMemory } from "../src/reddit-memory.js";
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
    promptProfile: {
      id: "test-reddit-session-profile",
      allowVariantOverrides: false,
      parameters: {
        layout: "regular_paragraph",
        responseLength: "brief",
        promotionLevel: "none",
        ctaStyle: "none",
        productSpecificity: "generic_category",
        rewardEmphasis: "none",
        technicalDepth: "simple",
        tone: "operator",
        messageStyle: "informative"
      },
      venueOverrides: {
        reddit: {
          layout: "regular_paragraph",
          responseLength: "brief",
          promotionLevel: "none",
          ctaStyle: "none",
          productSpecificity: "generic_category",
          rewardEmphasis: "none"
        }
      },
      actionOverrides: {
        reply_to_activity: {
          layout: "regular_paragraph",
          messageStyle: "informative"
        },
        comment_on_post: {
          layout: "regular_paragraph",
          messageStyle: "informative"
        }
      }
    },
    autoVerify: false,
    agent: {
      venue: "reddit",
      venueAccountId: "reddit-user",
      allowedSurfaces: ["AI_Agents", "LocalLLaMA"],
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
      },
      reddapi: {
        rapidApiKey: "rapid-key",
        proxy: "http://proxy.test:3128",
        storageStatePath: path.join(os.tmpdir(), "reddit-storage-state.json"),
        rapidApiHost: "reddapi.test"
      }
    },
    redditOperating: {
      targetSubreddits: ["AI_Agents"],
      searchQueries: ["CRM messy data"],
      ingestionListLimit: 5,
      ingestionMaxOwnThreadReads: 25,
      ingestionMaxDiscoveryThreadReads: 0,
      ingestionOwnThreadCommentLimit: 100,
      ingestionMaxSearchesPerSubreddit: 0,
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
  ownThreadTargets: 0,
  ownThreadSnapshots: 0,
  discoveryThreadSnapshots: 0,
  diagnostics: {
    subreddits: ["AI_Agents"],
    discoverySearchQueries: [],
    discoveryListingSorts: [],
    excludedThreadPostIds: [],
    discoveryPickStrategy: "stochastic",
    browserHeadless: false,
    readViaBrowser: false,
    readViaReddapi: false
  },
  sourceItems: [
    {
      id: "comment-1",
      kind: "comment",
      subreddit: "AI_Agents",
      title: "MCP agent messaging between services",
      parentTitle: "MCP agent messaging between services",
      body: "How are you handling private agent-to-agent messaging when tools need encrypted coordination outside the main LLM context?",
      createdUtc: Date.parse("2026-05-19T08:00:00.000Z") / 1000,
      commentCount: 12,
      permalink: "/r/AI_Agents/comments/post-1/_/comment-1/",
      onOwnThread: true,
      threadPostId: "post-1"
    }
  ]
};

function createPublicThreadListing(postId: string, comments: Array<{ id: string; body: string }>): unknown[] {
  return [
    {
      data: {
        children: [
          {
            kind: "t3",
            data: {
              id: postId,
              subreddit: "AI_Agents",
              title: "MCP agent messaging between services",
              selftext: "Thread body"
            }
          }
        ]
      }
    },
    {
      data: {
        children: comments.map((comment) => ({
          kind: "t1",
          data: {
            id: comment.id,
            body: comment.body,
            author: "someone",
            parent_id: `t3_${postId}`,
            replies: ""
          }
        }))
      }
    }
  ];
}

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
  assert.equal(report.duplicateCheckPolicy, "block_posted_only");
  assert.equal(report.decision.action?.type, "reply_to_comment");
  assert.equal(report.actionCandidates.length, 1);
  assert.equal(report.actionCandidates[0]?.type, "reply_to_activity");
  assert.equal(report.selectedActionBundle?.selectedWriteCandidateId, "comment:AI_Agents:comment-1");
  assert.ok(report.draft?.content);
  const memory = await loadRedditMemory(memoryPath);
  assert.equal(memory.history.length, 1);
  assert.equal(memory.history[0]?.status, "drafted");
  assert.equal(memory.history[0]?.targetId, "comment-1");
  assert.equal(memory.history[0]?.targetTitle, "MCP agent messaging between services");
  assert.equal(
    memory.history[0]?.targetUrl,
    "https://www.reddit.com/r/AI_Agents/comments/post-1/_/comment-1/"
  );
  assert.ok(memory.history[0]?.promptVariantId);
  assert.ok(memory.history[0]?.promptParameters?.messageStyle);
});

test("reddit session live mode publishes at most one action and records outcome", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-session-live-"));
  const memoryPath = path.join(tempDir, "memory.json");
  const published: VenueAction[] = [];
  const firstReport = await runRedditSession({
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
        remoteContentUrl: "https://www.reddit.com/r/AI_Agents/comments/post-1/_/reply-1/",
        type: "replied",
        occurredAt: new Date().toISOString()
      };
    }
  });

  assert.equal(published.length, 0);
  assert.equal(firstReport.outcome, undefined);
  assert.equal(firstReport.queuedActionJobs.length, 1);
  assert.equal(firstReport.selectedActionBundle?.selectedWriteCandidateId, "comment:AI_Agents:comment-1");

  const report = await runRedditSession({
    config: createConfig(memoryPath),
    ingestion,
    dryRun: false,
    fetchImpl: async (input) => {
      const url = new URL(input instanceof URL ? input.toString() : String(input));
      assert.equal(url.pathname, "/r/AI_Agents/comments/post-1.json");
      return new Response(JSON.stringify(createPublicThreadListing("post-1", [
        {
          id: "reply-1",
          body:
            "A practical pattern is a small transport interface plus per-tool encrypted payloads so agents can coordinate off-thread without leaking everything into the public context."
        }
      ])));
    },
    publishAction: async (action) => {
      published.push(action);
      return {
        id: "outcome-1",
        venue: "reddit",
        actionId: action.id,
        candidateId: action.candidateId,
        remoteContentId: "reply-1",
        remoteContentUrl: "https://www.reddit.com/r/AI_Agents/comments/post-1/_/reply-1/",
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
  assert.equal((memory.queuedJobs?.length ?? 0), 0);
});

test("reddit session marks a published reply as spam filtered when it is not publicly visible", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-session-hidden-"));
  const memoryPath = path.join(tempDir, "memory.json");
  await runRedditSession({
    config: createConfig(memoryPath),
    ingestion,
    dryRun: false,
    publishAction: async (action) => ({
      id: "queued-hidden",
      venue: "reddit",
      actionId: action.id,
      candidateId: action.candidateId,
      remoteContentId: "reply-hidden",
      remoteContentUrl: "https://www.reddit.com/r/AI_Agents/comments/post-1/_/reply-hidden/",
      type: "replied",
      occurredAt: new Date().toISOString()
    })
  });

  const report = await runRedditSession({
    config: createConfig(memoryPath),
    ingestion,
    dryRun: false,
    fetchImpl: async () => new Response(JSON.stringify(createPublicThreadListing("post-1", []))),
    publishAction: async (action) => ({
      id: "outcome-hidden",
      venue: "reddit",
      actionId: action.id,
      candidateId: action.candidateId,
      remoteContentId: "reply-hidden",
      remoteContentUrl: "https://www.reddit.com/r/AI_Agents/comments/post-1/_/reply-hidden/",
      type: "replied",
      occurredAt: new Date().toISOString()
    })
  });

  assert.equal(report.recorded?.status, "spam_filtered");
  const memory = await loadRedditMemory(memoryPath);
  assert.equal(memory.history.length, 1);
  assert.equal(memory.history[0]?.status, "spam_filtered");
});

test("reddit session uses softer prompt params after a hidden reply in the same subreddit", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-session-adaptive-"));
  const memoryPath = path.join(tempDir, "memory.json");
  await appendRedditMemory(memoryPath, {
    id: "hidden-previous",
    subreddit: "AI_Agents",
    kind: "reply",
    content: "Hidden reply",
    createdAt: new Date().toISOString(),
    targetId: "comment-old",
    status: "spam_filtered",
    firstReply: true
  });

  const report = await runRedditSession({
    config: createConfig(memoryPath),
    ingestion,
    dryRun: true
  });

  assert.equal(report.recorded?.promptParameters?.layout, "regular_paragraph");
  assert.equal(report.recorded?.promptParameters?.messageStyle, "informative");
  assert.equal(report.recorded?.promptParameters?.technicalDepth, "simple");
  assert.equal(report.recorded?.promptParameters?.creativity, "conservative");
  assert.equal(report.recorded?.promptParameters?.aggression, "low");
});

test("reddit session live can publish after batch prune clears prior dry-run draft", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-session-reuse-"));
  const memoryPath = path.join(tempDir, "memory.json");
  await runRedditSession({
    config: createConfig(memoryPath),
    ingestion,
    dryRun: true
  });

  let memory = await loadRedditMemory(memoryPath);
  assert.equal(memory.history.length, 1);
  assert.equal(memory.history[0]?.status, "drafted");
  await pruneDraftedRedditMemory(memoryPath);
  memory = await loadRedditMemory(memoryPath);
  assert.equal(memory.history.length, 0);

  const published: VenueAction[] = [];
  const queued = await runRedditSession({
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
        remoteContentUrl: "https://www.reddit.com/r/AI_Agents/comments/post-1/_/reply-2/",
        type: "replied",
        occurredAt: new Date().toISOString()
      };
    }
  });
  assert.equal(published.length, 0);
  assert.equal(queued.queuedActionJobs.length, 1);

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
        remoteContentUrl: "https://www.reddit.com/r/AI_Agents/comments/post-1/_/reply-2/",
        type: "replied",
        occurredAt: new Date().toISOString()
      };
    }
  });

  assert.equal(published.length, 1);
  assert.equal(report.recorded?.targetId, "comment-1");
  memory = await loadRedditMemory(memoryPath);
  assert.equal(memory.history.length, 1);
  assert.equal(memory.history[0]?.status, "posted");
});

test("reddit session dry-run remembers draft within a batch and skips the same target", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-session-draft-batch-"));
  const memoryPath = path.join(tempDir, "memory.json");
  const first = await runRedditSession({
    config: createConfig(memoryPath),
    ingestion,
    dryRun: true
  });
  assert.ok(first.draft?.content);
  const second = await runRedditSession({
    config: createConfig(memoryPath),
    ingestion,
    dryRun: true
  });
  assert.equal(second.decision.action, undefined);
  const memory = await loadRedditMemory(memoryPath);
  assert.equal(memory.history.length, 1);
  assert.equal(memory.history[0]?.status, "drafted");
  assert.equal(memory.history[0]?.targetId, "comment-1");
});

test("batch prune clears drafts but keeps posted history", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-session-batch-prune-"));
  const memoryPath = path.join(tempDir, "memory.json");
  await appendRedditMemory(memoryPath, {
    id: "posted-1",
    subreddit: "AI_Agents",
    kind: "reply",
    content: "already live",
    createdAt: new Date().toISOString(),
    targetId: "comment-old",
    status: "posted",
    firstReply: true
  });
  await runRedditSession({
    config: createConfig(memoryPath),
    ingestion,
    dryRun: true
  });
  await pruneDraftedRedditMemory(memoryPath);
  const memory = await loadRedditMemory(memoryPath);
  assert.equal(memory.history.length, 1);
  assert.equal(memory.history[0]?.status, "posted");
});

test("reddit session pauses a subreddit after repeated hidden replies without tripping the global kill switch", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-session-sub-pause-"));
  const memoryPath = path.join(tempDir, "memory.json");
  await appendRedditMemory(memoryPath, {
    id: "hidden-1",
    subreddit: "AI_Agents",
    kind: "reply",
    content: "Hidden reply one",
    createdAt: new Date().toISOString(),
    targetId: "comment-a",
    status: "spam_filtered",
    firstReply: true
  });
  await appendRedditMemory(memoryPath, {
    id: "hidden-2",
    subreddit: "AI_Agents",
    kind: "reply",
    content: "Hidden reply two",
    createdAt: new Date().toISOString(),
    targetId: "comment-b",
    status: "spam_filtered",
    firstReply: true
  });

  const report = await runRedditSession({
    config: createConfig(memoryPath),
    ingestion,
    dryRun: false
  });

  assert.equal(report.decision.action, undefined);
  assert.equal(report.decision.skipped.some((entry) => entry.includes("Kill switch")), false);
  assert.equal(report.decision.skipped.some((entry) => entry.includes("Subreddit pause for AI_Agents")), true);
});

test("reddit session enforces the daily live action cap", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-session-cap-"));
  const memoryPath = path.join(tempDir, "memory.json");
  const config = createConfig(memoryPath);
  await appendRedditMemory(memoryPath, {
    id: "posted-1",
    subreddit: "AI_Agents",
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
    ingestionListLimit: config.redditOperating!.ingestionListLimit,
    ingestionMaxOwnThreadReads: config.redditOperating!.ingestionMaxOwnThreadReads,
    ingestionMaxDiscoveryThreadReads: config.redditOperating!.ingestionMaxDiscoveryThreadReads,
    ingestionOwnThreadCommentLimit: config.redditOperating!.ingestionOwnThreadCommentLimit,
    ingestionMaxSearchesPerSubreddit: config.redditOperating!.ingestionMaxSearchesPerSubreddit,
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

test("reddit session dry-run skips live cooldown gate", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-session-dry-cooldown-"));
  const memoryPath = path.join(tempDir, "memory.json");
  await appendRedditMemory(memoryPath, {
    id: "posted-dry-cooldown",
    subreddit: "AI_Agents",
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
    dryRun: true
  });

  assert.equal(report.decision.action?.type, "reply_to_comment");
  assert.equal(report.decision.skipped.some((entry) => entry.includes("cooldown active")), false);
});

test("reddit session clears selected write candidate when cooldown blocks live action", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-session-cooldown-bundle-"));
  const memoryPath = path.join(tempDir, "memory.json");
  await appendRedditMemory(memoryPath, {
    id: "posted-3",
    subreddit: "AI_Agents",
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
  assert.equal(report.selectedActionBundle?.selectedWriteCandidateId, undefined);
  assert.ok(report.decision.skipped.some((entry) => entry.includes("cooldown active")));
});

test("reddit session honors stored cooldown before another live action", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-session-cooldown-"));
  const memoryPath = path.join(tempDir, "memory.json");
  await appendRedditMemory(memoryPath, {
    id: "posted-2",
    subreddit: "AI_Agents",
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
