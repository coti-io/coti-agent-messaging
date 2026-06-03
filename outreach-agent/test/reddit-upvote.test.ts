import test from "node:test";
import assert from "node:assert/strict";

import type { RedditPlannedAction } from "../src/reddit-policy.js";
import type { RedditReviewItem } from "../src/reddit-outreach.js";
import type { MoltbookRuntimeConfig, RedditOperatingAgentConfig } from "../src/config.js";
import {
  findThreadSnapshotForSource,
  resolveUpvoteTargetForPlannedAction,
  tryUpvoteBeforeReply
} from "../src/reddit-upvote.js";

function createReviewItem(overrides: Partial<RedditReviewItem["source"]> = {}): RedditReviewItem {
  return {
    id: "comment:mcp:abc",
    source: {
      id: "abc",
      kind: "comment",
      subreddit: "mcp",
      title: "Thread title",
      body: "How do you route MCP auth?",
      threadPostId: "post1",
      ...overrides
    },
    action: "answer_publicly",
    status: "needs_human_review",
    relevanceScore: 8,
    riskScore: 1,
    explicitProductInterest: false,
    privateMessageAssessment: {
      shouldEscalate: false,
      requiresPublicReplyFirst: false,
      explanation: "No escalation."
    },
    publicValueDeliveredFirst: false,
    whyRelevant: "mcp",
    gates: [],
    approvalRequired: true,
    approvalChecklist: []
  };
}

function createPlanned(type: RedditPlannedAction["type"], item: RedditReviewItem): RedditPlannedAction {
  return { type, item, reason: "test", score: 8, nextEligibleAt: new Date().toISOString() };
}

function createConfig(controller: NonNullable<MoltbookRuntimeConfig["reddit"]>["controller"]): MoltbookRuntimeConfig {
  return {
    packageRoot: "/tmp/outreach-agent",
    projectRoot: "/tmp",
    credentialsPath: "/tmp/credentials.json",
    statePath: "/tmp/state.json",
    heartbeatReportPath: "/tmp/heartbeat.json",
    moltbookBaseUrl: "https://moltbook.test",
    defaultSubmolt: "general",
    dryRun: false,
    autoVerify: false,
    agent: {
      venue: "reddit",
      mode: "approved_autopost",
      allowedSurfaces: ["mcp"]
    },
    reddit: {
      controller,
      browserBridge: {
        bridgeDir: "/tmp/reddit-browser",
        responseTimeoutMs: 1000,
        pollIntervalMs: 10
      },
      api: {},
      reddapi: {
        storageStatePath: "/tmp/reddit-storage.json",
        rapidApiHost: "reddapi.test"
      },
      unofficial: {
        storageStatePath: "/tmp/reddit-storage.json",
        publicBaseUrl: "https://www.reddit.com",
        oauthBaseUrl: "https://oauth.reddit.com",
        userAgent: "test-agent"
      }
    }
  } as MoltbookRuntimeConfig;
}

function createOperating(overrides: Partial<RedditOperatingAgentConfig> = {}): RedditOperatingAgentConfig {
  return {
    discoverySubredditPool: ["mcp"],
    discoverySubsPerRun: 1,
    scanLedgerTtlHours: 48,
    scanLedgerMaxEntries: 2000,
    llmTriageEnabled: false,
    llmTriageMaxItems: 25,
    llmSelectEnabled: false,
    upvoteEnabled: true,
    upvoteBeforeReply: true,
    maxUpvotesPerSession: 1,
    targetSubreddits: ["mcp"],
    searchQueries: [],
    ingestionListLimit: 5,
    ingestionMaxOwnThreadReads: 0,
    ingestionMaxDiscoveryThreadReads: 0,
    ingestionOwnThreadCommentLimit: 100,
    ingestionMaxSearchesPerSubreddit: 0,
    maxActionsPerSession: 1,
    maxActionsPerDay: 4,
    minJitterMinutes: 10,
    maxJitterMinutes: 20,
    readController: "unofficial",
    dryRunDefault: true,
    memoryPath: "/tmp/reddit-memory.json",
    ...overrides
  };
}

test("resolveUpvoteTargetForPlannedAction picks comment fullname for replies", () => {
  const item = createReviewItem();
  const target = resolveUpvoteTargetForPlannedAction(createPlanned("reply_to_comment", item));
  assert.equal(target.thingId, "t1_abc");
  assert.equal(target.targetKind, "comment");
});

test("resolveUpvoteTargetForPlannedAction picks post fullname for top-level comments", () => {
  const item = createReviewItem({ id: "post1", kind: "post", threadPostId: "post1" });
  const target = resolveUpvoteTargetForPlannedAction(createPlanned("comment_on_post", item));
  assert.equal(target.thingId, "t3_post1");
  assert.equal(target.targetKind, "post");
});

test("findThreadSnapshotForSource matches thread post id", () => {
  const item = createReviewItem();
  const snapshot = findThreadSnapshotForSource(
    [
      {
        thread: {
          id: "post1",
          subreddit: "mcp",
          title: "Thread",
          comments: [],
          locked: true
        },
        source: "unofficial",
        capturedAt: new Date().toISOString()
      }
    ],
    item.source
  );
  assert.equal(snapshot?.thread.locked, true);
});

test("tryUpvoteBeforeReply skips unsupported controllers without publishing", async () => {
  const plannedAction = createPlanned("reply_to_comment", createReviewItem());
  let published = false;
  const result = await tryUpvoteBeforeReply({
    config: createConfig("reddapi"),
    operating: createOperating(),
    plannedAction,
    memory: {
      generatedAt: new Date().toISOString(),
      history: [],
      queuedJobs: [],
      scanLedger: [],
      upvotedThingIds: []
    },
    ingestion: { snapshots: [] },
    dryRun: false,
    now: new Date("2026-05-20T10:00:00.000Z"),
    publishAction: async () => {
      published = true;
      throw new Error("should not publish");
    }
  });

  assert.equal(published, false);
  assert.equal(result.attempted, false);
  assert.match(result.skipped[0] ?? "", /reddapi controller does not support voting/);
});

test("tryUpvoteBeforeReply skips when max upvotes is zero", async () => {
  const plannedAction = createPlanned("reply_to_comment", createReviewItem());
  let published = false;
  const result = await tryUpvoteBeforeReply({
    config: createConfig("unofficial"),
    operating: createOperating({ maxUpvotesPerSession: 0 }),
    plannedAction,
    memory: {
      generatedAt: new Date().toISOString(),
      history: [],
      queuedJobs: [],
      scanLedger: [],
      upvotedThingIds: []
    },
    ingestion: { snapshots: [] },
    dryRun: false,
    now: new Date("2026-05-20T10:00:00.000Z"),
    publishAction: async () => {
      published = true;
      throw new Error("should not publish");
    }
  });

  assert.equal(published, false);
  assert.equal(result.attempted, false);
  assert.match(result.skipped[0] ?? "", /MAX_UPVOTES_PER_SESSION is 0/);
});
