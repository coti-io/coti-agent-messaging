import type {
  MoltbookActivityItem,
  MoltbookComment,
  MoltbookFeedResponse,
  MoltbookHomeResponse,
  MoltbookPost
} from "./moltbook-api.js";
import type { ProductFactSheet } from "./product-facts.js";

export interface RecentGeneratedArtifact {
  id: string;
  type: "post" | "comment" | "reply";
  title?: string;
  content: string;
  targetId?: string;
  targetSummary?: string;
  createdAt: string;
}

export interface OutreachAgentState {
  firstSeenAt?: string;
  lastHeartbeatAt?: string;
  lastPostAt?: string;
  lastCommentAt?: string;
  dailyCommentDate?: string;
  dailyCommentCount: number;
  upvotedPostIds: string[];
  followedAgentNames: string[];
  repliedCommentIds: string[];
  createdPostFingerprints: string[];
  recentGeneratedArtifacts: RecentGeneratedArtifact[];
}

export type PlannedAction =
  | {
      type: "reply_to_activity";
      activity: MoltbookActivityItem;
      reason: string;
    }
  | {
      type: "upvote_post";
      post: MoltbookPost;
      reason: string;
    }
  | {
      type: "follow_agent";
      agentName: string;
      reason: string;
    }
  | {
      type: "comment_on_post";
      post: MoltbookPost;
      reason: string;
    }
  | {
      type: "create_post";
      reason: string;
    }
  | {
      type: "inspect_dms";
      reason: string;
    }
  | {
      type: "noop";
      reason: string;
    };

export interface ReplyTarget {
  commentId: string;
  postId: string;
  authorName?: string;
  content: string;
}

export function createInitialState(): OutreachAgentState {
  return {
    dailyCommentCount: 0,
    upvotedPostIds: [],
    followedAgentNames: [],
    repliedCommentIds: [],
    createdPostFingerprints: [],
    recentGeneratedArtifacts: []
  };
}

function uniqueRecent(values: readonly string[], limit: number): string[] {
  return [...new Set(values)].slice(-limit);
}

export function normalizeState(
  state: Partial<OutreachAgentState> | undefined,
  now = new Date()
): OutreachAgentState {
  const normalized = {
    ...createInitialState(),
    ...state
  };

  const today = now.toISOString().slice(0, 10);
  if (normalized.dailyCommentDate !== today) {
    normalized.dailyCommentDate = today;
    normalized.dailyCommentCount = 0;
  }

  normalized.upvotedPostIds = uniqueRecent(normalized.upvotedPostIds, 250);
  normalized.followedAgentNames = uniqueRecent(normalized.followedAgentNames, 100);
  normalized.repliedCommentIds = uniqueRecent(normalized.repliedCommentIds, 500);
  normalized.createdPostFingerprints = uniqueRecent(normalized.createdPostFingerprints, 50);
  normalized.recentGeneratedArtifacts = normalized.recentGeneratedArtifacts.slice(-20);

  if (!normalized.firstSeenAt) {
    normalized.firstSeenAt = now.toISOString();
  }

  return normalized;
}

function hoursSince(isoTimestamp: string | undefined, now: Date): number | undefined {
  if (!isoTimestamp) {
    return undefined;
  }

  const timestamp = Date.parse(isoTimestamp);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  return (now.getTime() - timestamp) / 3_600_000;
}

export function isNewAgent(
  profileCreatedAt: string | undefined,
  state: OutreachAgentState,
  now = new Date()
): boolean {
  const createdHoursAgo =
    hoursSince(profileCreatedAt, now) ?? hoursSince(state.firstSeenAt, now) ?? Number.POSITIVE_INFINITY;
  return createdHoursAgo < 24;
}

export function commentCooldownMs(isNew: boolean): number {
  return (isNew ? 60 : 20) * 1_000;
}

export function commentLimitPerDay(isNew: boolean): number {
  return isNew ? 20 : 50;
}

export function postCooldownMs(isNew: boolean): number {
  return (isNew ? 120 : 30) * 60 * 1_000;
}

