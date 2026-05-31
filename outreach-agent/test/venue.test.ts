import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { getOutreachAgentConfig, loadRuntimeConfig, type MoltbookRuntimeConfig } from "../src/config.js";
import { MoltbookVenueProvider } from "../src/moltbook-venue.js";
import type { MoltbookApiClient } from "../src/moltbook-api.js";
import type { RedditController } from "../src/reddit-controller.js";
import { RedditVenueProvider } from "../src/reddit-venue.js";
import { createVenueProvider } from "../src/venue-factory.js";

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
        baseUrl: "https://oauth.reddit.test"
      },
      reddapi: {
        rapidApiKey: "rapid-key",
        proxy: "http://proxy.test:3128",
        storageStatePath: path.join(os.tmpdir(), "reddit-storage-state.json"),
        rapidApiHost: "reddapi.test"
      }
    },
    agent: {
      venue: "moltbook",
      venueAccountId: "OutreachBot",
      allowedSurfaces: ["general"],
      mode: "approved_autopost",
      policyProfileId: "moltbook-default",
      promptProfileId: "technical",
      attributionCampaignId: "private_messaging"
    },
    ...overrides
  };
}

test("venue-aware config fails closed when venue is required but missing", async () => {
  const previousVenue = process.env.OUTREACH_AGENT_VENUE;
  const previousPrivateKey = process.env.PRIVATE_KEY;

  try {
    delete process.env.OUTREACH_AGENT_VENUE;
    delete process.env.PRIVATE_KEY;
    await assert.rejects(
      () => loadRuntimeConfig({ requireVenue: true }),
      /Missing outreach venue/
    );
  } finally {
    if (previousVenue === undefined) {
      delete process.env.OUTREACH_AGENT_VENUE;
    } else {
      process.env.OUTREACH_AGENT_VENUE = previousVenue;
    }
    if (previousPrivateKey === undefined) {
      delete process.env.PRIVATE_KEY;
    } else {
      process.env.PRIVATE_KEY = previousPrivateKey;
    }
  }
});

test("legacy Moltbook runtime config resolves to a default venue config", () => {
  const config = createConfig({ agent: undefined });
  const agent = getOutreachAgentConfig(config);

  assert.equal(agent.venue, "moltbook");
  assert.equal(agent.mode, "approved_autopost");
  assert.deepEqual(agent.allowedSurfaces, ["general"]);
});

test("Moltbook venue provider maps feed data into neutral candidates", async () => {
  const fakeApi = {
    async getHome() {
      return {
        your_account: { name: "OutreachBot" },
        activity_on_your_posts: [
          {
            post_id: "post-1",
            post_title: "Private agent inboxes",
            new_notification_count: 2,
            preview: "new reply"
          }
        ]
      };
    },
    async getFeed() {
      return {
        posts: [
          {
            id: "post-2",
            title: "Agent coordination",
            content_preview: "Coordination is hard",
            author_name: "builder",
            upvotes: 4
          }
        ]
      };
    }
  } as unknown as MoltbookApiClient;
  const provider = new MoltbookVenueProvider(createConfig(), fakeApi);
  const candidates = await provider.listCandidates();

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]?.venue, "moltbook");
  assert.equal(candidates[0]?.kind, "thread");
  assert.equal(candidates[1]?.kind, "post");
});

test("Moltbook venue provider delegates publish actions through the API", async () => {
  const calls: string[] = [];
  const fakeApi = {
    async createComment(postId: string, body: { content: string; parent_id?: string }) {
      calls.push(`comment:${postId}:${body.parent_id ?? "root"}:${body.content}`);
      return {
        comment: {
          id: "comment-42",
          post_id: postId,
          content: body.content
        }
      };
    }
  } as unknown as MoltbookApiClient;
  const provider = new MoltbookVenueProvider(createConfig(), fakeApi);

  const outcome = await provider.publishAction({
    id: "reply:post-1:comment-1",
    venue: "moltbook",
    type: "reply_to_comment",
    parentId: "post-1",
    candidateId: "comment-1",
    content: "Useful reply."
  });

  assert.deepEqual(calls, ["comment:post-1:comment-1:Useful reply."]);
  assert.equal(outcome.type, "posted");
  assert.equal(outcome.remoteContentId, "comment-42");
  assert.equal(outcome.remoteContentUrl, "https://www.moltbook.com/post/post-1");
});

