import {
  DEFAULT_REDDIT_RULES_REGISTRY,
  DEFAULT_REDDIT_TARGETING,
  buildRedditReviewQueue,
  type RedditOutboundMemoryEntry,
  type RedditReviewQueue,
  type RedditRulesRegistry,
  type RedditSourceItem
} from "./reddit-outreach.js";
import { RedditManualController, type RedditController } from "./reddit-controller.js";
import { resolvePromptProfile, validateDraftAgainstPromptProfile } from "./prompt-profile.js";
import {
  assertCanPublish,
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

  constructor(
    private readonly config: OutreachAgentConfig,
    private readonly controller: RedditController = new RedditManualController()
  ) {
    this.mode = config.mode;
    this.policy = {
      id: config.policyProfileId ?? "reddit-read-only",
      venue: "reddit",
      mode: this.mode,
      allowedSurfaces: config.allowedSurfaces,
      allowsAutopublish: this.mode === "approved_autopost" && this.controller.id !== "manual",
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

  async publishAction(action: VenueAction): Promise<VenueOutcome> {
    assertCanPublish(this);
    if (action.venue !== "reddit") {
      throw new Error(`Reddit provider cannot publish venue ${action.venue}.`);
    }
    if (action.surface && this.policy.allowedSurfaces.length > 0) {
      const normalized = action.surface.toLowerCase();
      if (!this.policy.allowedSurfaces.some((surface) => surface.toLowerCase() === normalized)) {
        throw new Error(`Surface r/${action.surface} is not in OUTREACH_AGENT_ALLOWED_SURFACES.`);
      }
    }
    assertRedditAutopublishContent(action);
    const result = await this.controller.publishAction(action, {
      mode: this.mode,
      allowedSurfaces: this.policy.allowedSurfaces,
      venueAccountId: this.config.venueAccountId
    });
    return {
      id: `${action.id}:posted`,
      venue: "reddit",
      actionId: action.id,
      candidateId: action.candidateId,
      remoteContentId: result.remoteContentId,
      remoteContentUrl: result.remoteContentUrl,
      type: action.type === "reply_to_comment" ? "replied" : "posted",
      occurredAt: new Date().toISOString(),
      raw: result.raw
    };
  }
}

const URL_PATTERN = /https?:\/\//i;
const CTA_PATTERNS = [
  /\bdm me\b/i,
  /\bmessage me\b/i,
  /\bbook a demo\b/i,
  /\bsign up\b/i,
  /\btry (it|this|our)\b/i,
  /\bcheck out\b/i,
  /\blearn more\b/i,
  /\bcontact me\b/i
];

function assertRedditAutopublishContent(action: VenueAction): void {
  const content = action.content;
  if (!content) {
    return;
  }
  const profile = resolvePromptProfile({
    venue: "reddit",
    actionType: action.type === "create_post" ? "create_post" : action.type === "comment_on_post" ? "comment_on_post" : "reply_to_activity"
  });
  validateDraftAgainstPromptProfile(profile, content);
  if (URL_PATTERN.test(content)) {
    throw new Error("Reddit autopublish content must not contain links.");
  }
  if (CTA_PATTERNS.some((pattern) => pattern.test(content))) {
    throw new Error("Reddit autopublish content must not include CTAs, demo offers, or DM prompts.");
  }
  if (
    DEFAULT_REDDIT_TARGETING.productAliases.some((alias) =>
      new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i").test(content)
    )
  ) {
    throw new Error("Reddit autopublish content must not mention the product, company, or owned resources.");
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