export function canCreatePost(
  state: OutreachAgentState,
  isNew: boolean,
  now = new Date()
): boolean {
  const sinceLastPostHours = hoursSince(state.lastPostAt, now);
  if (sinceLastPostHours === undefined) {
    return true;
  }

  return sinceLastPostHours * 3_600_000 >= postCooldownMs(isNew);
}

export function canComment(
  state: OutreachAgentState,
  isNew: boolean,
  now = new Date()
): boolean {
  if (state.dailyCommentCount >= commentLimitPerDay(isNew)) {
    return false;
  }

  const sinceLastCommentMs = (hoursSince(state.lastCommentAt, now) ?? Number.POSITIVE_INFINITY) * 3_600_000;
  return sinceLastCommentMs >= commentCooldownMs(isNew);
}

function scorePost(post: MoltbookPost): number {
  const haystack = `${post.title} ${post.content ?? ""} ${post.content_preview ?? ""}`.toLowerCase();
  const weightedTerms: Array<[string, number]> = [
    ["private", 3],
    ["privacy", 3],
    ["message", 2],
    ["messaging", 2],
    ["inbox", 2],
    ["coordination", 3],
    ["collaboration", 2],
    ["agent", 2],
    ["agents", 2],
    ["mcp", 3],
    ["sdk", 2],
    ["integration", 2],
    ["workflow", 2],
    ["reward", 1],
    ["rewards", 1],
    ["coti", 2]
  ];

  return weightedTerms.reduce((score, [term, weight]) => {
    return haystack.includes(term) ? score + weight : score;
  }, 0);
}

function normalizeFingerprint(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function planHeartbeatActions(input: {
  home: MoltbookHomeResponse;
  followingFeed?: MoltbookFeedResponse;
  exploreFeed?: MoltbookFeedResponse;
  state: OutreachAgentState;
  factSheet: ProductFactSheet;
  profileCreatedAt?: string;
  now?: Date;
}): PlannedAction[] {
  const now = input.now ?? new Date();
  const state = normalizeState(input.state, now);
  const actions: PlannedAction[] = [];
  const newAgent = isNewAgent(input.profileCreatedAt, state, now);

  if (input.home.activity_on_your_posts.length > 0) {
    for (const activity of input.home.activity_on_your_posts.slice(0, 3)) {
      actions.push({
        type: "reply_to_activity",
        activity,
        reason: "Replying to engagement on our own posts is the highest-value action."
      });
    }
  }

  if ((input.home.your_direct_messages?.pending_request_count ?? 0) > 0) {
    actions.push({
      type: "inspect_dms",
      reason: "There are pending direct-message requests that deserve review."
    });
  }

  const candidatePosts = [
    ...(input.home.posts_from_accounts_you_follow?.posts ?? []),
    ...(input.followingFeed?.posts ?? []),
    ...(input.exploreFeed?.posts ?? [])
  ];

  for (const post of candidatePosts) {
    const postId = post.post_id ?? post.id;
    if (!postId || state.upvotedPostIds.includes(postId)) {
      continue;
    }

    if (scorePost(post) < 3) {
      continue;
    }

    actions.push({
      type: "upvote_post",
      post,
      reason: "This post matches our topic space and is worth rewarding."
    });

    if (post.author_name && !state.followedAgentNames.includes(post.author_name) && scorePost(post) >= 5) {
      actions.push({
        type: "follow_agent",
        agentName: post.author_name,
        reason: "The author is posting repeatedly on topics we care about."
      });
    }

    if (actions.filter((action) => action.type === "upvote_post").length >= 2) {
      break;
    }
  }

  const commentTargets = candidatePosts.filter((post) => {
    const postId = post.post_id ?? post.id;
    return Boolean(postId) && scorePost(post) >= 4 && canComment(state, newAgent, now);
  });

  for (const commentTarget of commentTargets.slice(0, 3)) {
    actions.push({
      type: "comment_on_post",
      post: commentTarget,
      reason: "This discussion is close enough to private messaging that we can add value."
    });
  }

  if (
    input.home.activity_on_your_posts.length === 0 &&
    canCreatePost(state, newAgent, now) &&
    state.createdPostFingerprints.length < 50
  ) {
    actions.push({
      type: "create_post",
      reason: "No urgent replies are waiting and we have room for one substantive outreach post."
    });
  }

  if (actions.length === 0) {
    return [
      {
        type: "noop",
        reason: "Nothing valuable to do right now without forcing low-signal activity."
      }
    ];
  }

  return actions;
}

function flattenComments(comments: readonly MoltbookComment[]): MoltbookComment[] {
  const flattened: MoltbookComment[] = [];
  for (const comment of comments) {
    flattened.push(comment);
    if (comment.replies?.length) {
      flattened.push(...flattenComments(comment.replies));
    }
  }

  return flattened;
}

function commentAuthorName(comment: MoltbookComment): string | undefined {
  return comment.author_name ?? comment.author?.name;
}

export function chooseReplyTarget(input: {
  postId: string;
  comments: readonly MoltbookComment[];
  state: OutreachAgentState;
  agentName: string;
}): ReplyTarget | undefined {
  const candidates = flattenComments(input.comments)
    .filter((comment) => {
      const author = commentAuthorName(comment);
      if (author && author === input.agentName) {
        return false;
      }

      return !input.state.repliedCommentIds.includes(comment.id);
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.created_at ?? "") || 0;
      const rightTime = Date.parse(right.created_at ?? "") || 0;
      return rightTime - leftTime;
    });

  const target = candidates[0];
  if (!target) {
    return undefined;
  }

  return {
    commentId: target.id,
    postId: input.postId,
    authorName: commentAuthorName(target),
    content: target.content
  };
}

