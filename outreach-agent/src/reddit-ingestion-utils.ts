import type { RedditConversationSnapshot, RedditSearchResult } from "./reddit-controller.js";
import type { RedditSourceItem } from "./reddit-outreach-types.js";

export function dedupeSearchResults(items: readonly RedditSearchResult[]): RedditSearchResult[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.permalink ?? item.url ?? item.id;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function dedupeSourceItems(items: readonly RedditSourceItem[]): RedditSourceItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.subreddit}:${item.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function dedupeSnapshots(
  snapshots: readonly RedditConversationSnapshot[]
): RedditConversationSnapshot[] {
  const seen = new Set<string>();
  return snapshots.filter((snapshot) => {
    const key = snapshot.thread.permalink ?? snapshot.thread.url ?? snapshot.thread.id;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function weightedSampleWithoutReplacement<T extends { score?: number }>(
  pool: readonly T[],
  count: number,
  random: () => number
): T[] {
  const remaining = [...pool];
  const picked: T[] = [];
  while (picked.length < count && remaining.length > 0) {
    const weights = remaining.map((item) => Math.max(1, item.score ?? 1));
    const totalWeight = weights.reduce((left, right) => left + right, 0);
    let roll = random() * totalWeight;
    let chosenIndex = remaining.length - 1;
    for (let index = 0; index < remaining.length; index += 1) {
      roll -= weights[index]!;
      if (roll <= 0) {
        chosenIndex = index;
        break;
      }
    }
    picked.push(remaining.splice(chosenIndex, 1)[0]!);
  }
  return picked;
}
