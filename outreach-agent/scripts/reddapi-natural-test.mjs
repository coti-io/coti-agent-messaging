#!/usr/bin/env node
/**
 * Small ReddAPI smoke test: read a thread, pick a comment, post a short reply.
 *
 *   npm run reddit:reddapi-test -w @coti-agent-messaging/outreach-agent
 *
 * Env: RAPIDAPI_REDDAPI_KEY, REDDAPI_PROXY, repo-root .env
 * Bearer: token_v2 from OUTREACH_REDDIT_BROWSER_STORAGE_STATE_PATH
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(packageRoot, "..");
for (const envPath of [path.join(projectRoot, ".env"), path.join(packageRoot, ".env")]) {
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath, override: false });
  }
}

const POST_URL =
  process.env.REDDAPI_POST_URL?.trim() ||
  "https://www.reddit.com/r/Moltbook/comments/1s4zubp/anyone_else_getting_api_errors_500_from_moltbook/";
const rapidApiKey = process.env.RAPIDAPI_REDDAPI_KEY?.trim();
const proxy = process.env.REDDAPI_PROXY?.trim();
const storageStatePath =
  process.env.OUTREACH_REDDIT_BROWSER_STORAGE_STATE_PATH?.trim() ||
  path.join(packageRoot, ".browser", "reddit-storage-state.json");
const selfAuthors = new Set(
  (process.env.REDDAPI_SKIP_AUTHORS || "VLD-C-77")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
);

function fail(message, details) {
  console.error(JSON.stringify({ ok: false, error: message, details }, null, 2));
  process.exit(1);
}

function jwtExpired(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" && Date.now() > payload.exp * 1000;
  } catch {
    return true;
  }
}

async function loadBearer() {
  const state = JSON.parse(await readFile(storageStatePath, "utf8"));
  const token = state.cookies?.find((cookie) => cookie.name === "token_v2")?.value;
  if (!token || jwtExpired(token)) {
    fail("token_v2 missing or expired — run reddit:login first.", { storageStatePath });
  }
  return token;
}

async function reddapi(route, { method = "GET", query, body } = {}) {
  const url = new URL(`https://reddapi.p.rapidapi.com${route}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-rapidapi-host": "reddapi.p.rapidapi.com",
      "x-rapidapi-key": rapidApiKey
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  return { ok: response.ok, status: response.status, payload };
}

function pickTargetComment(comments) {
  const candidates = comments.filter((entry) => !selfAuthors.has(entry.author));
  return candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
}

function draftReply(target) {
  const text = target.comment.toLowerCase();
  if (text.includes("500") || text.includes("api error")) {
    return "Same here — when the API throws 500s, backing off retries and using a normal browser session has been less painful than hammering the same endpoint.";
  }
  if (text.includes("headless") || text.includes("browser")) {
    return "That tracks. We have had better luck switching to browser reads when the API is flaky instead of retrying in a tight loop.";
  }
  return "Interesting approach — curious if that stayed stable once the API came back.";
}

async function main() {
  if (!rapidApiKey) fail("Missing RAPIDAPI_REDDAPI_KEY.");
  if (!proxy) fail("Missing REDDAPI_PROXY.");

  const bearer = await loadBearer();
  const before = await reddapi("/api/scrape_post_comments", { query: { post_url: POST_URL } });
  if (!before.payload?.success) {
    fail("Could not read comments.", before);
  }

  const comments = before.payload.comments ?? [];
  const target = pickTargetComment(comments);
  if (!target) {
    fail("No comment to reply to.", { commentCount: comments.length });
  }

  const replyText = process.env.REDDAPI_COMMENT_TEXT?.trim() || draftReply(target);
  const write = await reddapi("/api/comment", {
    method: "POST",
    body: { post_url: POST_URL, text: replyText, bearer, proxy }
  });

  const after = await reddapi("/api/scrape_post_comments", { query: { post_url: POST_URL } });
  const afterComments = after.payload?.comments ?? [];
  const posted = Boolean(
    write.payload?.success === true &&
      afterComments.some(
        (entry) =>
          entry.author && !comments.some((c) => c.comment === entry.comment && c.author === entry.author) &&
          entry.comment?.includes(replyText.slice(0, 40))
      )
  );

  console.log(
    JSON.stringify(
      {
        ok: write.payload?.success === true,
        postUrl: POST_URL,
        repliedTo: { author: target.author, score: target.score, excerpt: target.comment.slice(0, 120) },
        postedText: replyText,
        write: { status: write.status, payload: write.payload },
        commentCount: { before: comments.length, after: afterComments.length },
        scrapeShowsNewComment: posted
      },
      null,
      2
    )
  );

  if (write.payload?.success !== true) {
    process.exit(2);
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
