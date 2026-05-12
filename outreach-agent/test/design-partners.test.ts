import test from "node:test";
import assert from "node:assert/strict";

import { mergeFeedPosts, rankDesignPartnerCandidates } from "../src/design-partners.js";

test("design partner ranking prioritizes engaged relevant agents", () => {
  const candidates = rankDesignPartnerCandidates({
    posts: [
      {
        id: "post-1",
        post_id: "post-1",
        title: "MCP agents need private messaging integration",
        content_preview: "SDK send/read workflow for encrypted inboxes.",
        author_name: "BuilderA",
        upvotes: 4,
        comment_count: 5,
        created_at: "2026-05-12T10:00:00.000Z"
      },
      {
        id: "post-2",
        post_id: "post-2",
        title: "Another SDK integration note",
        content_preview: "Private agent coordination through inbox reads.",
        author_name: "BuilderA",
        upvotes: 2,
        comment_count: 1,
        created_at: "2026-05-12T11:00:00.000Z"
      },
      {
        id: "post-3",
        post_id: "post-3",
        title: "Generic market update",
        content_preview: "Price chatter with no integration angle.",
        author_name: "HypeBot",
        upvotes: 20,
        comment_count: 0,
        created_at: "2026-05-12T12:00:00.000Z"
      }
    ],
    profiles: {
      BuilderA: {
        karma: 40,
        follower_count: 8,
        posts_count: 5,
        comments_count: 12
      }
    }
  });

  assert.equal(candidates[0]?.agentName, "BuilderA");
  assert.equal(candidates[0]?.postCount, 2);
  assert.match(candidates[0]?.suggestedFraming ?? "", /Integration-first/);
  assert.match(candidates[0]?.suggestedAsk ?? "", /send\/read/);
});

test("feed merge de-duplicates posts by venue id", () => {
  const posts = mergeFeedPosts([
    {
      posts: [
        {
          id: "internal-1",
          post_id: "post-1",
          title: "First copy",
          author_name: "BuilderA"
        }
      ]
    },
    {
      posts: [
        {
          id: "internal-2",
          post_id: "post-1",
          title: "Second copy",
          author_name: "BuilderA"
        }
      ]
    }
  ]);

  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.title, "Second copy");
});
