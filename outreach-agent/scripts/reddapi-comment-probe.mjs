#!/usr/bin/env node
/**
 * One-off ReddAPI write probe:
 * - reads bearer from Playwright reddit-storage-state.json (token_v2, then reddit_session)
 * - reads thread comments via ReddAPI
 * - posts a short top-level comment (requires REDDAPI_PROXY)
 *
 * Env:
 *   RAPIDAPI_REDDAPI_KEY   RapidAPI key for reddapi.p.rapidapi.com
 *   REDDAPI_PROXY          HTTP(S) proxy URL (required for writes)
 *   REDDAPI_BEARER         optional override instead of storage cookie
 *   REDDAPI_POST_URL       target thread (default: Moltbook 500-errors thread)
 *   REDDAPI_COMMENT_TEXT   optional comment body
 *   OUTREACH_REDDIT_BROWSER_STORAGE_STATE_PATH
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

const DEFAULT_POST_URL =
  "https://www.reddit.com/r/Moltbook/comments/1s4zubp/anyone_else_getting_api_errors_500_from_moltbook/";
const DEFAULT_COMMENT =
  "Yeah, we have seen the same 500s intermittently. When the API flakes, reading the thread in a normal browser session has been more reliable than retrying the same call in a loop.";

const rapidApiKey = process.env.RAPIDAPI_REDDAPI_KEY?.trim();
const proxy = process.env.REDDAPI_PROXY?.trim();
const postUrl = process.env.REDDAPI_POST_URL?.trim() || DEFAULT_POST_URL;
const commentText = process.env.REDDAPI_COMMENT_TEXT?.trim() || DEFAULT_COMMENT;
const storageStatePath =
  process.env.OUTREACH_REDDIT_BROWSER_STORAGE_STATE_PATH?.trim() ||
  path.join(packageRoot, ".browser", "reddit-storage-state.json");

function fail(message, details) {
  console.error(JSON.stringify({ ok: false, error: message, details }, null, 2));
  process.exit(1);
}

function cookieExpired(cookie) {
  if (!cookie || cookie.expires === -1) {
    return false;
  }
  return Number(cookie.expires) > 0 && Date.now() > Number(cookie.expires) * 1000;
}

function jwtExpiresAt(token) {
  const segment = token?.split(".")[1];
  if (!segment) {
    return undefined;
  }
  try {
    const payload = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

function jwtExpired(token) {
  const segment = token?.split(".")[1];
  if (!segment) {
    return false;
  }
  try {
    const payload = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return typeof payload.exp === "number" && Date.now() > payload.exp * 1000;
  } catch {
    return false;
  }
}

async function loadBearerFromStorage(filePath) {
  if (process.env.REDDAPI_BEARER?.trim()) {
    return { bearer: process.env.REDDAPI_BEARER.trim(), source: "env" };
  }

  const raw = await readFile(filePath, "utf8");
  const state = JSON.parse(raw);
  const cookies = Array.isArray(state.cookies) ? state.cookies : [];
  const tokenCookie = cookies.find((cookie) => cookie.name === "token_v2");
  if (!tokenCookie?.value) {
    fail("No token_v2 cookie in storage state.", {
      storageStatePath: filePath,
      hint: "Run: npm run reddit:login -w @coti-agent-messaging/outreach-agent"
    });
  }
  if (cookieExpired(tokenCookie) || jwtExpired(tokenCookie.value)) {
    fail("token_v2 bearer expired.", {
      storageStatePath: filePath,
      expiresAt: jwtExpiresAt(tokenCookie.value),
      hint: "Refresh with: npm run reddit:login -w @coti-agent-messaging/outreach-agent"
    });
  }
  return {
    bearer: tokenCookie.value,
    source: "token_v2",
    expiresAt: jwtExpiresAt(tokenCookie.value)
  };
}

async function reddapiRequest(route, { method = "GET", query, body } = {}) {
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

async function main() {
  if (!rapidApiKey) {
    fail("Missing RAPIDAPI_REDDAPI_KEY.");
  }
  if (!proxy) {
    fail("Missing REDDAPI_PROXY. ReddAPI write endpoints require a proxy URL.", {
      example: "http://user:pass@host:port"
    });
  }

  const bearerInfo = await loadBearerFromStorage(storageStatePath);

  const post = await reddapiRequest("/api/scrape_post", {
    query: { post_url: postUrl }
  });
  const comments = await reddapiRequest("/api/scrape_post_comments", {
    query: { post_url: postUrl }
  });

  const writeResult = await reddapiRequest("/api/comment", {
    method: "POST",
    body: {
      post_url: postUrl,
      text: commentText,
      bearer: bearerInfo.bearer,
      proxy
    }
  });
  const writeResults = [
    {
      route: "/api/comment",
      bodyKeys: ["post_url", "text", "bearer", "proxy"],
      status: writeResult.status,
      ok: writeResult.ok,
      payload: writeResult.payload
    }
  ];

  const verify = await reddapiRequest("/api/scrape_post_comments", {
    query: { post_url: postUrl }
  });

  const posted = writeResults.some((entry) => writeSucceeded(entry));

  console.log(
    JSON.stringify(
      {
        ok: posted,
        postUrl,
        bearerSource: bearerInfo.source,
        bearerExpiresAt: bearerInfo.expiresAt,
        storageStatePath,
        proxyConfigured: Boolean(proxy),
        read: {
          post: { status: post.status, payload: post.payload },
          commentsBefore: {
            status: comments.status,
            count: Array.isArray(comments.payload?.comments) ? comments.payload.comments.length : 0,
            comments: comments.payload?.comments
          }
        },
        writeAttempts: writeResults,
        verify: {
          status: verify.status,
          count: Array.isArray(verify.payload?.comments) ? verify.payload.comments.length : 0,
          comments: verify.payload?.comments
        }
      },
      null,
      2
    )
  );

  if (!posted) {
    process.exit(2);
  }
}

function writeSucceeded(result) {
  return result.ok && result.payload?.success === true;
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
