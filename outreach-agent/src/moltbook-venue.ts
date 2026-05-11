import { buildVerificationLlmProvider, getOutreachAgentConfig, type MoltbookRuntimeConfig } from "./config.js";
import {
  MoltbookApiClient,
  type MoltbookAgentProfileResponse,
  type MoltbookCommentsResponse,
  type MoltbookFeedResponse,
  type MoltbookHomeResponse,
  type MoltbookSearchResponse
} from "./moltbook-api.js";
import type { ProductFactSheet } from "./product-facts.js";
import { loadProductFacts } from "./product-facts.js";
import {
  assertCanPublish,
  type VenueAction,
  type VenueCandidate,
  type VenueOutcome,
  type VenuePolicy,
  type VenueProvider
} from "./venue.js";

export interface MoltbookHeartbeatSources {
  home: MoltbookHomeResponse;
  me: MoltbookAgentProfileResponse;
  exploreFeed: MoltbookFeedResponse;
  factSheet: ProductFactSheet;
}

export class MoltbookVenueProvider implements VenueProvider {
  readonly id = "moltbook";
  readonly mode: ReturnType<typeof getOutreachAgentConfig>["mode"];
  readonly policy: VenuePolicy;

  constructor(
    private readonly config: MoltbookRuntimeConfig,
    private readonly api = new MoltbookApiClient({
      baseUrl: config.moltbookBaseUrl,
      apiKey: config.apiKey,
      autoVerify: config.autoVerify,
      verificationLlmProvider: buildVerificationLlmProvider(config)
    })
  ) {
    const agent = getOutreachAgentConfig(config);
    this.mode = agent.mode;
    this.policy = {
      id: agent.policyProfileId ?? "moltbook-default",
      venue: "moltbook",
      mode: this.mode,
      allowedSurfaces: agent.allowedSurfaces,
      allowsAutopublish: this.mode === "approved_autopost",
      allowsPrivateMessages: false,
      allowsTrackedLinks: true,
      firstTouchPromotionAllowed: true
    };
  }

  async listCandidates(): Promise<VenueCandidate[]> {
    const home = await this.api.getHome();
    const exploreFeed = await this.api.getFeed({ sort: "new", limit: 10 });
    return [
      ...home.activity_on_your_posts.map((activity) => ({
        id: `activity:${activity.post_id}`,
        venue: this.id,
        surface: activity.submolt_name,
        kind: "thread" as const,
        title: activity.post_title,
        body: activity.preview,
        score: activity.new_notification_count,
        raw: activity
      })),
      ...(exploreFeed.posts ?? []).map((post) => ({
        id: `post:${post.post_id ?? post.id}`,
        venue: this.id,
        surface: post.submolt_name,
        kind: "post" as const,
        title: post.title,
        body: post.content ?? post.content_preview,
        author: post.author_name,
        score: post.upvotes,
        raw: post
      }))
    ];
  }

  async loadHeartbeatSources(): Promise<MoltbookHeartbeatSources> {
    const [home, me, factSheet] = await Promise.all([
      this.api.getHome(),
      this.api.getMe(),
      loadProductFacts(this.config)
    ]);
    const exploreFeed = await this.api.getFeed({ sort: "new", limit: 10 });

    return {
      home,
      me,
      factSheet,
      exploreFeed
    };
  }

  getPostComments(postId: string, options: { sort: "new"; limit: number }): Promise<MoltbookCommentsResponse> {
    return this.api.getPostComments(postId, options);
  }

  getAgentProfile(agentName: string): Promise<MoltbookAgentProfileResponse> {
    return this.api.getAgentProfile(agentName);
  }

  search(input: { q: string; type: "posts" | "comments" | "all"; limit: number }): Promise<MoltbookSearchResponse> {
    return this.api.search(input);
  }

  async markNotificationsReadByPost(postId: string): Promise<void> {
    await this.api.markNotificationsReadByPost(postId);
  }

  async publishAction(action: VenueAction): Promise<VenueOutcome> {
    assertCanPublish(this);
    switch (action.type) {
      case "upvote_post":
        if (!action.parentId) {
          throw new Error("Moltbook upvote action requires parentId.");
        }
        await this.api.upvotePost(action.parentId);
        return buildOutcome(action, "posted");
      case "follow_account":
        if (!action.parentId) {
          throw new Error("Moltbook follow action requires parentId.");
        }
        await this.api.followAgent(action.parentId);
        return buildOutcome(action, "posted");
      case "comment_on_post":
        if (!action.parentId || !action.content) {
          throw new Error("Moltbook comment action requires parentId and content.");
        }
        await this.api.createComment(action.parentId, { content: action.content });
        return buildOutcome(action, "posted");
      case "reply_to_comment":
        if (!action.parentId || !action.candidateId || !action.content) {
          throw new Error("Moltbook reply action requires post id, comment id, and content.");
        }
        await this.api.createComment(action.parentId, {
          content: action.content,
          parent_id: action.candidateId
        });
        return buildOutcome(action, "posted");
      case "create_post":
        if (!action.title || !action.content) {
          throw new Error("Moltbook create_post action requires title and content.");
        }
        await this.api.createPost({
          submolt_name: action.surface ?? this.config.defaultSubmolt,
          title: action.title,
          content: action.content
        });
        return buildOutcome(action, "posted");
      default:
        throw new Error(`Moltbook cannot publish action type ${action.type}.`);
    }
  }
}

function buildOutcome(action: VenueAction, type: VenueOutcome["type"]): VenueOutcome {
  return {
    id: `${action.id}:${type}`,
    venue: "moltbook",
    actionId: action.id,
    candidateId: action.candidateId,
    type,
    occurredAt: new Date().toISOString()
  };
}
