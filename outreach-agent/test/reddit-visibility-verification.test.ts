import test from "node:test";
import assert from "node:assert/strict";

import { verifyPublicRedditCommentVisibility } from "../src/reddit-visibility-verification.js";

function createThreadListing(postId: string, comments: Array<{ id: string; body: string }>): unknown[] {
  return [
    {
      data: {
        children: [
          {
            kind: "t3",
            data: {
              id: postId,
              subreddit: "AI_Agents",
              title: "Thread title",
              selftext: "Thread body"
            }
          }
        ]
      }
    },
    {
      data: {
        children: comments.map((comment) => ({
          kind: "t1",
          data: {
            id: comment.id,
            body: comment.body,
            author: "builder",
            parent_id: `t3_${postId}`,
            replies: ""
          }
        }))
      }
    }
  ];
}

test("public visibility verifier matches a comment by remote content id", async () => {
  const result = await verifyPublicRedditCommentVisibility({
    subreddit: "AI_Agents",
    threadPostId: "post-1",
    remoteContentId: "reply-1",
    remoteContentUrl: "https://www.reddit.com/r/AI_Agents/comments/post-1/_/reply-1/",
    content: "Use a transport interface and encrypt payloads per tool.",
    fetchImpl: async () => new Response(JSON.stringify(createThreadListing("post-1", [
      {
        id: "reply-1",
        body: "Use a transport interface and encrypt payloads per tool."
      }
    ])))
  });

  assert.equal(result.visible, true);
  assert.equal(result.matchedCommentId, "reply-1");
  assert.equal(result.reason, "visible");
});

test("public visibility verifier falls back to a content snippet match", async () => {
  const content =
    "Short answer: keep the control plane public, move sensitive state to a separate encrypted transport, and let tools exchange references instead of raw payloads.";
  const result = await verifyPublicRedditCommentVisibility({
    subreddit: "AI_Agents",
    threadPostId: "post-1",
    remoteContentId: "missing-id",
    remoteContentUrl: "https://www.reddit.com/r/AI_Agents/comments/post-1/_/missing-id/",
    content,
    fetchImpl: async () => new Response(JSON.stringify(createThreadListing("post-1", [
      {
        id: "reply-snippet",
        body: content
      }
    ])))
  });

  assert.equal(result.visible, true);
  assert.equal(result.matchedCommentId, "reply-snippet");
});

test("public visibility verifier reports not_found when the reply is absent", async () => {
  const result = await verifyPublicRedditCommentVisibility({
    subreddit: "AI_Agents",
    threadPostId: "post-1",
    remoteContentId: "reply-hidden",
    remoteContentUrl: "https://www.reddit.com/r/AI_Agents/comments/post-1/_/reply-hidden/",
    content: "This reply never shows up publicly.",
    fetchImpl: async () => new Response(JSON.stringify(createThreadListing("post-1", [])))
  });

  assert.equal(result.visible, false);
  assert.equal(result.reason, "not_found");
});
