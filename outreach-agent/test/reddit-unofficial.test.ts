import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { buildRedditControllerConfig, type MoltbookRuntimeConfig } from "../src/config.js";
import { RedditUnofficialController } from "../src/reddit-controller.js";
import {
  redditListingToSearchResults,
  redditThreadJsonToState,
  RedditUnofficialClient
} from "../src/reddit-unofficial.js";

function createConfig(overrides: Partial<MoltbookRuntimeConfig> = {}): MoltbookRuntimeConfig {
  const packageRoot = path.resolve(import.meta.dirname, "..");
  return {
    packageRoot,
    projectRoot: path.resolve(packageRoot, ".."),
    credentialsPath: path.join(packageRoot, ".runtime", "test-credentials.json"),
    statePath: path.join(packageRoot, ".runtime", "test-state.json"),
    heartbeatReportPath: path.join(packageRoot, ".runtime", "test-heartbeat.json"),
    moltbookBaseUrl: "https://www.moltbook.com/api/v1",
    defaultSubmolt: "general",
    dryRun: false,
    autoVerify: false,
    reddit: {
      ...buildRedditControllerConfig(packageRoot),
      controller: "unofficial",
      unofficial: {
        proxy: "http://proxy.test:3128",
        storageStatePath: path.join(packageRoot, ".runtime", "reddit-storage-state.json"),
        bearerOverride: "test-token-v2",
        publicBaseUrl: "https://www.reddit.com",
        oauthBaseUrl: "https://oauth.reddit.com",
        userAgent: "test-agent"
      }
    },
    agent: {
      venue: "reddit",
      venueAccountId: "reddit-user",
      allowedSurfaces: ["Moltbook"],
      mode: "approved_autopost",
      policyProfileId: "reddit-browser"
    },
    ...overrides
  };
}

test("unofficial search mapping returns subreddit posts", () => {
  const results = redditListingToSearchResults(
    {
      data: {
        children: [
          {
            kind: "t3",
            data: {
              id: "abc123",
              subreddit: "Moltbook",
              title: "Need private agent messaging",
              selftext: "Question body",
              author: "builder",
              score: 12,
              num_comments: 4,
              permalink: "/r/Moltbook/comments/abc123/need_private_agent_messaging/"
            }
          },
          {
            kind: "t3",
            data: {
              id: "offtopic",
              subreddit: "Other",
              title: "Ignore me"
            }
          }
        ]
      }
    },
    "Moltbook"
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]?.id, "abc123");
  assert.equal(results[0]?.subreddit, "Moltbook");
  assert.equal(results[0]?.commentCount, 4);
});

test("unofficial thread mapping preserves nested replies", () => {
  const thread = redditThreadJsonToState(
    [
      {
        data: {
          children: [
            {
              kind: "t3",
              data: {
                id: "abc123",
                subreddit: "Moltbook",
                title: "Private agent inboxes",
                selftext: "Post body",
                author: "op",
                permalink: "/r/Moltbook/comments/abc123/private_agent_inboxes/",
                num_comments: 2
              }
            }
          ]
        }
      },
      {
        data: {
          children: [
            {
              kind: "t1",
              data: {
                id: "c1",
                name: "t1_c1",
                parent_id: "t3_abc123",
                body: "How would auth work?",
                author: "commenter",
                replies: {
                  data: {
                    children: [
                      {
                        kind: "t1",
                        data: {
                          id: "c2",
                          name: "t1_c2",
                          parent_id: "t1_c1",
                          body: "Capability scoped keys.",
                          author: "replyguy"
                        }
                      }
                    ]
                  }
                }
              }
            }
          ]
        }
      }
    ],
    "https://www.reddit.com/r/Moltbook/comments/abc123/private_agent_inboxes/"
  );

  assert.equal(thread.id, "abc123");
  assert.equal(thread.comments[0]?.id, "c1");
  assert.equal(thread.comments[0]?.parentId, "t3_abc123");
  assert.equal(thread.comments[0]?.replies?.[0]?.id, "c2");
  assert.equal(thread.comments[0]?.replies?.[0]?.parentId, "t1_c1");
});

test("unofficial client reads search and thread JSON via oauth bearer", async () => {
  const seen: Array<{ path: string; auth?: string }> = [];
  const client = new RedditUnofficialClient(
    {
      storageStatePath: "/unused",
      bearerOverride: "test-token-v2",
      publicBaseUrl: "https://www.reddit.com",
      oauthBaseUrl: "https://oauth.reddit.com",
      userAgent: "test-agent"
    },
    async (input, init) => {
      const url = new URL(input instanceof URL ? input.toString() : String(input));
      const auth = new Headers(init?.headers).get("Authorization") ?? undefined;
      seen.push({ path: `${url.pathname}?${url.searchParams.toString()}`, auth });
      if (url.pathname.endsWith("/search")) {
        return jsonResponse({
          data: {
            children: [
              {
                kind: "t3",
                data: {
                  id: "abc123",
                  subreddit: "Moltbook",
                  title: "Search hit",
                  permalink: "/r/Moltbook/comments/abc123/search_hit/"
                }
              }
            ]
          }
        });
      }
      return jsonResponse([
        {
          data: {
            children: [
              {
                kind: "t3",
                data: {
                  id: "abc123",
                  subreddit: "Moltbook",
                  title: "Search hit"
                }
              }
            ]
          }
        },
        { data: { children: [] } }
      ]);
    }
  );

  const results = await client.searchPosts("agent inbox", { subreddit: "Moltbook", limit: 5 });
  const thread = await client.scrapeThread("https://www.reddit.com/r/Moltbook/comments/abc123/search_hit/");

  assert.equal(results[0]?.id, "abc123");
  assert.equal(thread.title, "Search hit");
  assert.equal(seen.every((entry) => entry.auth === "Bearer test-token-v2"), true);
  assert.equal(seen.some((entry) => entry.path.startsWith("/r/Moltbook/search?")), true);
  assert.equal(seen.some((entry) => entry.path.startsWith("/r/Moltbook/comments/abc123.json?")), true);
});

