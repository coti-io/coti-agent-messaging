import type { ActionConstraint, ConstrainedActionCandidate } from "../action-planning.js";
import type { RedditDecisionMemoryEntry } from "../reddit-memory.js";
import type { PromptParameterSet } from "../prompt-profile.js";
import { redditMemoryEntryCountsTowardPublishedLimits } from "../reddit-evaluation.js";

export function findKillSwitch(history: readonly RedditDecisionMemoryEntry[]): string | undefined {
  const recent = history.slice(-50);
  if (recent.some((entry) => entry.status === "banned")) {
    return "Kill switch: a ban was recorded in Reddit memory.";
  }
  if (recent.filter((entry) => entry.status === "spam_accusation").length > 0) {
    return "Kill switch: spam accusation recorded in Reddit memory.";
  }
  if (recent.filter((entry) => entry.status === "removed" || entry.status === "mod_warning").length >= 2) {
    return "Kill switch: repeated removals or mod warnings recorded in Reddit memory.";
  }
  return undefined;
}

export function findDailyActionLimitReason(
  history: readonly RedditDecisionMemoryEntry[],
  maxActionsPerDay: number,
  now: Date
): string | undefined {
  if (maxActionsPerDay < 1) {
    return "Reddit session daily action cap is set to zero.";
  }
  const today = now.toISOString().slice(0, 10);
  const postedToday = history.filter((entry) => {
    if (!redditMemoryEntryCountsTowardPublishedLimits(entry)) {
      return false;
    }
    return entry.createdAt.slice(0, 10) === today;
  }).length;
  return postedToday >= maxActionsPerDay
    ? `Daily Reddit action cap reached (${postedToday}/${maxActionsPerDay}).`
    : undefined;
}

export function findSessionCooldownReason(
  history: readonly RedditDecisionMemoryEntry[],
  now: Date
): string | undefined {
  const recent = [...history]
    .filter((entry) => redditMemoryEntryCountsTowardPublishedLimits(entry))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  if (!recent?.nextEligibleAt) {
    return undefined;
  }
  const nextEligibleAt = Date.parse(recent.nextEligibleAt);
  if (Number.isNaN(nextEligibleAt) || nextEligibleAt <= now.getTime()) {
    return undefined;
  }
  const waitMinutes = Math.max(1, Math.ceil((nextEligibleAt - now.getTime()) / 60_000));
  return `Reddit session cooldown active for about ${waitMinutes} more minute${waitMinutes === 1 ? "" : "s"}.`;
}

export function findRedditSubredditCooldowns(
  history: readonly RedditDecisionMemoryEntry[],
  now: Date
): Map<string, { subreddit: string; until: string; reason: string }> {
  const recentWindowMs = 72 * 60 * 60 * 1_000;
  const pauseMs = 12 * 60 * 60 * 1_000;
  const bySubreddit = new Map<string, RedditDecisionMemoryEntry[]>();
  for (const entry of history) {
    if (entry.status !== "spam_filtered") {
      continue;
    }
    const createdAt = Date.parse(entry.createdAt);
    if (Number.isNaN(createdAt) || now.getTime() - createdAt > recentWindowMs) {
      continue;
    }
    const key = entry.subreddit.trim().toLowerCase();
    if (!key) {
      continue;
    }
    const existing = bySubreddit.get(key) ?? [];
    existing.push(entry);
    bySubreddit.set(key, existing);
  }

  const pauses = new Map<string, { subreddit: string; until: string; reason: string }>();
  for (const [key, entries] of bySubreddit.entries()) {
    if (entries.length < 2) {
      continue;
    }
    const latest = entries
      .map((entry) => ({ entry, timestamp: Date.parse(entry.createdAt) }))
      .filter((row) => !Number.isNaN(row.timestamp))
      .sort((left, right) => right.timestamp - left.timestamp)[0];
    if (!latest) {
      continue;
    }
    const untilTs = latest.timestamp + pauseMs;
    if (untilTs <= now.getTime()) {
      continue;
    }
    pauses.set(key, {
      subreddit: entries[0]?.subreddit ?? key,
      until: new Date(untilTs).toISOString(),
      reason: `Subreddit pause for ${entries[0]?.subreddit ?? key}: repeated hidden comments detected.`
    });
  }
  return pauses;
}

export function applySubredditCooldownsToCandidates(
  candidates: readonly ConstrainedActionCandidate[],
  cooldowns: ReadonlyMap<string, { subreddit: string; until: string; reason: string }>
): ConstrainedActionCandidate[] {
  return candidates.map((candidate) => {
    const surface = candidate.surface?.trim().toLowerCase();
    if (!surface) {
      return candidate;
    }
    const cooldown = cooldowns.get(surface);
    if (!cooldown) {
      return candidate;
    }
    const constraint: ActionConstraint = {
      id: "subreddit_pause_hidden_comments",
      passed: false,
      severity: "block",
      reason: cooldown.reason
    };
    return {
      ...candidate,
      allowed: false,
      constraints: [...candidate.constraints, constraint]
    };
  });
}

export function summarizeRedditSubredditCooldowns(
  cooldowns: ReadonlyMap<string, { subreddit: string; until: string; reason: string }>,
  now: Date
): string[] {
  return [...cooldowns.values()]
    .sort((left, right) => left.subreddit.localeCompare(right.subreddit))
    .map((cooldown) => {
      const waitMinutes = Math.max(1, Math.ceil((Date.parse(cooldown.until) - now.getTime()) / 60_000));
      return `${cooldown.reason} Cooldown active for about ${waitMinutes} more minute${waitMinutes === 1 ? "" : "s"}.`;
    });
}

export function resolveAdaptiveRedditPromptOverrides(
  history: readonly RedditDecisionMemoryEntry[],
  subreddit: string,
  now: Date
): Partial<PromptParameterSet> {
  const windowMs = 7 * 24 * 60 * 60 * 1_000;
  const hiddenCount = history.filter((entry) => {
    if (entry.status !== "spam_filtered") {
      return false;
    }
    if (entry.subreddit.trim().toLowerCase() !== subreddit.trim().toLowerCase()) {
      return false;
    }
    const createdAt = Date.parse(entry.createdAt);
    return !Number.isNaN(createdAt) && now.getTime() - createdAt <= windowMs;
  }).length;
  if (hiddenCount < 1) {
    return {};
  }
  return {
    messageStyle: "informative",
    layout: "regular_paragraph",
    tone: "operator",
    technicalDepth: "simple",
    responseLength: "brief",
    creativity: "conservative",
    humor: "none",
    aggression: "low"
  };
}
