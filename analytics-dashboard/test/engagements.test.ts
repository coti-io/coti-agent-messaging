import test from "node:test";
import assert from "node:assert/strict";

import { aggregateEngagementSummaries, summarizeEngagements } from "../src/engagements";

test("summarizeEngagements reports rolling windows and totals", () => {
  const now = new Date("2026-05-04T12:00:00.000Z");
  const summary = summarizeEngagements(
    {
      engagementEvents: [
        { type: "post", createdAt: "2026-05-04T11:30:00.000Z" },
        { type: "comment", createdAt: "2026-05-03T13:00:00.000Z" },
        { type: "reply", createdAt: "2026-04-30T12:00:00.000Z" },
        { type: "follow", createdAt: "2026-04-01T12:00:00.000Z" }
      ],
      engagementTotals: {
        posts: 2,
        comments: 3,
        replies: 4,
        upvotes: 5,
        follows: 6
      }
    },
    now
  );

  assert.equal(summary.windows.last2Hours.total, 1);
  assert.equal(summary.windows.lastDay.total, 2);
  assert.equal(summary.windows.lastWeek.total, 3);
  assert.deepEqual(summary.total, {
    posts: 2,
    comments: 3,
    replies: 4,
    upvotes: 5,
    follows: 6,
    total: 20
  });
});

test("aggregateEngagementSummaries sums all windows", () => {
  const now = new Date("2026-05-04T12:00:00.000Z");
  const first = summarizeEngagements(
    {
      engagementEvents: [{ type: "post", createdAt: "2026-05-04T11:30:00.000Z" }],
      engagementTotals: { posts: 1 }
    },
    now
  );
  const second = summarizeEngagements(
    {
      engagementEvents: [{ type: "reply", createdAt: "2026-05-04T11:40:00.000Z" }],
      engagementTotals: { replies: 2 }
    },
    now
  );

  const aggregate = aggregateEngagementSummaries([first, second], now);

  assert.equal(aggregate.windows.last2Hours.posts, 1);
  assert.equal(aggregate.windows.last2Hours.replies, 1);
  assert.equal(aggregate.windows.last2Hours.total, 2);
  assert.equal(aggregate.total.posts, 1);
  assert.equal(aggregate.total.replies, 2);
  assert.equal(aggregate.total.total, 3);
});
