import {
  DEFAULT_REDDIT_RULES_REGISTRY,
  DEFAULT_REDDIT_TARGETING,
  buildRedditReviewQueue,
  type RedditOutboundMemoryEntry,
  type RedditReviewQueue,
  type RedditRulesRegistry,
  type RedditSourceItem
} from "./reddit-outreach.js";
import {
  type OutreachAgentConfig,
  type VenueAction,
  type VenueCandidate,
  type VenueOutcome,
  type VenuePolicy,
  type VenueProvider
} from "./venue.js";

export class RedditVenueProvider implements VenueProvider {
  readonly id = "reddit";
  readonly mode: OutreachAgentConfig["mode"];
  readonly policy: VenuePolicy;

  constructor(private readonly config: OutreachAgentConfig) {
    this.mode = config.mode;
    this.policy = {
      id: config.policyProfileId ?? "reddit-read-only",
      venue: "reddit",
      mode: this.mode,
      allowedSurfaces: config.allowedSurfaces,
      allowsAutopublish: false,
      allowsPrivateMessages: false,
      allowsTrackedLinks: false,
      firstTouchPromotionAllowed: false
    };
  }

  async listCandidates(): Promise<VenueCandidate[]> {
    return [];
  }

  buildReviewQueue(input: {
    items: readonly RedditSourceItem[];
    history?: readonly RedditOutboundMemoryEntry[];
    registry?: RedditRulesRegistry;
  }): RedditReviewQueue {
    const allowedSurfaces = new Set(this.config.allowedSurfaces.map((surface) => surface.toLowerCase()));
    return buildRedditReviewQueue({
      items:
        allowedSurfaces.size === 0
          ? input.items
          : input.items.filter((item) => allowedSurfaces.has(item.subreddit.toLowerCase())),
      history: input.history ?? [],
      registry: input.registry ?? DEFAULT_REDDIT_RULES_REGISTRY,
      targeting: DEFAULT_REDDIT_TARGETING
    });
  }

  reviewQueueToCandidates(queue: RedditReviewQueue): VenueCandidate[] {
    return queue.items.map((item) => ({
      id: item.id,
      venue: "reddit",
      surface: item.source.subreddit,
      kind: "review_item",
      title: item.source.title,
      body: item.draft ?? item.source.body,
      author: item.source.author,
      url: item.source.permalink ?? item.source.url,
      score: item.relevanceScore,
      raw: item
    }));
  }

  async publishAction(_action: VenueAction): Promise<VenueOutcome> {
    throw new Error("Reddit provider is read-only/human-review and cannot publish actions.");
  }
}
