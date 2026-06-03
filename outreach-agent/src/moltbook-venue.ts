import { buildVerificationLlmProvider, getOutreachAgentConfig, type MoltbookRuntimeConfig } from "./config.js";
import {
  MoltbookApiClient,
  type MoltbookAgentProfileResponse,
  type MoltbookComment,
  type MoltbookCommentsResponse,
  type MoltbookFeedResponse,
  type MoltbookHomeResponse,
  type MoltbookPost,
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
  followingFeed: MoltbookFeedResponse;
  hotFeed: MoltbookFeedResponse;
  exploreFeed: MoltbookFeedResponse;
  activityCommentsByPostId: Record<string, MoltbookComment[]>;
  factSheet: ProductFactSheet;
}

const MOLTBOOK_WEB_BASE_URL = "https://www.moltbook.com";

export class MoltbookVenueProvider implements VenueProvider {
  readonly id = "moltbook";
  readonly mode: ReturnType<typeof getOutreachAgentConfig>["mode"];
  readonly policy: VenuePolicy;
  readonly capabilities = {
    heartbeatSources: true,
    pendingWriteReconciliation: true,
    discoveryIngestion: false
  } as const;

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
    const [hotFeed, exploreFeed] = await Promise.all([
      this.api.getFeed({ sort: "hot", limit: 10 }),
      this.api.getFeed({ sort: "new", limit: 10 })
    ]);
    const feedPosts = dedupePostsById([...(hotFeed.posts ?? []), ...(exploreFeed.posts ?? [])]);
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
      ...feedPosts.map((post) => ({
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
    const [home, me, factSheet, hotFeed, exploreFeed] = await Promise.all([
      this.api.getHome(),
      this.api.getMe(),
      loadProductFacts(this.config),
      this.api.getFeed({ sort: "hot", limit: 10 }),
      this.api.getFeed({ sort: "new", limit: 10 })
    ]);
    const activityPostIds = [...new Set(home.activity_on_your_posts.map((activity) => activity.post_id).filter(Boolean))]
      .slice(0, 3);
    const activityCommentsByPostId = Object.fromEntries(
      await Promise.all(
        activityPostIds.map(async (postId) => {
          try {
            const response = await this.api.getPostComments(postId, {
              sort: "new",
              limit: 25
            });
            return [postId, response.comments ?? []] as const;
          } catch {
            return [postId, []] as const;
          }
        })
      )
    );

    return {
      home,
      me,
      factSheet,
      followingFeed: {
        success: true,
        posts: home.posts_from_accounts_you_follow?.posts ?? []
      },
      hotFeed,
      exploreFeed,
      activityCommentsByPostId
    };
  }

  getPostComments(postId: string, options: { sort: "new"; limit: number }): Promise<MoltbookCommentsResponse> {
    return this.api.getPostComments(postId, options);
  }

  getAgentProfile(agentName: string): Promise<MoltbookAgentProfileResponse> {
    return this.api.getAgentProfile(agentName);
  }

  async getPost(postId: string): Promise<{ success?: boolean; post?: MoltbookPost }> {
    return this.api.getPost(postId);
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
        return buildOutcome(
          action,
          "posted",
          buildCommentOutcomeMetadata(
            (await this.api.createComment(action.parentId, { content: action.content })).comment,
            action.parentId
          )
        );
      case "reply_to_comment":
        if (!action.parentId || !action.candidateId || !action.content) {
          throw new Error("Moltbook reply action requires post id, comment id, and content.");
        }
        return buildOutcome(
          action,
          "posted",
          buildCommentOutcomeMetadata(
            (
              await this.api.createComment(action.parentId, {
                content: action.content,
                parent_id: action.candidateId
              })
            ).comment,
            action.parentId
          )
        );
      case "create_post":
        if (!action.title || !action.content) {
          throw new Error("Moltbook create_post action requires title and content.");
        }
        return buildOutcome(
          action,
          "posted",
          buildPostOutcomeMetadata(
            (
              await this.api.createPost({
                submolt_name: action.surface ?? this.config.defaultSubmolt,
                title: action.title,
                content: action.content
              })
            ).post
          )
        );
      default:
        throw new Error(`Moltbook cannot publish action type ${action.type}.`);
    }
  }
}

function dedupePostsById(posts: readonly MoltbookPost[]): MoltbookPost[] {
  const seen = new Set<string>();
  return posts.filter((post) => {
    const id = post.post_id ?? post.id;
    if (!id || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

function buildOutcome(
  action: VenueAction,
  type: VenueOutcome["type"],
  extra: Partial<VenueOutcome> = {}
): VenueOutcome {
  return {
    id: `${action.id}:${type}`,
    venue: "moltbook",
    actionId: action.id,
    candidateId: action.candidateId,
    remoteContentId: extra.remoteContentId,
    remoteContentUrl: extra.remoteContentUrl,
    type,
    occurredAt: new Date().toISOString(),
    raw: extra.raw
  };
}

function buildPostOutcomeMetadata(post: MoltbookPost | undefined): Partial<VenueOutcome> {
  const postId = post?.post_id ?? post?.id;
  return {
    remoteContentId: postId,
    remoteContentUrl: normalizeMoltbookUrl(post?.url) ?? buildMoltbookPostUrl(postId),
    raw: post
  };
}

function buildCommentOutcomeMetadata(
  comment: MoltbookComment | undefined,
  fallbackPostId: string | undefined
): Partial<VenueOutcome> {
  const postId = comment?.post_id ?? fallbackPostId;
  return {
    remoteContentId: comment?.id,
    remoteContentUrl: buildMoltbookPostUrl(postId),
    raw: comment
  };
}

function buildMoltbookPostUrl(postId: string | undefined): string | undefined {
  if (!postId) {
    return undefined;
  }
  return `${MOLTBOOK_WEB_BASE_URL}/post/${encodeURIComponent(postId)}`;
}

function normalizeMoltbookUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value, MOLTBOOK_WEB_BASE_URL).toString();
  } catch {
    return undefined;
  }
}
