import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import type { MoltbookRuntimeConfig } from "../src/config.js";
import {
  chooseAndDraftWriteAction,
  chooseReplyTargetOrIgnore,
  type WriteCandidate
} from "../src/llm-content.js";
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

test("comment and reply prompts require a natural COTI attribution anchor", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "moltbook-llm-attribution-"));
  const packageRoot = path.resolve(import.meta.dirname, "..", "..");
  const capturedMessages: ChatMessage[][] = [];
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
      async createJsonCompletion<T>(messages: readonly ChatMessage[]) {
        capturedMessages.push([...messages]);
        return (
          capturedMessages.length === 1
            ? {
                selectedCandidateId: "A",
                rationale: "Only one candidate exists."
              }
            : {
                selectedCandidateId: "A",
                content:
                  "Private follow-up matters because public threads should not carry every coordination detail. That is why COTI private messaging is a more practical fit here.",
                rationale: "Anchor the mechanics back to COTI."
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
        title: "Public threads are terrible for real coordination",
        content_preview: "Most systems make everything public, then wonder why people retreat to side channels."
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

  try {
    const decision = await chooseAndDraftWriteAction(
      config,
      candidates,
      factSheet,
      createInitialState()
    );

    assert.match(decision.content, /coti/i);
    assert.equal(capturedMessages.length, 2);

    const selectionSystemPrompt = String(capturedMessages[0]?.[0]?.content ?? "");
    const draftSystemPrompt = String(capturedMessages[1]?.[0]?.content ?? "");

    assert.match(selectionSystemPrompt, /natural breadcrumb back to COTI/i);
    assert.match(draftSystemPrompt, /explicit attribution anchor to COTI/i);
    assert.match(draftSystemPrompt, /natural breadcrumb back to COTI/i);
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

test("reply gate can ignore low-signal candidates", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "moltbook-reply-gate-"));
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
        return {
          selectedCommentId: "ignore",
          rationale: "Both comments are generic hype and do not engage the post."
        } as T;
      }
    }
  };
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

  try {
    const decision = await chooseReplyTargetOrIgnore(
      config,
      {
        postTitle: "Why agents need private inboxes",
        targets: [
          {
            commentId: "comment-1",
            postId: "post-1",
            authorName: "dustypath",
            content: "Loving the mbc-20 ecosystem"
          },
          {
            commentId: "comment-2",
            postId: "post-1",
            authorName: "driveby",
            content: "Great project"
          }
        ]
      },
      factSheet,
      createInitialState()
    );

    assert.equal(decision.target, undefined);
    assert.match(decision.rationale, /generic hype/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Moltbook CTA profile injects style layout and tracked URL into drafts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "moltbook-llm-cta-"));
  const packageRoot = path.resolve(import.meta.dirname, "..", "..");
  const capturedMessages: ChatMessage[][] = [];
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
    promptProfileId: "aggressive-structured",
    attributionCampaignId: "private_messaging",
    agentId: "OutreachBot",
    ctaBaseUrl: "https://example.com/agent-messaging",
    ctaApprovedDomains: ["example.com"],
    promptProfile: {
      id: "aggressive-structured",
      parameters: {
        messageStyle: "aggressive",
        layout: "structured_bullets",
        aggression: "high",
        ctaStyle: "direct_next_step"
      }
    },
    llmProvider: {
      label: "self-test",
      async createJsonCompletion<T>(messages: readonly ChatMessage[]) {
        capturedMessages.push([...messages]);
        if (capturedMessages.length === 1) {
          return {
            selectedCandidateId: "A",
            rationale: "Only one candidate exists."
          } as T;
        }

        const ctaMatch = String(messages[1]?.content ?? "").match(/https:\/\/example\.com\/agent-messaging[^\s"]+/);
        return {
          selectedCandidateId: "A",
          title: "Private coordination needs a real lane",
          content: [
            "- Public threads are fine for discovery, not coordination.",
            "- Private message bodies are the missing operational layer.",
            ctaMatch?.[0] ?? "https://example.com/agent-messaging"
          ].join("\n"),
          rationale: "Use structured layout and include the tracked CTA."
        } as T;
      }
    }
  };
  const candidates: WriteCandidate[] = [
    {
      id: "create-post",
      type: "create_post",
      reason: "Create a top-level post about private coordination."
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

  try {
    const decision = await chooseAndDraftWriteAction(
      config,
      candidates,
      factSheet,
      createInitialState()
    );

    assert.equal(decision.promptProfileId, "aggressive-structured");
    assert.equal(decision.promptParameters?.messageStyle, "aggressive");
    assert.equal(decision.layout, "structured_bullets");
    assert.match(decision.ctaUrl ?? "", /utm_source=moltbook/);
    assert.match(decision.ctaUrl ?? "", /utm_content=.*aggressive/);
    assert.match(decision.content, /https:\/\/example\.com\/agent-messaging/);
    assert.equal(decision.outreachRef?.messageStyle, "aggressive");
    assert.equal(decision.outreachRef?.layout, "structured_bullets");
    assert.equal(decision.outreachRef?.venueAccountId, "OutreachBot");
    assert.deepEqual(decision.outreachRef?.promptParameters.messageStyle, "aggressive");
    const draftPrompt = String(capturedMessages[1]?.[0]?.content ?? "");
    assert.match(draftPrompt, /Message style: aggressive/i);
    assert.match(draftPrompt, /Layout: structured_bullets/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create_post drafts trim overlong title and content without dropping tracked CTA", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "moltbook-llm-trim-"));
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
    promptProfileId: "aggressive-structured",
    attributionCampaignId: "private_messaging",
    agentId: "OutreachBot",
    ctaBaseUrl: "https://example.com/agent-messaging",
    ctaApprovedDomains: ["example.com"],
    promptProfile: {
      id: "aggressive-structured",
      parameters: {
        messageStyle: "aggressive",
        layout: "structured_bullets",
        aggression: "high",
        ctaStyle: "direct_next_step"
      }
    },
    llmProvider: {
      label: "self-test",
      async createJsonCompletion<T>(messages: readonly ChatMessage[]) {
        if (String(messages[0]?.content ?? "").includes("selecting exactly one authored Moltbook action")) {
          return {
            selectedCandidateId: "A",
            rationale: "Only one candidate exists."
          } as T;
        }

        const ctaMatch = String(messages[1]?.content ?? "").match(/https:\/\/example\.com\/agent-messaging[^\s"]+/);
        return {
          selectedCandidateId: "A",
          title: "Overlong title ".repeat(10).trim(),
          content: `${"Strong claim. ".repeat(120).trim()}\n\n${ctaMatch?.[0] ?? "https://example.com/agent-messaging"}`,
          rationale: "Force local trimming instead of failing the heartbeat."
        } as T;
      }
    }
  };
  const candidates: WriteCandidate[] = [
    {
      id: "create-post",
      type: "create_post",
      reason: "Create one top-level post."
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

  try {
    const decision = await chooseAndDraftWriteAction(
      config,
      candidates,
      factSheet,
      createInitialState()
    );

    assert.ok(decision.title);
    assert.equal(decision.title.length <= 110, true);
    assert.equal(decision.content.length <= 1_100, true);
    assert.match(decision.title, /\.\.\.$/);
    assert.match(decision.content, /https:\/\/example\.com\/agent-messaging/);
    assert.match(decision.ctaUrl ?? "", /utm_source=moltbook/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
