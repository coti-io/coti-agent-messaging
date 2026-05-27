import test from "node:test";
import assert from "node:assert/strict";

import { draftRedditResponse } from "../src/reddit-drafting.js";
import { DEFAULT_REDDIT_TARGETING, type RedditReviewItem } from "../src/reddit-outreach.js";
import type { MoltbookRuntimeConfig } from "../src/config.js";

function createConfig(): MoltbookRuntimeConfig {
  const packageRoot = "/tmp/outreach-agent";
  return {
    packageRoot,
    projectRoot: packageRoot,
    credentialsPath: "/tmp/credentials.json",
    statePath: "/tmp/state.json",
    heartbeatReportPath: "/tmp/heartbeat.json",
    moltbookBaseUrl: "https://www.moltbook.com/api/v1",
    defaultSubmolt: "general",
    dryRun: true,
    autoVerify: false
  };
}

function createReviewItem(): RedditReviewItem {
  return {
    id: "comment-1",
    source: {
      id: "comment-1",
      kind: "comment",
      subreddit: "AI_Agents",
      title: "Agent messaging between services",
      parentTitle: "Agent messaging between services",
      body: "How do you handle private agent-to-agent messaging when tools need encrypted coordination?",
      onOwnThread: false,
      threadPostId: "post-1"
    },
    action: "answer_publicly",
    status: "needs_human_review",
    relevanceScore: 8,
    riskScore: 1,
    draft: undefined,
    explicitProductInterest: false,
    privateMessageAssessment: {
      shouldEscalate: false,
      requiresPublicReplyFirst: false,
      explanation: "No escalation."
    },
    publicValueDeliveredFirst: true,
    whyRelevant: "agent messaging",
    gates: [],
    approvalRequired: true,
    approvalChecklist: []
  };
}

test("draftRedditResponse without LLM produces valid brief hook-style reddit draft", async () => {
  const draft = await draftRedditResponse({
    config: createConfig(),
    item: createReviewItem(),
    targeting: DEFAULT_REDDIT_TARGETING,
    actionType: "comment_on_post",
    promptParameterOverrides: {
      responseLength: "brief",
      layout: "short_hook_then_detail",
      humor: "none"
    }
  });

  assert.ok(draft.content.length > 0);
  assert.equal(draft.promptParameters.responseLength, "brief");
  assert.equal(draft.promptParameters.layout, "short_hook_then_detail");
  assert.match(draft.content, /^Fair point\./);
});
