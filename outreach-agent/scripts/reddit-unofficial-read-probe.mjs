#!/usr/bin/env node
/**
 * Live read probe for unofficial Reddit transport (public JSON).
 *
 * Usage:
 *   npm run reddit:unofficial:read-probe -w @coti-agent-messaging/outreach-agent
 *
 * Optional env:
 *   OUTREACH_REDDIT_UNOFFICIAL_SUBREDDIT=test
 *   OUTREACH_REDDIT_UNOFFICIAL_SEARCH_QUERY=hello
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

const subreddit = process.env.OUTREACH_REDDIT_UNOFFICIAL_SUBREDDIT?.trim() || "test";
const query = process.env.OUTREACH_REDDIT_UNOFFICIAL_SEARCH_QUERY?.trim() || "hello";

async function main() {
  const { buildUnofficialRedditRuntimeConfig, RedditUnofficialClient } = await import(
    path.join(packageRoot, "dist/src/reddit-unofficial.js")
  );

  const config = buildUnofficialRedditRuntimeConfig();
  const client = new RedditUnofficialClient({
    storageStatePath: config.storageStatePath,
    publicBaseUrl: config.publicBaseUrl,
    oauthBaseUrl: config.oauthBaseUrl,
    userAgent: config.userAgent
  });

  console.log(`Searching r/${subreddit} for "${query}"...`);
  const results = await client.searchPosts(query, { subreddit, limit: 3 });
  if (results.length === 0) {
    console.error("No search results.");
    process.exit(1);
  }

  const hit = results[0];
  console.log(`Search hit: ${hit.title} (${hit.id})`);
  console.log(`URL: ${hit.url}`);

  console.log(`Listing hot on r/${subreddit}...`);
  const hot = await client.listSubredditPosts(subreddit, { sort: "hot", limit: 3 });
  console.log(`Hot posts: ${hot.length}`);
  if (hot[0]) {
    console.log(`Hot top: ${hot[0].title} (${hot[0].id})`);
  }

  const postUrl = hit.url;
  if (!postUrl) {
    console.error("Search hit missing URL.");
    process.exit(1);
  }

  const thread = await client.scrapeThread(postUrl);
  console.log(`Thread: ${thread.title}`);
  console.log(`Comments scraped: ${thread.comments.length} (reported: ${thread.commentCount ?? "?"})`);
  if (thread.comments[0]) {
    console.log(`First comment by u/${thread.comments[0].author ?? "?"}: ${thread.comments[0].body.slice(0, 120)}`);
  }
  console.log("Read probe OK.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