test("Reddit venue provider returns review candidates and refuses publishing", async () => {
  const provider = new RedditVenueProvider({
    venue: "reddit",
    venueAccountId: "reddit-user",
    allowedSurfaces: ["AI_Agents"],
    mode: "human_review",
    policyProfileId: "reddit-read-only"
  });
  const queue = provider.buildReviewQueue({
    items: [
      {
        id: "thing-1",
        kind: "post",
        subreddit: "AI_Agents",
        title: "How should agents coordinate privately?",
        body: "Looking for practical ideas for agent coordination.",
        score: 4,
        commentCount: 3
      }
    ]
  });
  const candidates = provider.reviewQueueToCandidates(queue);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.venue, "reddit");
  assert.equal(candidates[0]?.kind, "review_item");
  await assert.rejects(
    () =>
      provider.publishAction({
        id: "publish-1",
        venue: "reddit",
        type: "comment_on_post",
        content: "Nope."
      }),
    /not configured for autopublish/
  );
});

test("Reddit venue provider delegates publish to the selected controller", async () => {
  const calls: string[] = [];
  const controller: RedditController = {
    id: "browser",
    async publishAction(action, context) {
      calls.push(`${action.type}:${context.venueAccountId}:${context.allowedSurfaces.join(",")}`);
      return {
        remoteContentId: "t1_reply42",
        remoteContentUrl: "https://www.reddit.com/r/AI_Agents/comments/thread/reply42/"
      };
    }
  };
  const provider = new RedditVenueProvider(
    {
      venue: "reddit",
      venueAccountId: "reddit-user",
      allowedSurfaces: ["AI_Agents"],
      mode: "approved_autopost",
      policyProfileId: "reddit-browser"
    },
    controller
  );

  const outcome = await provider.publishAction({
    id: "reply-1",
    venue: "reddit",
    type: "reply_to_comment",
    candidateId: "comment-1",
    content: "Useful reply."
  });

  assert.deepEqual(calls, ["reply_to_comment:reddit-user:AI_Agents"]);
  assert.equal(outcome.type, "replied");
  assert.equal(outcome.remoteContentId, "t1_reply42");
});

test("Reddit venue provider blocks product mentions and links before controller publish", async () => {
  let called = false;
  const controller: RedditController = {
    id: "browser",
    async publishAction() {
      called = true;
      return {};
    }
  };
  const provider = new RedditVenueProvider(
    {
      venue: "reddit",
      venueAccountId: "reddit-user",
      allowedSurfaces: ["AI_Agents"],
      mode: "approved_autopost",
      policyProfileId: "reddit-browser"
    },
    controller
  );

  await assert.rejects(
    () =>
      provider.publishAction({
        id: "comment-1",
        venue: "reddit",
        type: "comment_on_post",
        parentId: "post-1",
        content: "COTI can help, sign up here: https://example.com"
      }),
    /forbidden|must not/i
  );
  assert.equal(called, false);
});

test("createVenueProvider returns a reddit provider for reddit config", () => {
  const venue = createVenueProvider(
    createConfig({
      agent: {
        venue: "reddit",
        venueAccountId: "reddit-user",
        allowedSurfaces: ["AI_Agents"],
        mode: "approved_autopost",
        policyProfileId: "reddit-browser"
      },
      reddit: {
        controller: "manual",
        browserBridge: {
          bridgeDir: path.join(os.tmpdir(), "outreach-agent-test-reddit-browser"),
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
      }
    })
  );

  assert.equal(venue.id, "reddit");
});
