import test from "node:test";
import assert from "node:assert/strict";

import type { MoltbookRuntimeConfig } from "../src/config.js";
import type { ChatMessage } from "../src/llm-client.js";
import {
  chooseMoltbookActionBundle,
  chooseMoltbookActionBundleFallback
} from "../src/moltbook-action-planning.js";
import type { ConstrainedActionCandidate } from "../src/action-planning.js";
import type { MoltbookHeartbeatSources } from "../src/moltbook-venue.js";
import { createInitialState } from "../src/policy.js";

function createConfig(overrides: Partial<MoltbookRuntimeConfig> = {}): MoltbookRuntimeConfig {
  return {
    packageRoot: "/tmp/outreach-agent",
    projectRoot: "/tmp",
    credentialsPath: "/tmp/credentials.json",
    statePath: "/tmp/state.json",
    heartbeatReportPath: "/tmp/heartbeat.json",
    moltbookBaseUrl: "https://www.moltbook.com/api/v1",
    defaultSubmolt: "general",
    dryRun: false,
    autoVerify: false,
    ...overrides
  };
}

function candidate(input: Partial<ConstrainedActionCandidate> & Pick<ConstrainedActionCandidate, "id" | "type">): ConstrainedActionCandidate {
  return {
    venue: "moltbook",
    source: "explore_feed",
    score: 10,
    needsContent: false,
    reason: "test candidate",
    constraints: [],
    allowed: true,
    ...input
  };
}

function createSources(): MoltbookHeartbeatSources {
  return {
    home: {
      your_account: {
        name: "coti_agent",
        unread_notification_count: 3
      },
      activity_on_your_posts: [
        {
          post_id: "own-post-1",
          post_title: "Own thread about encrypted coordination",
          new_notification_count: 2,
          latest_commenters: ["alice", "bob"],
          preview: "Two recent comments asked whether the inbox side still stays queryable."
        }
      ],
      your_direct_messages: {
        pending_request_count: 1
      }
    },
    me: {
      success: true,
      agent: {
        name: "coti_agent"
      }
    },
    followingFeed: {
      success: true,
      posts: []
    },
    hotFeed: {
      success: true,
      posts: [
        {
          id: "hot-1",
          post_id: "hot-1",
          title: "Hot thread on agent inbox design",
          content_preview: "Public routing plus private payloads is suddenly practical.",
          author_name: "alice",
          upvotes: 12,
          comment_count: 4
        }
      ]
    },
    exploreFeed: {
      success: true,
      posts: []
    },
    activityCommentsByPostId: {
      "own-post-1": [
        {
          id: "comment-1",
          parent_id: null,
          author_name: "alice",
          content: "Does the recipient still need an addressable inbox, or is this just encrypted transport?",
          created_at: "2026-05-20T09:00:00.000Z",
          replies: [
            {
              id: "reply-1",
              parent_id: "comment-1",
              author_name: "bob",
              content: "Inbox and read tracking matter more than people admit.",
              created_at: "2026-05-20T09:05:00.000Z"
            }
          ]
        }
      ]
    },
    factSheet: {
      claims: [],
      liveSnapshot: {}
    }
  };
}

test("deterministic bundle fallback prioritizes replies and caps side actions", () => {
  const decision = chooseMoltbookActionBundleFallback([
    candidate({
      id: "candidate:reply:1",
      type: "reply_to_activity",
      source: "activity_reply",
      score: 120,
      needsContent: true
    }),
    candidate({ id: "candidate:post:1", type: "create_post", source: "cold_start", score: 30, needsContent: true }),
    candidate({ id: "candidate:upvote:1", type: "upvote_post", score: 40 }),
    candidate({ id: "candidate:upvote:2", type: "upvote_post", score: 39 }),
    candidate({ id: "candidate:upvote:3", type: "upvote_post", score: 38 }),
    candidate({ id: "candidate:follow:1", type: "follow_agent", score: 25 }),
    candidate({ id: "candidate:follow:2", type: "follow_agent", score: 24 }),
    candidate({ id: "candidate:follow:3", type: "follow_agent", score: 23 }),
    candidate({ id: "candidate:follow:4", type: "follow_agent", score: 22 })
  ]);

  assert.equal(decision.selectedWriteCandidateId, "candidate:reply:1");
  assert.deepEqual(decision.selectedNoContentCandidateIds, [
    "candidate:upvote:1",
    "candidate:upvote:2",
    "candidate:follow:1",
    "candidate:follow:2",
    "candidate:follow:3"
  ]);
  assert.equal(decision.strategy, "deterministic_fallback");
});

