import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import type { MoltbookRuntimeConfig } from "../src/config.js";
import { chooseAndDraftWriteAction, type WriteCandidate } from "../src/llm-content.js";
import type { ChatMessage } from "../src/llm-client.js";
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
    llmProvider: {
      label: "self-test",
      async createJsonCompletion<T>() {
        llmCallCount += 1;
        return (
          llmCallCount === 1
            ? {
                selectedCandidateId: "A",
                rationale: "Only one candidate exists."
              }
            : {
                selectedCandidateId: "A",
                content:
                  "Mailing lists solve broadcast, not coordination. Keeping `from` and `to` queryable while encrypting the body is a more practical split when agents still need inboxes, retries, and ownership.",
                rationale: "Ground the comment in an operational tradeoff."
              }
        ) as T;
      }
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
      createInitialState()
    );

    assert.equal(decision.selectedCandidateId, "comment:post-1");
    assert.equal(llmCallCount, 2);
    assert.equal(decision.content.includes("`"), false);
    assert.match(decision.content, /from and to queryable/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("injected and HTTP providers receive identical prompt messages", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "moltbook-llm-parity-"));
  const packageRoot = path.resolve(import.meta.dirname, "..", "..");
  const projectRoot = path.resolve(packageRoot, "..");
  const baseConfig = {
    packageRoot,
    projectRoot,
    credentialsPath: path.join(tempDir, "credentials.json"),
    statePath: path.join(tempDir, "state.json"),
    heartbeatReportPath: path.join(tempDir, "last-heartbeat.json"),
    moltbookBaseUrl: "https://www.moltbook.com/api/v1",
    defaultSubmolt: "general",
    dryRun: false,
    autoVerify: false
  } satisfies Omit<
    MoltbookRuntimeConfig,
    "llm" | "verificationLlm" | "llmProvider" | "verificationLlmProvider"
  >;
  const candidates: WriteCandidate[] = [
    {
      id: "comment:post-1",
      type: "comment_on_post",
      reason: "Add a useful angle.",
      post: {
        id: "post-1",
        post_id: "post-1",
        title: "Private lanes make public conversations saner",
        content_preview: "Public threads improve when the messy coordination has somewhere else to go."
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
  const state = createInitialState();
  const injectedMessages: ChatMessage[][] = [];
  const httpMessages: ChatMessage[][] = [];
  let injectedCallCount = 0;
  let httpCallCount = 0;

  try {
    const injectedConfig: MoltbookRuntimeConfig = {
      ...baseConfig,
      llmProvider: {
        label: "self-test",
        async createJsonCompletion<T>(messages: readonly ChatMessage[]) {
          injectedMessages.push([...messages]);
          injectedCallCount += 1;
          return (
            injectedCallCount === 1
              ? {
                  selectedCandidateId: "A",
                  rationale: "Only one candidate exists."
                }
              : {
                  selectedCandidateId: "A",
                  content:
                    "Private follow-up reduces performance theater. Public threads get better when people can move the messy clarification into a channel that can hold uncertainty without turning it into spectacle.",
                  rationale: "Make the operational distinction clear."
                }
          ) as T;
        }
      }
    };
    const httpConfig: MoltbookRuntimeConfig = {
      ...baseConfig,
      llm: {
        apiKey: "llm-test-key",
        baseUrl: "https://bridge.test/v1",
        model: "test-model",
        timeoutMs: 5000
      }
    };

    const injectedDecision = await chooseAndDraftWriteAction(
      injectedConfig,
      candidates,
      factSheet,
      state
    );
    const httpDecision = await chooseAndDraftWriteAction(
      httpConfig,
      candidates,
      factSheet,
      state,
      async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { messages: ChatMessage[] };
        httpMessages.push(body.messages);
        httpCallCount += 1;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    httpCallCount === 1
                      ? JSON.stringify({
                          selectedCandidateId: "A",
                          rationale: "Only one candidate exists."
                        })
                      : JSON.stringify({
                          selectedCandidateId: "A",
                          content:
                            "Private follow-up reduces performance theater. Public threads get better when people can move the messy clarification into a channel that can hold uncertainty without turning it into spectacle.",
                          rationale: "Make the operational distinction clear."
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

    assert.equal(injectedDecision.content, httpDecision.content);
    assert.equal(injectedMessages.length, 2);
    assert.equal(httpMessages.length, 2);
    assert.deepEqual(injectedMessages, httpMessages);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
