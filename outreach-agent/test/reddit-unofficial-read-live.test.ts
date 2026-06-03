import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { buildRedditControllerConfig, type MoltbookRuntimeConfig } from "../src/config.js";
import { ingestRedditState } from "../src/reddit-ingestion.js";
import {
  buildUnofficialRedditRuntimeConfig,
  RedditUnofficialClient
} from "../src/reddit-unofficial.js";

const LIVE = process.env.OUTREACH_REDDIT_UNOFFICIAL_LIVE === "1";

function liveClient(): RedditUnofficialClient {
  const config = buildUnofficialRedditRuntimeConfig();
  return new RedditUnofficialClient({
    storageStatePath: config.storageStatePath,
    publicBaseUrl: config.publicBaseUrl,
    oauthBaseUrl: config.oauthBaseUrl,
    userAgent: config.userAgent
  });
}

test(
  "unofficial live search reads Reddit via oauth bearer",
  { skip: LIVE ? false : "set OUTREACH_REDDIT_UNOFFICIAL_LIVE=1 to run network read tests" },
  async () => {
    const client = liveClient();
    const results = await client.searchPosts("hello", { subreddit: "test", limit: 5 });

    assert.ok(results.length > 0, "expected at least one search result from r/test");
    const first = results[0]!;
    assert.equal(first.subreddit.toLowerCase(), "test");
    assert.ok(first.id.length > 0);
    assert.ok(first.title.length > 0);
    assert.ok(first.url?.includes("/r/test/comments/"));
  }
);

test(
  "unofficial live scrapeThread reads post title and comment tree",
  { skip: LIVE ? false : "set OUTREACH_REDDIT_UNOFFICIAL_LIVE=1 to run network read tests" },
  async () => {
    const client = liveClient();
    const results = await client.searchPosts("hello", { subreddit: "test", limit: 1 });
    assert.ok(results[0]?.url, "need a thread URL from search");

    const thread = await client.scrapeThread(results[0]!.url!);

    assert.equal(thread.subreddit.toLowerCase(), "test");
    assert.ok(thread.id.length > 0);
    assert.ok(thread.title.length > 0);
    assert.ok(Array.isArray(thread.comments));
    if (thread.comments.length > 0) {
      const comment = thread.comments[0]!;
      assert.ok(comment.id.length > 0);
      assert.ok(comment.body.length > 0);
      assert.ok(comment.parentId?.startsWith("t3_") || comment.parentId?.startsWith("t1_"));
    }
  }
);

test(
  "unofficial live hot listing returns valid posts",
  { skip: LIVE ? false : "set OUTREACH_REDDIT_UNOFFICIAL_LIVE=1 to run network read tests" },
  async () => {
    const client = liveClient();
    const results = await client.listSubredditPosts("AI_Agents", { sort: "hot", limit: 5 });

    assert.ok(results.length > 0, "expected hot posts from r/AI_Agents");
    const first = results[0]!;
    assert.equal(first.subreddit.toLowerCase(), "ai_agents");
    assert.ok(first.id.length > 0);
    assert.ok(first.title.length > 0);
    assert.ok(first.url?.includes("/r/AI_Agents/comments/"));
  }
);

