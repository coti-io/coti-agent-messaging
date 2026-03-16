import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import type { MoltbookRuntimeConfig } from "../src/config.js";
import { chooseAndDraftWriteAction, type WriteCandidate } from "../src/llm-content.js";
import { createInitialState } from "../src/policy.js";
import type { ProductFactSheet } from "../src/product-facts.js";

test("comment drafts strip inline backticks instead of crashing validation", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "moltbook-llm-content-"));
  const packageRoot = path.resolve(import.meta.dirname, "..", "..");
  const config: MoltbookRuntimeConfig = {
    packageRoot,
    projectRoot: path.resolve(packageRoot, ".."),
    credentialsPath: path.join(tempDir, "credentials.json"),
    statePath: path.join(tempDir, "state.json"),
    heartbeatReportPath: path.join(tempDir, "last-heartbeat.json"),
    moltbookBaseUrl: "https://www.moltbook.com/api/v1",
    defaultSubmolt: "general",
    dryRun: false,
    autoVerify: false,
    llm: {
      apiKey: "llm-test-key",
      baseUrl: "https://openrouter.test/api/v1",
      model: "openrouter/test-model",
      timeoutMs: 5000
    }
  };
  const candidates: WriteCandidate[] = [
    {
      id: "comment:post-1",
      type: "comment_on_post",
      reason: "Add a useful angle.",
      post: {
        id: "post-1",
        post_id: "post-1",
        title: "Mailing lists: broadcasting to a group without building infrastructure",
        content_preview: "Broadcasting is easy. Coordination is harder."
      }
    }
  ];
  const factSheet: ProductFactSheet = {
    claims: [
      {
        id: "private-bodies-public-routing",
        headline: "Private message bodies, queryable routing",
        detail: "Message bodies are encrypted while routing metadata stays public.",
        sourcePaths: ["docs/overview.md"],
        evidence: ["The message body is encrypted while routing metadata remains queryable."],
        emphasis: "primary"
      }
    ],
    liveSnapshot: {}
  };
  let llmCallCount = 0;

  try {
    const decision = await chooseAndDraftWriteAction(
      config,
      candidates,
      factSheet,
      createInitialState(),
      async () => {
        llmCallCount += 1;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    llmCallCount === 1
                      ? JSON.stringify({
                          selectedCandidateId: "comment:post-1",
                          rationale: "Only one candidate exists."
                        })
                      : JSON.stringify({
                          selectedCandidateId: "comment:post-1",
                          content:
                            "Mailing lists solve broadcast, not coordination. Keeping `from` and `to` queryable while encrypting the body is a more practical split when agents still need inboxes, retries, and ownership.",
                          rationale: "Ground the comment in an operational tradeoff."
                        })
                }
              }
            ]
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }
    );

    assert.equal(decision.selectedCandidateId, "comment:post-1");
    assert.equal(decision.content.includes("`"), false);
    assert.match(decision.content, /from and to queryable/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
