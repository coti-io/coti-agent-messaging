import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REDDIT_PLANNER_CONFIG,
  jitterDelayMs,
  planRedditAction
} from "../src/reddit-policy.js";
import { validateRedditDraft } from "../src/reddit-drafting.js";
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
  assert.doesNotThrow(() =>
    validateRedditDraft(
      "The part that usually breaks is ownership. If two teams can edit the same CRM fields without a clear owner, automation just spreads bad data faster. Lock ownership first, then add audits around every automated write.",
      [],
      "short_hook_then_detail"
    )
  );
  assert.throws(() => validateRedditDraft("Good point.", [], "short_hook_then_detail"), /fluff|substance/i);
});
