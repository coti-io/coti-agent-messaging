import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRedditActionCandidates,
  chooseRedditActionBundle
} from "../src/reddit-action-planning.js";
import type { RedditPlannerResult } from "../src/reddit-policy.js";

const planner: RedditPlannerResult = {
  action: {
    type: "reply_to_comment",
    item: {
      id: "item-1",
      source: {
        id: "comment-1",
        kind: "comment",
        subreddit: "sales",
        title: "CRM mess",
        body: "Manual handoffs keep breaking.",
        commentCount: 12,
        score: 9,
        createdUtc: Date.now() / 1000
      },
      relevanceScore: 8,
      riskScore: 1,
      whyRelevant: "direct operational pain",
      draft: "answer publicly",
      status: "needs_human_review",
      explicitProductInterest: false,
      privateMessageAssessment: {
        shouldEscalate: false,
        requiresPublicReplyFirst: true,
        explanation: "public answer is enough"
      },
      publicValueDeliveredFirst: false,
      gates: [],
      action: "answer_publicly"
      ,
      approvalRequired: true,
      approvalChecklist: []
    },
    reason: "reply-worthy comment; direct operational pain",
    score: 43,
    nextEligibleAt: new Date().toISOString()
  },
  plannedCandidates: [
    {
      type: "reply_to_comment",
      item: {
        id: "item-1",
        source: {
          id: "comment-1",
          kind: "comment",
          subreddit: "sales",
          title: "CRM mess",
          body: "Manual handoffs keep breaking.",
          commentCount: 12,
          score: 9,
          createdUtc: Date.now() / 1000
        },
        relevanceScore: 8,
        riskScore: 1,
        whyRelevant: "direct operational pain",
        draft: "answer publicly",
        status: "needs_human_review",
        explicitProductInterest: false,
        privateMessageAssessment: {
          shouldEscalate: false,
          requiresPublicReplyFirst: true,
          explanation: "public answer is enough"
        },
        publicValueDeliveredFirst: false,
        gates: [],
        action: "answer_publicly"
        ,
        approvalRequired: true,
        approvalChecklist: []
      },
      reason: "reply-worthy comment; direct operational pain",
      score: 43,
      nextEligibleAt: new Date().toISOString()
    }
  ],
  skipped: [],
  candidates: [
    {
      id: "item-1",
      type: "reply_to_comment",
      score: 43,
      reason: "reply-worthy comment; direct operational pain"
    }
  ]
};

test("reddit action planning builds shared candidates from planner output", () => {
  const candidates = buildRedditActionCandidates(planner);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.type, "reply_to_activity");
  assert.equal(candidates[0]?.source, "hot_thread");
  assert.equal(candidates[0]?.targetId, "comment-1");
});

test("reddit action planning selects at most one safe action", () => {
  const candidates = buildRedditActionCandidates(planner);
  const bundle = chooseRedditActionBundle(candidates, 3);
  assert.deepEqual(bundle.selectedCandidateIds, ["item-1"]);
  assert.equal(bundle.selectedWriteCandidateId, "item-1");
  assert.equal(bundle.strategy, "deterministic_fallback");
});