test(
  "unofficial live ingestion uses hot listing when search disabled",
  { skip: LIVE ? false : "set OUTREACH_REDDIT_UNOFFICIAL_LIVE=1 to run network read tests" },
  async () => {
    const packageRoot = path.resolve(import.meta.dirname, "..");
    const unofficialConfig = buildRedditControllerConfig(packageRoot);
    const config: MoltbookRuntimeConfig = {
      packageRoot,
      projectRoot: path.resolve(packageRoot, ".."),
      credentialsPath: path.join(packageRoot, ".runtime", "test-credentials.json"),
      statePath: path.join(packageRoot, ".runtime", "test-state.json"),
      heartbeatReportPath: path.join(packageRoot, ".runtime", "test-heartbeat.json"),
      moltbookBaseUrl: "https://www.moltbook.com/api/v1",
      defaultSubmolt: "general",
      dryRun: true,
      autoVerify: false,
      reddit: {
        ...unofficialConfig,
        controller: "unofficial"
      },
      redditOperating: {
        discoverySubredditPool: ["AI_Agents"],
        discoverySubsPerRun: 1,
        scanLedgerTtlHours: 48,
        scanLedgerMaxEntries: 2000,
        llmTriageEnabled: false,
        llmTriageMaxItems: 25,
        llmSelectEnabled: false,
        upvoteEnabled: false,
        upvoteBeforeReply: false,
        maxUpvotesPerSession: 1,
        targetSubreddits: ["AI_Agents"],
        searchQueries: ["unused"],
        ingestionListLimit: 5,
        ingestionMaxOwnThreadReads: 0,
        ingestionMaxDiscoveryThreadReads: 1,
        ingestionOwnThreadCommentLimit: 25,
        ingestionMaxSearchesPerSubreddit: 0,
        maxActionsPerSession: 1,
        maxActionsPerDay: 4,
        minJitterMinutes: 0,
        maxJitterMinutes: 0,
        readController: "unofficial",
        dryRunDefault: true,
        memoryPath: path.join(packageRoot, ".runtime", "reddit-memory-live-hot.json")
      }
    };

    const ingestion = await ingestRedditState({
      config,
      source: "unofficial",
      subreddits: ["AI_Agents"],
      queries: ["unused"],
      maxDiscoveryThreadReads: 1,
      maxSearchesPerSubreddit: 0,
      discoverySeed: 7
    });

    assert.equal(ingestion.diagnostics.readViaUnofficial, true);
    assert.ok(ingestion.diagnostics.discoveryListingSorts.length > 0);
    assert.ok(ingestion.snapshots.length >= 1);
    assert.equal(ingestion.snapshots[0]?.thread.subreddit.toLowerCase(), "ai_agents");
  }
);

test(
  "unofficial live ingestion produces snapshots via ingestRedditState",
  { skip: LIVE ? false : "set OUTREACH_REDDIT_UNOFFICIAL_LIVE=1 to run network read tests" },
  async () => {
    const packageRoot = path.resolve(import.meta.dirname, "..");
    const unofficialConfig = buildRedditControllerConfig(packageRoot);
    const config: MoltbookRuntimeConfig = {
      packageRoot,
      projectRoot: path.resolve(packageRoot, ".."),
      credentialsPath: path.join(packageRoot, ".runtime", "test-credentials.json"),
      statePath: path.join(packageRoot, ".runtime", "test-state.json"),
      heartbeatReportPath: path.join(packageRoot, ".runtime", "test-heartbeat.json"),
      moltbookBaseUrl: "https://www.moltbook.com/api/v1",
      defaultSubmolt: "general",
      dryRun: true,
      autoVerify: false,
      reddit: {
        ...unofficialConfig,
        controller: "unofficial"
      },
      redditOperating: {
        discoverySubredditPool: ["test"],
        discoverySubsPerRun: 1,
        scanLedgerTtlHours: 48,
        scanLedgerMaxEntries: 2000,
        llmTriageEnabled: false,
        llmTriageMaxItems: 25,
        llmSelectEnabled: false,
        upvoteEnabled: false,
        upvoteBeforeReply: false,
        maxUpvotesPerSession: 1,
        targetSubreddits: ["test"],
        searchQueries: ["hello"],
        ingestionListLimit: 3,
        ingestionMaxOwnThreadReads: 0,
        ingestionMaxDiscoveryThreadReads: 1,
        ingestionOwnThreadCommentLimit: 25,
        ingestionMaxSearchesPerSubreddit: 1,
        maxActionsPerSession: 1,
        maxActionsPerDay: 4,
        minJitterMinutes: 0,
        maxJitterMinutes: 0,
        readController: "unofficial",
        dryRunDefault: true,
        memoryPath: path.join(packageRoot, ".runtime", "reddit-memory-live-read.json")
      }
    };

    const ingestion = await ingestRedditState({
      config,
      source: "unofficial",
      subreddits: ["test"],
      queries: ["hello"],
      maxDiscoveryThreadReads: 1,
      maxSearchesPerSubreddit: 1,
      discoverySeed: 42
    });

    assert.equal(ingestion.diagnostics.readViaUnofficial, true);
    assert.ok(ingestion.snapshots.length >= 1, `expected snapshots, got ${ingestion.snapshots.length}`);
    assert.ok(ingestion.sourceItems.length >= 1, `expected source items, got ${ingestion.sourceItems.length}`);
    const snapshot = ingestion.snapshots[0]!;
    assert.equal(snapshot.source, "unofficial");
    assert.ok(snapshot.thread.title.length > 0);
  }
);
