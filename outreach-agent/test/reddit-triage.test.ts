import test from "node:test";
import assert from "node:assert/strict";

import type { MoltbookRuntimeConfig } from "../src/config.js";
import type { JsonLlmProvider } from "../src/llm-client.js";
import {
  buildRedditTriageSignals,
  type RedditSourceItem
} from "../src/reddit-outreach.js";
import { triageRedditSourceItems } from "../src/reddit-triage.js";

function createMockTriageProvider(): JsonLlmProvider {
  return {
    label: "mock-triage",
    async createJsonCompletion<T>() {
      return {
        results: [
          {
            id: "comment:mcp:abc",
            relevant: true,
            helpIntent: "explicit_question",
            topicalFit: "strong",
            hostileOrBait: false,
            worthPublicReply: true,
            confidence: 0.9,
            reason: "Clear MCP agent messaging question."
          }
        ]
      } as T;
    }
  };
}

test("buildRedditTriageSignals overrides regex when LLM triage passes", () => {
  const source: RedditSourceItem = {
    id: "abc",
    kind: "comment",
    subreddit: "mcp",
    title: "Thread",
    body: "We are building private MCP channels for multi-agent coordination without a question mark."
  };
  const signals = buildRedditTriageSignals({
    source,
    now: new Date("2026-06-01T12:00:00.000Z"),
    triage: {
      relevant: true,
      helpIntent: "discussion",
      topicalFit: "strong",
      hostileOrBait: false,
      worthPublicReply: true,
      confidence: 0.9,
      reason: "On-topic discussion.",
      source: "llm"
    }
  });
  assert.equal(signals.hasExplicitIntent, true);
  assert.equal(signals.passesDiscoveryFit, true);
});

test("triageRedditSourceItems uses LLM provider when configured", async () => {
  const config = {
    packageRoot: "/tmp",
    projectRoot: "/tmp",
    credentialsPath: "/tmp/creds",
    statePath: "/tmp/state",
    heartbeatReportPath: "/tmp/hb",
    moltbookBaseUrl: "https://example.com",
    defaultSubmolt: "general",
    dryRun: true,
    autoVerify: false,
    llmProvider: createMockTriageProvider()
  } satisfies MoltbookRuntimeConfig;

  const items: RedditSourceItem[] = [
    {
      id: "abc",
      kind: "comment",
      subreddit: "mcp",
      title: "How do you route MCP messages?",
      body: "Looking for patterns for encrypted agent-to-agent messaging."
    }
  ];

  const batch = await triageRedditSourceItems({
    config,
    items,
    targeting: {
      productName: "test",
      targetAudience: "builders",
      productAliases: ["coti"],
      targetSubreddits: [{ name: "mcp", audience: "builders", rationale: "fit", priority: "primary" }]
    },
    maxItems: 5
  });

  assert.equal(batch.triagedCount, 1);
  const triage = batch.byItemId.get("comment:mcp:abc");
  assert.equal(triage?.worthPublicReply, true);
  assert.equal(triage?.source, "llm");
});