export function applyActionResult(
  state: OutreachAgentState,
  action:
    | {
        type: "create_post";
        fingerprint: string;
        title: string;
        content: string;
      }
    | {
        type: "comment";
        commentId: string;
        content: string;
        targetSummary?: string;
        replyToAuthor?: string;
      }
    | { type: "upvote_post"; postId: string }
    | { type: "follow_agent"; agentName: string },
  now = new Date()
): OutreachAgentState {
  const nextState = normalizeState(state, now);
  nextState.lastHeartbeatAt = now.toISOString();

  switch (action.type) {
    case "create_post":
      nextState.lastPostAt = now.toISOString();
      nextState.createdPostFingerprints = uniqueRecent(
        [...nextState.createdPostFingerprints, action.fingerprint],
        50
      );
      const artifact: RecentGeneratedArtifact = {
        id: `post:${action.fingerprint}`,
        type: "post",
        title: action.title,
        content: action.content,
        createdAt: now.toISOString()
      };
      nextState.recentGeneratedArtifacts = [
        ...nextState.recentGeneratedArtifacts,
        artifact
      ].slice(-20);
      return nextState;
    case "comment":
      nextState.lastCommentAt = now.toISOString();
      nextState.dailyCommentCount += 1;
      nextState.repliedCommentIds = uniqueRecent(
        [...nextState.repliedCommentIds, action.commentId],
        500
      );
      const commentArtifact: RecentGeneratedArtifact = {
        id: action.commentId,
        type: action.replyToAuthor ? "reply" : "comment",
        content: action.content,
        targetId: action.commentId,
        targetSummary: action.targetSummary,
        createdAt: now.toISOString()
      };
      nextState.recentGeneratedArtifacts = [
        ...nextState.recentGeneratedArtifacts,
        commentArtifact
      ].slice(-20);
      return nextState;
    case "upvote_post":
      nextState.upvotedPostIds = uniqueRecent([...nextState.upvotedPostIds, action.postId], 250);
      return nextState;
    case "follow_agent":
      nextState.followedAgentNames = uniqueRecent(
        [...nextState.followedAgentNames, action.agentName],
        100
      );
      return nextState;
  }
}

export function contentFingerprint(value: string): string {
  return normalizeFingerprint(value).slice(0, 160);
}

