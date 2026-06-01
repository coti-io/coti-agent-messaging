import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REDDIT_PLANNER_CONFIG,
  jitterDelayMs,
  planRedditAction,
  scoreRedditReviewItem
} from "../src/reddit-policy.js";
import type { RedditReviewItem } from "../src/reddit-outreach.js";
import { validateRedditDraft } from "../src/reddit-drafting.js";
import { resolvePromptProfile } from "../src/prompt-profile.js";
import type { RedditOutboundMemoryEntry, RedditSourceItem } from "../src/reddit-outreach.js";

const now = new Date("2026-05-19T09:00:00.000Z");

test("reddit planner ranks comment replies above post comments", () => {
  const items: RedditSourceItem[] = [
    {
      id: "post-1",
      kind: "post",
      subreddit: "sales",
      title: "CRM messy data",
      body: "How do you fix duplicate CRM records?",
      createdUtc: now.getTime() / 1000,
      commentCount: 50,
      onOwnThread: true,
      threadPostId: "post-1"
    },
    {
      id: "comment-1",
      kind: "comment",
      subreddit: "sales",
      title: "CRM messy data",
      parentTitle: "CRM messy data",
      body: "We keep breaking sales handoffs with messy CRM fields. Any advice?",
      createdUtc: now.getTime() / 1000,
      commentCount: 5,
      onOwnThread: true,
      threadPostId: "post-1"
    }
  ];

  const plan = planRedditAction({ items, now, rng: () => 0 });
  assert.equal(plan.action?.type, "reply_to_comment");
  assert.equal(plan.action?.item.source.id, "comment-1");
});

test("reddit planner skips posts with a prior dry-run draft on the same thread", () => {
  const history: RedditOutboundMemoryEntry[] = [
    {
      id: "draft:post-1:1",
      decisionId: "post:LocalLLaMA:post-1",
      subreddit: "LocalLLaMA",
      kind: "comment",
      content: "Prior dry-run draft on this thread.",
      createdAt: now.toISOString(),
      targetId: "post-1",
      threadPostId: "post-1",
      status: "drafted",
      firstReply: true
    }
  ];
  const items: RedditSourceItem[] = [
    {
      id: "post-1",
      kind: "post",
      subreddit: "LocalLLaMA",
      title: "Agent inbox routing",
      body: "How do you route agent messages between tools without losing context?",
      createdUtc: now.getTime() / 1000,
      commentCount: 12
    },
    {
      id: "post-2",
      kind: "post",
      subreddit: "LocalLLaMA",
      title: "MCP tool auth",
      body: "What patterns work for MCP auth between agents?",
      createdUtc: now.getTime() / 1000,
      commentCount: 8
    }
  ];

  const plan = planRedditAction({ items, history, now, rng: () => 0 });
  assert.notEqual(plan.action?.item.source.id, "post-1");
});

test("reddit planner skips hostile and already-touched targets", () => {
  const history: RedditOutboundMemoryEntry[] = [
    {
      id: "old-1",
      subreddit: "sales",
      kind: "reply",
      content: "Previous answer",
      createdAt: now.toISOString(),
      targetId: "comment-1",
      firstReply: true,
      status: "posted"
    }
  ];
  const items: RedditSourceItem[] = [
    {
      id: "comment-1",
      kind: "comment",
      subreddit: "sales",
      title: "CRM help",
      body: "How do I fix this manual workflow?",
      createdUtc: now.getTime() / 1000,
      onOwnThread: true,
      threadPostId: "post-1"
    },
    {
      id: "comment-2",
      kind: "comment",
      subreddit: "sales",
      title: "CRM help",
      body: "This whole thing is trash, change my mind. CRM bots are scams.",
      createdUtc: now.getTime() / 1000,
      onOwnThread: true,
      threadPostId: "post-1"
    }
  ];

  const plan = planRedditAction({ items, history, now, rng: () => 0 });
  assert.equal(plan.action, undefined);
  assert.ok(plan.skipped.some((entry) => entry.includes("low_argument_risk")));
});

test("reddit planner does not autopublish threads that need clarification first", () => {
  const items: RedditSourceItem[] = [
    {
      id: "post-clarify",
      kind: "post",
      subreddit: "sales",
      title: "CRM handoff keeps breaking",
      body: "Sales duplicates records and ops cleans spreadsheets every week.",
      createdUtc: now.getTime() / 1000,
      commentCount: 10,
      onOwnThread: true,
      threadPostId: "post-clarify"
    }
  ];

  const plan = planRedditAction({ items, now, rng: () => 0 });
  assert.equal(plan.action, undefined);
  assert.ok(plan.skipped.some((entry) => entry.includes("ask clarifying question")));
});

