import test from "node:test";
import assert from "node:assert/strict";

import {
  backfillRecentPostArtifacts,
  isMoltbookPostModerationFailure,
  MOLTBOOK_SPAM_PAUSE_MS,
  syncMoltbookAccountHealth
} from "../src/moltbook-account-health.js";
import { createInitialState, getPostReadiness } from "../src/policy.js";
import type { MoltbookRuntimeConfig } from "../src/config.js";

function createConfig(): MoltbookRuntimeConfig {
  return {
    packageRoot: "/tmp/outreach-agent",
    projectRoot: "/tmp",
    credentialsPath: "/tmp/credentials.json",
    statePath: "/tmp/state.json",
    heartbeatReportPath: "/tmp/heartbeat.json",
    promptRotationStatePath: "/tmp/prompt-rotation.json",
    moltbookBaseUrl: "https://www.moltbook.com/api/v1",
    defaultSubmolt: "general",
    dryRun: true,
    autoVerify: false
  };
}

test("isMoltbookPostModerationFailure detects spam and failed verification", () => {
  assert.equal(isMoltbookPostModerationFailure({ is_spam: true }), true);
  assert.equal(isMoltbookPostModerationFailure({ verification_status: "failed" }), true);
  assert.equal(isMoltbookPostModerationFailure({ verification_status: "verified" }), false);
});

test("backfillRecentPostArtifacts adds missing recent posts without duplicates", () => {
  const state = createInitialState();
  state.recentGeneratedArtifacts = [
    {
      id: "post-1",
      type: "post",
      title: "Existing",
      content: "Already tracked",
      createdAt: "2026-05-19T08:00:00.000Z"
    }
  ];

  const next = backfillRecentPostArtifacts(state, [
    {
      id: "post-1",
      title: "Existing",
      content: "Already tracked",
      created_at: "2026-05-19T08:00:00.000Z"
    },
    {
      id: "post-2",
      title: "Fresh post",
      content: "New dedupe memory",
      created_at: "2026-05-19T09:00:00.000Z"
    }
  ]);

  assert.equal(next.recentGeneratedArtifacts.length, 2);
  assert.equal(next.recentGeneratedArtifacts[1]?.id, "post-2");
  assert.equal(next.recentGeneratedArtifacts[1]?.content, "New dedupe memory");
});

test("syncMoltbookAccountHealth pauses create_post after spam and records moderation once", async () => {
  const now = new Date("2026-05-19T12:00:00.000Z");
  const config = createConfig();
  const state = createInitialState();
  state.recentGeneratedArtifacts = [
    {
      id: "post-spam",
      type: "post",
      title: "Spammy title",
      content: "Repeated thesis",
      promptVariantId: "operator-problem-solution",
      createdAt: "2026-05-19T11:00:00.000Z"
    }
  ];

  const first = await syncMoltbookAccountHealth({
    state,
    agentName: "signalfoundry",
    config,
    getAgentProfile: async () => ({
      recentPosts: [
        {
          id: "post-spam",
          title: "Spammy title",
          content: "Repeated thesis",
          is_spam: true,
          created_at: "2026-05-19T11:00:00.000Z"
        }
      ]
    }),
    now
  });

  assert.equal(first.changed, true);
  assert.equal(first.newlyFlaggedPosts.length, 1);
  assert.equal(first.state.outboundPostPauseReason, "spam");
  assert.deepEqual(first.state.moltbookProcessedModerationPostIds, ["post-spam"]);
  assert.equal(
    Date.parse(first.state.outboundPostPauseUntil ?? ""),
    now.getTime() + MOLTBOOK_SPAM_PAUSE_MS
  );
  assert.equal(getPostReadiness(first.state, false, undefined, now).allowed, false);

  const second = await syncMoltbookAccountHealth({
    state: first.state,
    agentName: "signalfoundry",
    config,
    getAgentProfile: async () => ({
      recentPosts: [
        {
          id: "post-spam",
          title: "Spammy title",
          content: "Repeated thesis",
          is_spam: true,
          created_at: "2026-05-19T11:00:00.000Z"
        }
      ]
    }),
    now
  });

  assert.equal(second.changed, false);
  assert.equal(second.newlyFlaggedPosts.length, 0);
});
