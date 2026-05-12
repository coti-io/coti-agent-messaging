import type { MoltbookAgentProfile, MoltbookFeedResponse, MoltbookPost } from "./moltbook-api.js";

export interface DesignPartnerSource {
  posts: readonly MoltbookPost[];
  profiles?: Readonly<Record<string, MoltbookAgentProfile | undefined>>;
}

export interface DesignPartnerCandidate {
  agentName: string;
  score: number;
  postCount: number;
  totalUpvotes: number;
  totalComments: number;
  latestPostAt?: string;
  profile?: MoltbookAgentProfile;
  topPosts: Array<{
    postId?: string;
    title: string;
    upvotes: number;
    comments: number;
  }>;
  suggestedFraming: string;
  suggestedAsk: string;
}

interface AgentAccumulator {
  agentName: string;
  posts: MoltbookPost[];
  totalUpvotes: number;
  totalComments: number;
  latestPostAt?: string;
}

const TOPIC_WEIGHTS: Array<[RegExp, number]> = [
  [/\bagents?\b/i, 3],
  [/\bprivate\b|\bprivacy\b|\bencrypted\b/i, 3],
  [/\bmcp\b|\bsdk\b|\bintegration\b/i, 3],
  [/\bmessage\b|\bmessaging\b|\binbox\b/i, 2],
  [/\bworkflow\b|\bcoordination\b|\borchestration\b/i, 2],
  [/\breward\b|\bgrant\b|\busage\b/i, 1]
];

export function rankDesignPartnerCandidates(source: DesignPartnerSource, limit = 10): DesignPartnerCandidate[] {
  const byAgent = new Map<string, AgentAccumulator>();

  for (const post of source.posts) {
    if (!post.author_name) {
      continue;
    }

    const accumulator =
      byAgent.get(post.author_name) ??
      {
        agentName: post.author_name,
        posts: [],
        totalUpvotes: 0,
        totalComments: 0
      };

    accumulator.posts.push(post);
    accumulator.totalUpvotes += safeCount(post.upvotes);
    accumulator.totalComments += safeCount(post.comment_count);
    accumulator.latestPostAt = latestTimestamp(accumulator.latestPostAt, post.created_at);
    byAgent.set(post.author_name, accumulator);
  }

  return [...byAgent.values()]
    .map((entry) => buildCandidate(entry, source.profiles?.[entry.agentName]))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return (Date.parse(right.latestPostAt ?? "") || 0) - (Date.parse(left.latestPostAt ?? "") || 0);
    })
    .slice(0, limit);
}

export function mergeFeedPosts(feeds: readonly MoltbookFeedResponse[]): MoltbookPost[] {
  const postsById = new Map<string, MoltbookPost>();
  for (const feed of feeds) {
    for (const post of feed.posts ?? []) {
      postsById.set(post.post_id ?? post.id, post);
    }
  }
  return [...postsById.values()];
}

function buildCandidate(entry: AgentAccumulator, profile: MoltbookAgentProfile | undefined): DesignPartnerCandidate {
  const topicScore = entry.posts.reduce((score, post) => score + scorePostTopic(post), 0);
  const profileScore =
    safeCount(profile?.karma) * 0.05 +
    safeCount(profile?.follower_count) * 0.5 +
    safeCount(profile?.posts_count) * 0.2 +
    safeCount(profile?.comments_count) * 0.1;
  const engagementScore = entry.totalUpvotes * 2 + entry.totalComments * 3 + entry.posts.length * 2;
  const score = Math.round((topicScore + engagementScore + profileScore) * 100) / 100;
  const topPosts = [...entry.posts]
    .sort((left, right) => postEngagement(right) - postEngagement(left))
    .slice(0, 3)
    .map((post) => ({
      postId: post.post_id ?? post.id,
      title: post.title,
      upvotes: safeCount(post.upvotes),
      comments: safeCount(post.comment_count)
    }));

  return {
    agentName: entry.agentName,
    score,
    postCount: entry.posts.length,
    totalUpvotes: entry.totalUpvotes,
    totalComments: entry.totalComments,
    latestPostAt: entry.latestPostAt,
    profile,
    topPosts,
    suggestedFraming: chooseFraming(entry.posts),
    suggestedAsk:
      "Offer hands-on help to wire one real COTI private-message send/read flow, then ask what blocked integration."
  };
}

function scorePostTopic(post: MoltbookPost): number {
  const text = `${post.title} ${post.content ?? ""} ${post.content_preview ?? ""}`;
  return TOPIC_WEIGHTS.reduce((score, [pattern, weight]) => score + (pattern.test(text) ? weight : 0), 0);
}

function chooseFraming(posts: readonly MoltbookPost[]): string {
  const text = posts.map((post) => `${post.title} ${post.content ?? ""} ${post.content_preview ?? ""}`).join("\n");
  if (/\bmcp\b|\bsdk\b|\bintegration\b/i.test(text)) {
    return "Integration-first: lead with the quickstart, SDK smoke test, and offer to debug their first send/read.";
  }
  if (/\breward\b|\bgrant\b|\busage\b/i.test(text)) {
    return "Incentive-aware: lead with real usage, then explain grants/rewards only after the working message path.";
  }
  if (/\bprivacy\b|\bencrypted\b|\bprivate\b/i.test(text)) {
    return "Privacy-first: lead with encrypted bodies, queryable routing metadata, and receiver-side dogfood results.";
  }
  return "Operator-first: lead with agent coordination pain and offer a concrete private messaging integration test.";
}

function postEngagement(post: MoltbookPost): number {
  return safeCount(post.upvotes) * 2 + safeCount(post.comment_count) * 3;
}

function safeCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function latestTimestamp(left: string | undefined, right: string | undefined): string | undefined {
  if (!right) {
    return left;
  }
  if (!left) {
    return right;
  }
  return Date.parse(right) > Date.parse(left) ? right : left;
}
