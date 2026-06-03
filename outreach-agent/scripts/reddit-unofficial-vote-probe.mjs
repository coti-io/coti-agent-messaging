#!/usr/bin/env node
/**
 * Live vote probe for unofficial Reddit transport.
 *
 * Usage:
 *   npm run reddit:unofficial:vote-probe -w @coti-agent-messaging/outreach-agent -- --post-id abc123
 *   npm run reddit:unofficial:vote-probe -w @coti-agent-messaging/outreach-agent -- --comment-id xyz789
 *   npm run reddit:unofficial:vote-probe -w @coti-agent-messaging/outreach-agent -- --post-id abc123 --clear
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const postIdArg = args.find((entry) => entry.startsWith("--post-id="))?.split("=")[1]
  ?? (args.includes("--post-id") ? args[args.indexOf("--post-id") + 1] : undefined);
const commentIdArg = args.find((entry) => entry.startsWith("--comment-id="))?.split("=")[1]
  ?? (args.includes("--comment-id") ? args[args.indexOf("--comment-id") + 1] : undefined);
const clearVote = args.includes("--clear");

async function main() {
  const { buildUnofficialRedditRuntimeConfig, RedditUnofficialClient } = await import(
    path.join(packageRoot, "dist/src/reddit-unofficial.js")
  );

  if (!postIdArg && !commentIdArg) {
    console.error("Provide --post-id ID or --comment-id ID");
    process.exit(1);
  }
  if (postIdArg && commentIdArg) {
    console.error("Provide only one of --post-id or --comment-id");
    process.exit(1);
  }

  const config = buildUnofficialRedditRuntimeConfig();
  const client = new RedditUnofficialClient(config);
  const direction = clearVote ? "clear" : "up";

  if (commentIdArg) {
    const result = clearVote
      ? await client.voteOnThing({ thingId: `t1_${commentIdArg.replace(/^t1_/, "")}`, direction })
      : await client.upvoteComment(commentIdArg);
    console.log(`Vote ${direction} on comment t1_${commentIdArg.replace(/^t1_/, "")}:`, result.remoteContentId);
  } else {
    const result = clearVote
      ? await client.voteOnThing({ thingId: `t3_${postIdArg.replace(/^t3_/, "")}`, direction })
      : await client.upvotePost(postIdArg);
    console.log(`Vote ${direction} on post t3_${postIdArg.replace(/^t3_/, "")}:`, result.remoteContentId);
  }

  console.log("Vote probe OK.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
