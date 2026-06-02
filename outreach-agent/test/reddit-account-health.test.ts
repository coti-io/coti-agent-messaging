import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { buildRedditControllerConfig, type MoltbookRuntimeConfig } from "../src/config.js";
import { checkRedditAccountHealth } from "../src/reddit-account-health.js";
import { RedditUnofficialClient } from "../src/reddit-unofficial.js";

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

test("checkRedditAccountHealth reports active authenticated account", async () => {
  const fetchImpl = async (url: string | URL) => {
    assert.match(String(url), /\/api\/v1\/me/);
    return new Response(
      JSON.stringify({
        name: "reddit-user",
        is_suspended: false
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const health = await checkRedditAccountHealth(createConfig(), fetchImpl as typeof fetch);
  assert.equal(health.status, "active");
  assert.equal(health.username, "reddit-user");
});

test("checkRedditAccountHealth reports suspended account", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        name: "reddit-user",
        is_suspended: true
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const health = await checkRedditAccountHealth(createConfig(), fetchImpl as typeof fetch);
  assert.equal(health.status, "suspended");
});

test("RedditUnofficialClient checkAccountHealth rejects username mismatch", async () => {
  const client = new RedditUnofficialClient(
    {
      proxy: "http://proxy.test:3128",
      storageStatePath: "/tmp/unused.json",
      bearerOverride: "test-token-v2",
      oauthBaseUrl: "https://oauth.reddit.com",
      userAgent: "test-agent"
    },
    (async () =>
      new Response(
        JSON.stringify({
          name: "other-user",
          is_suspended: false
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof fetch
  );

  const health = await client.checkAccountHealth("reddit-user");
  assert.equal(health.status, "session_invalid");
  assert.match(health.reason, /other-user/);
});