test("unofficial client lists hot subreddit posts via oauth bearer", async () => {
  const seen: string[] = [];
  const client = new RedditUnofficialClient(
    {
      storageStatePath: "/unused",
      bearerOverride: "test-token-v2",
      oauthBaseUrl: "https://oauth.reddit.com",
      userAgent: "test-agent"
    },
    async (input) => {
      const url = new URL(input instanceof URL ? input.toString() : String(input));
      seen.push(`${url.pathname}?${url.searchParams.toString()}`);
      return jsonResponse({
        data: {
          children: [
            {
              kind: "t3",
              data: {
                id: "hot1",
                subreddit: "AI_Agents",
                title: "Hot thread",
                permalink: "/r/AI_Agents/comments/hot1/hot_thread/"
              }
            }
          ]
        }
      });
    }
  );

  const results = await client.listSubredditPosts("AI_Agents", { sort: "hot", limit: 5 });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.id, "hot1");
  assert.equal(seen[0]?.startsWith("/r/AI_Agents/hot?"), true);
});

test("unofficial controller posts top-level comments with t3 parent", async () => {
  const bodies: URLSearchParams[] = [];
  const controller = new RedditUnofficialController(createConfig(), async (_input, init) => {
    bodies.push(new URLSearchParams(String(init?.body)));
    return jsonResponse({ json: { data: { things: [{ id: "new-comment" }] } } });
  });

  await controller.publishAction(
    {
      id: "action-1",
      venue: "reddit",
      type: "comment_on_post",
      surface: "Moltbook",
      parentId: "abc123",
      content: "Short helpful comment."
    },
    { mode: "approved_autopost", allowedSurfaces: ["Moltbook"] }
  );

  assert.equal(bodies[0]?.get("thing_id"), "t3_abc123");
  assert.equal(bodies[0]?.get("text"), "Short helpful comment.");
});

test("unofficial client upvotes post via oauth vote endpoint", async () => {
  const bodies: URLSearchParams[] = [];
  const client = new RedditUnofficialClient(
    {
      storageStatePath: "/unused",
      bearerOverride: "test-token-v2",
      oauthBaseUrl: "https://oauth.reddit.com",
      userAgent: "test-agent"
    },
    async (_input, init) => {
      bodies.push(new URLSearchParams(String(init?.body)));
      return jsonResponse({ json: { errors: [] } });
    }
  );

  const result = await client.upvotePost("abc123");
  assert.equal(bodies[0]?.get("id"), "t3_abc123");
  assert.equal(bodies[0]?.get("dir"), "1");
  assert.equal(result.remoteContentId, "t3_abc123");
});

test("unofficial controller upvotes with t1 parent id", async () => {
  const bodies: URLSearchParams[] = [];
  const controller = new RedditUnofficialController(createConfig(), async (_input, init) => {
    bodies.push(new URLSearchParams(String(init?.body)));
    return jsonResponse({ json: { errors: [] } });
  });

  await controller.publishAction(
    {
      id: "action-upvote",
      venue: "reddit",
      type: "upvote_post",
      surface: "Moltbook",
      parentId: "t1_comment123"
    },
    { mode: "approved_autopost", allowedSurfaces: ["Moltbook"] }
  );

  assert.equal(bodies[0]?.get("id"), "t1_comment123");
  assert.equal(bodies[0]?.get("dir"), "1");
});

test("unofficial controller posts nested replies with t1 parent", async () => {
  const bodies: URLSearchParams[] = [];
  const controller = new RedditUnofficialController(createConfig(), async (_input, init) => {
    bodies.push(new URLSearchParams(String(init?.body)));
    return jsonResponse({ json: { data: { things: [{ id: "new-reply" }] } } });
  });

  await controller.publishAction(
    {
      id: "action-2",
      venue: "reddit",
      type: "reply_to_comment",
      surface: "Moltbook",
      candidateId: "c1",
      content: "Nested reply."
    },
    { mode: "approved_autopost", allowedSurfaces: ["Moltbook"] }
  );

  assert.equal(bodies[0]?.get("thing_id"), "t1_c1");
  assert.equal(bodies[0]?.get("text"), "Nested reply.");
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