test("reddit planner exposes filter summary with gate counts", () => {
  const items: RedditSourceItem[] = [
    {
      id: "post-1",
      kind: "post",
      subreddit: "sales",
      title: "Weekly sales update",
      body: "Closed three deals this week.",
      createdUtc: now.getTime() / 1000,
      commentCount: 4
    },
    {
      id: "post-2",
      kind: "post",
      subreddit: "LocalLLaMA",
      title: "How do you route MCP messages between agents?",
      body: "Looking for patterns for private agent messaging between tools.",
      createdUtc: now.getTime() / 1000,
      commentCount: 8
    }
  ];

  const plan = planRedditAction({ items, now, rng: () => 0 });
  assert.equal(plan.filterSummary.sourceItemCount, 2);
  assert.equal(plan.filterSummary.inTargetSubredditCount, 1);
  assert.ok(plan.filterSummary.blockedByGate.length >= 1);
  assert.ok(plan.filterSummary.blockedByGate.some((entry) => entry.count >= 1));
});

test("reddit planner applies deterministic jitter window", () => {
  const delay = jitterDelayMs(
    { ...DEFAULT_REDDIT_PLANNER_CONFIG, minDelayMinutes: 10, maxDelayMinutes: 20 },
    () => 0.5
  );
  assert.equal(delay, 15 * 60_000);
});

test("reddit draft validator blocks links, CTAs, and product names", () => {
  assert.throws(() => validateRedditDraft("Check this out https://example.com", []), /forbidden|links/i);
  assert.throws(() => validateRedditDraft("COTI would solve this.", ["COTI"]), /product/i);
});

test("reddit draft validator allows hook-then-substance but blocks standalone fluff", () => {
  const hookProfile = resolvePromptProfile({
    venue: "reddit",
    actionType: "comment_on_post",
    parameterOverrides: { layout: "short_hook_then_detail" }
  });
  assert.doesNotThrow(() =>
    validateRedditDraft(
      "The part that usually breaks is ownership. If two teams can edit the same CRM fields without a clear owner, automation just spreads bad data faster. Lock ownership first, then add audits around every automated write.",
      [],
      hookProfile
    )
  );
  assert.throws(() => validateRedditDraft("Good point.", [], hookProfile), /fluff|substance/i);
});

test("direct reply to our comment scores higher than generic own-thread comment", () => {
  const reviewBase: Omit<RedditReviewItem, "id" | "source"> = {
    action: "answer_publicly",
    status: "needs_human_review",
    relevanceScore: 5,
    riskScore: 0,
    draft: "Useful operational answer with enough substance to pass gates.",
    explicitProductInterest: false,
    privateMessageAssessment: {
      shouldEscalate: false,
      requiresPublicReplyFirst: false,
      explanation: "No private-message escalation needed."
    },
    publicValueDeliveredFirst: true,
    whyRelevant: "agent messaging thread",
    gates: [],
    approvalRequired: true,
    approvalChecklist: []
  };
  const genericOwnThread: RedditReviewItem = {
    id: "comment-generic",
    ...reviewBase,
    source: {
      id: "comment-generic",
      kind: "comment",
      subreddit: "AI_Agents",
      title: "Agent messaging",
      body: "Anyone else struggling with agent inbox routing between tools?",
      onOwnThread: true,
      threadPostId: "post-1"
    }
  };
  const directReply: RedditReviewItem = {
    ...genericOwnThread,
    id: "comment-direct",
    source: {
      ...genericOwnThread.source,
      id: "comment-direct",
      replyToOurComment: true
    }
  };

  assert.ok(
    scoreRedditReviewItem(directReply, DEFAULT_REDDIT_PLANNER_CONFIG) >
      scoreRedditReviewItem(genericOwnThread, DEFAULT_REDDIT_PLANNER_CONFIG)
  );
});

test("reddit draft validator enforces brief response length", () => {
  const briefProfile = resolvePromptProfile({
    venue: "reddit",
    actionType: "comment_on_post"
  });
  const longDraft = `${"This is a useful operational point. ".repeat(40)}`.trim();
  assert.throws(() => validateRedditDraft(longDraft, [], briefProfile), /length limit/i);
});
