import type { EngagementCounts, EngagementSummary } from "./types";

type EngagementEvent = {
  type?: string;
  createdAt?: string;
};

function emptyCounts(): EngagementCounts {
  return {
    posts: 0,
    comments: 0,
    replies: 0,
    upvotes: 0,
    follows: 0,
    total: 0
  };
}

function normalizeCounts(value: unknown): EngagementCounts {
  const source =
    value && typeof value === "object" ? (value as Partial<EngagementCounts>) : {};
  const counts = {
    ...emptyCounts(),
    posts: Number(source.posts ?? 0),
    comments: Number(source.comments ?? 0),
    replies: Number(source.replies ?? 0),
    upvotes: Number(source.upvotes ?? 0),
    follows: Number(source.follows ?? 0)
  };
  counts.total = counts.posts + counts.comments + counts.replies + counts.upvotes + counts.follows;
  return counts;
}

function increment(counts: EngagementCounts, type: string | undefined) {
  switch (type) {
    case "post":
      counts.posts += 1;
      counts.total += 1;
      break;
    case "comment":
      counts.comments += 1;
      counts.total += 1;
      break;
    case "reply":
      counts.replies += 1;
      counts.total += 1;
      break;
    case "upvote":
      counts.upvotes += 1;
      counts.total += 1;
      break;
    case "follow":
      counts.follows += 1;
      counts.total += 1;
      break;
  }
}

function countSince(events: readonly EngagementEvent[], now: Date, durationMs: number): EngagementCounts {
  const counts = emptyCounts();
  const cutoff = now.getTime() - durationMs;
  for (const event of events) {
    if (!event.createdAt) {
      continue;
    }
    const timestamp = Date.parse(event.createdAt);
    if (!Number.isNaN(timestamp) && timestamp >= cutoff) {
      increment(counts, event.type);
    }
  }
  return counts;
}

export function summarizeEngagements(state: Record<string, unknown> | undefined, now = new Date()): EngagementSummary {
  const rawEvents = Array.isArray(state?.engagementEvents)
    ? (state.engagementEvents as EngagementEvent[])
    : [];

  return {
    generatedAt: now.toISOString(),
    windows: {
      last2Hours: countSince(rawEvents, now, 2 * 60 * 60 * 1_000),
      lastDay: countSince(rawEvents, now, 24 * 60 * 60 * 1_000),
      lastWeek: countSince(rawEvents, now, 7 * 24 * 60 * 60 * 1_000)
    },
    total: normalizeCounts(state?.engagementTotals)
  };
}

export function addCounts(left: EngagementCounts, right: EngagementCounts): EngagementCounts {
  return {
    posts: left.posts + right.posts,
    comments: left.comments + right.comments,
    replies: left.replies + right.replies,
    upvotes: left.upvotes + right.upvotes,
    follows: left.follows + right.follows,
    total: left.total + right.total
  };
}

export function aggregateEngagementSummaries(
  summaries: readonly EngagementSummary[],
  now = new Date()
): EngagementSummary {
  return summaries.reduce<EngagementSummary>(
    (aggregate, summary) => ({
      generatedAt: now.toISOString(),
      windows: {
        last2Hours: addCounts(aggregate.windows.last2Hours, summary.windows.last2Hours),
        lastDay: addCounts(aggregate.windows.lastDay, summary.windows.lastDay),
        lastWeek: addCounts(aggregate.windows.lastWeek, summary.windows.lastWeek)
      },
      total: addCounts(aggregate.total, summary.total)
    }),
    {
      generatedAt: now.toISOString(),
      windows: {
        last2Hours: emptyCounts(),
        lastDay: emptyCounts(),
        lastWeek: emptyCounts()
      },
      total: emptyCounts()
    }
  );
}
