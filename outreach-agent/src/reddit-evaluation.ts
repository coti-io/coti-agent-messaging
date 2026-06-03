import type { RedditOutboundMemoryEntry } from "./reddit-outreach-types.js";

export interface RedditOutcomeSummary {
  generatedAt: string;
  totalOutbound: number;
  postedFirstReplies: number;
  removals: number;
  modWarnings: number;
  spamAccusations: number;
  bans: number;
  firstReplyPromotionViolations: number;
  lowValuePrivateMessagePrompts: number;
  justifiedPrivateMessageEscalations: number;
  removalOrWarningRate: number;
  killReasons: string[];
  successSignals: string[];
}

function containsAnyCta(content: string): boolean {
  return /\b(dm me|message me|check out my|visit my|join my)\b/i.test(content);
}

function containsPrivateMessagePrompt(content: string): boolean {
  return /\b(dm|pm|private message|message me directly)\b/i.test(content);
}

function subredditsWithAtLeast(
  entries: readonly RedditOutboundMemoryEntry[],
  threshold: number
): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.subreddit, (counts.get(entry.subreddit) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= threshold)
    .map(([subreddit]) => subreddit);
}

export function evaluateRedditOutcomes(
  history: readonly RedditOutboundMemoryEntry[],
  now = new Date()
): RedditOutcomeSummary {
  const firstReplies = history.filter((entry) => entry.firstReply);
  const removals = history.filter((entry) => entry.status === "removed" || entry.status === "spam_filtered").length;
  const modWarnings = history.filter((entry) => entry.status === "mod_warning").length;
  const spamAccusations = history.filter((entry) => entry.status === "spam_accusation").length;
  const bans = history.filter((entry) => entry.status === "banned").length;
  const postedFirstReplies = firstReplies.filter((entry) =>
    ["posted", "spam_filtered", "removed", "mod_warning", "spam_accusation", "banned"].includes(entry.status ?? "")
  ).length;
  const firstReplyPromotionViolations = firstReplies.filter(
    (entry) => entry.productMentioned || entry.linkIncluded || containsAnyCta(entry.content)
  ).length;
  const lowValuePrivateMessagePrompts = history.filter(
    (entry) =>
      containsPrivateMessagePrompt(entry.content) &&
      !entry.privateMessageEscalationReason &&
      !entry.publicValueDeliveredFirst
  ).length;
  const justifiedPrivateMessageEscalations = history.filter(
    (entry) => Boolean(entry.privateMessageEscalationReason)
  ).length;
  const removalOrWarningRate =
    postedFirstReplies === 0 ? 0 : (removals + modWarnings) / postedFirstReplies;
  const repeatedModRemovalSubreddits = subredditsWithAtLeast(
    history.filter(
      (entry) => entry.status === "spam_filtered" || entry.status === "removed" || entry.status === "mod_warning"
    ),
    2
  );
  const killReasons: string[] = [];

  if (bans > 0) {
    killReasons.push("An account, subreddit, or domain ban was recorded.");
  }
  if (repeatedModRemovalSubreddits.length > 0) {
    killReasons.push(`Repeated hidden replies, mod removals, or warnings: ${repeatedModRemovalSubreddits.join(", ")}.`);
  }
  if (spamAccusations > 0) {
    killReasons.push("Users accused the account of spam, botting, or astroturfing.");
  }
  if (firstReplyPromotionViolations > 0) {
    killReasons.push("A first reply included product mention, link, CTA, or DM-style prompt.");
  }
  if (lowValuePrivateMessagePrompts > 0) {
    killReasons.push("Low-value private-message prompts were recorded without a legitimate escalation reason.");
  }

  const successSignals: string[] = [];
  if (postedFirstReplies > 0 && removalOrWarningRate < 0.02) {
    successSignals.push("Removal/mod-warning rate is below 2%.");
  }
  if (firstReplyPromotionViolations === 0) {
    successSignals.push("No first-reply promotion violations recorded.");
  }
  if (lowValuePrivateMessagePrompts === 0) {
    successSignals.push("No low-value private-message prompts were recorded.");
  }

  return {
    generatedAt: now.toISOString(),
    totalOutbound: history.length,
    postedFirstReplies,
    removals,
    modWarnings,
    spamAccusations,
    bans,
    firstReplyPromotionViolations,
    lowValuePrivateMessagePrompts,
    justifiedPrivateMessageEscalations,
    removalOrWarningRate,
    killReasons,
    successSignals
  };
}

export function redditMemoryEntryConsumesTarget(entry: RedditOutboundMemoryEntry): boolean {
  return entry.status !== "drafted" && entry.status !== "approved";
}

export function redditMemoryEntryCountsTowardPublishedLimits(entry: RedditOutboundMemoryEntry): boolean {
  return entry.status !== "drafted" && entry.status !== "approved";
}