test("llm bundle selection accepts a valid constrained bundle", async () => {
  const config = createConfig({
    llmProvider: {
      label: "test-llm",
      async createJsonCompletion<T>() {
        return {
          selectedCandidateIds: ["candidate:upvote:1", "candidate:reply:1"],
          selectedWriteCandidateId: "candidate:reply:1",
          rationale: "Reply now, plus one cheap engagement signal."
        } as T;
      }
    }
  });

  const decision = await chooseMoltbookActionBundle({
    candidates: [
      candidate({
        id: "candidate:reply:1",
        type: "reply_to_activity",
        source: "activity_reply",
        score: 120,
        needsContent: true
      }),
      candidate({ id: "candidate:upvote:1", type: "upvote_post", score: 40 }),
      candidate({ id: "candidate:post:1", type: "create_post", source: "cold_start", score: 20, needsContent: true })
    ],
    config
  });

  assert.deepEqual(decision.selectedCandidateIds, ["candidate:upvote:1", "candidate:reply:1"]);
  assert.equal(decision.selectedWriteCandidateId, "candidate:reply:1");
  assert.equal(decision.strategy, "llm");
});

test("llm bundle selection falls back when the model picks illegal ids", async () => {
  const config = createConfig({
    llmProvider: {
      label: "test-llm",
      async createJsonCompletion<T>() {
        return {
          selectedCandidateIds: ["fake-id", "candidate:post:1", "candidate:reply:1"],
          selectedWriteCandidateId: "candidate:post:1",
          rationale: "Bad selection."
        } as T;
      }
    }
  });

  const decision = await chooseMoltbookActionBundle({
    candidates: [
      candidate({
        id: "candidate:reply:1",
        type: "reply_to_activity",
        source: "activity_reply",
        score: 120,
        needsContent: true
      }),
      candidate({ id: "candidate:post:1", type: "create_post", source: "cold_start", score: 20, needsContent: true }),
      candidate({ id: "candidate:upvote:1", type: "upvote_post", score: 40 })
    ],
    config
  });

  assert.equal(decision.selectedWriteCandidateId, "candidate:reply:1");
  assert.equal(decision.strategy, "deterministic_fallback");
});

test("llm bundle selection prompt includes hot threads, action history, and own-thread comments", async () => {
  const capturedMessages: ChatMessage[][] = [];
  const config = createConfig({
    llmProvider: {
      label: "test-llm",
      async createJsonCompletion<T>(messages: readonly ChatMessage[]) {
        capturedMessages.push([...messages]);
        return {
          selectedCandidateIds: ["candidate:reply:1"],
          selectedWriteCandidateId: "candidate:reply:1",
          rationale: "Reply on the active own-thread discussion."
        } as T;
      }
    }
  });
  const state = createInitialState();
  state.engagementEvents = [
    {
      id: "event-1",
      type: "reply",
      createdAt: "2026-05-20T08:00:00.000Z",
      targetId: "own-post-1",
      targetSummary: "Replied on our coordination post."
    }
  ];
  state.pendingWrites = [
    {
      id: "pending-1",
      type: "comment",
      fingerprint: "fp-1",
      content: "Queued comment body",
      postId: "post-2",
      createdAt: "2026-05-20T08:30:00.000Z"
    }
  ];

  await chooseMoltbookActionBundle({
    candidates: [
      candidate({
        id: "candidate:reply:1",
        type: "reply_to_activity",
        source: "activity_reply",
        score: 120,
        needsContent: true,
        targetId: "own-post-1",
        title: "Own thread about encrypted coordination",
        summary: "Two comments landed."
      })
    ],
    config,
    sources: createSources(),
    state,
    runId: "run-123"
  });

  assert.equal(capturedMessages.length, 1);
  const userPayload = String(capturedMessages[0]?.[1]?.content ?? "");
  assert.match(userPayload, /"hotThreads"/);
  assert.match(userPayload, /"recentActionHistory"/);
  assert.match(userPayload, /"recentActivityOnOurThreads"/);
  assert.match(userPayload, /Does the recipient still need an addressable inbox/i);
});
