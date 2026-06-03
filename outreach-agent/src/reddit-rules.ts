import { DEFAULT_REDDIT_TARGETING } from "./reddit-targeting.js";
import type {
  RedditOutreachTargeting,
  RedditRulesRegistry,
  RedditSubredditRule
} from "./reddit-outreach-types.js";

export const DEFAULT_REDDIT_RULES_REGISTRY: RedditRulesRegistry = {
  generatedAt: "2026-05-07T00:00:00.000Z",
  rules: DEFAULT_REDDIT_TARGETING.targetSubreddits.map((target) => ({
    name: target.name,
    risk:
      target.priority === "primary"
        ? "medium"
        : target.priority === "secondary"
          ? "high"
          : "high",
    allowedTopics: [
      "direct answers to technical questions",
      "architecture tradeoffs",
      "privacy and coordination explanations",
      "MCP, SDK, and agent-runtime implementation details"
    ],
    disallowedTopics: [
      "token promotion",
      "price talk",
      "airdrop or giveaway content",
      "unsolicited product links",
      "first-reply product mentions",
      "requests to DM unless the Redditor explicitly asks"
    ],
    selfPromotionPolicy: "strict",
    linkPolicy: "none_in_first_reply",
    flairRequirements: "Check the live subreddit rules before approving a draft.",
    modContactNotes:
      "If the first useful answer would require naming COTI or linking to owned resources, contact mods or wait for explicit user interest.",
    requiresManualRuleCheck: true
  }))
};

export type { RedditRulesRegistry, RedditSubredditRule };

function findDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return undefined;
}

export function assertTargetingIsViable(targeting = DEFAULT_REDDIT_TARGETING): void {
  const count = targeting.targetSubreddits.length;
  if (count < 10 || count > 30) {
    throw new Error(`Reddit outreach requires 10-30 candidate subreddits; got ${count}.`);
  }

  const duplicate = findDuplicate(
    targeting.targetSubreddits.map((subreddit) => subreddit.name.toLowerCase())
  );
  if (duplicate) {
    throw new Error(`Duplicate target subreddit configured: ${duplicate}.`);
  }
}

export function assertRulesRegistryCoversTargets(
  targeting = DEFAULT_REDDIT_TARGETING,
  registry: RedditRulesRegistry
): void {
  const ruleNames = new Set(registry.rules.map((rule) => rule.name.toLowerCase()));
  const missing = targeting.targetSubreddits.filter(
    (target) => !ruleNames.has(target.name.toLowerCase())
  );
  if (missing.length > 0) {
    throw new Error(
      `Rules registry is missing target subreddits: ${missing.map((target) => target.name).join(", ")}.`
    );
  }
}

export function mergeRulesRegistries(...registries: readonly RedditRulesRegistry[]): RedditRulesRegistry {
  const rulesByName = new Map<string, RedditSubredditRule>();
  for (const registry of registries) {
    for (const rule of registry.rules) {
      rulesByName.set(rule.name.toLowerCase(), rule);
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    rules: [...rulesByName.values()]
  };
}

export function resolveRulesRegistryForSubreddits(
  subredditNames: readonly string[],
  ...registries: readonly RedditRulesRegistry[]
): RedditRulesRegistry {
  const rulesByName = new Map<string, RedditSubredditRule>();
  for (const registry of registries) {
    for (const rule of registry.rules) {
      rulesByName.set(rule.name.toLowerCase(), rule);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    rules: subredditNames.map((name) => {
      const existing = rulesByName.get(name.toLowerCase());
      if (existing) {
        return existing;
      }
      return {
        name,
        risk: "medium",
        allowedTopics: [
          "direct answers to technical questions",
          "architecture tradeoffs",
          "privacy and coordination explanations"
        ],
        disallowedTopics: [
          "token promotion",
          "price talk",
          "unsolicited product links",
          "first-reply product mentions"
        ],
        selfPromotionPolicy: "strict",
        linkPolicy: "none_in_first_reply",
        flairRequirements: "Check the live subreddit rules before approving a draft.",
        modContactNotes: "Configured subreddit without a dedicated rules profile.",
        requiresManualRuleCheck: true
      };
    })
  };
}
