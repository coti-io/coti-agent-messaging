import test from "node:test";
import assert from "node:assert/strict";

import {
  RedditDraftGenerationError,
  buildRedditDraftValidationSpec,
  draftRedditResponse,
  redditDraftValidationSpecToPromptText,
  validateRedditDraft
} from "../src/reddit-drafting.js";
import { DEFAULT_REDDIT_TARGETING, type RedditReviewItem } from "../src/reddit-outreach.js";
import type { JsonLlmProvider } from "../src/llm-client.js";
import type { MoltbookRuntimeConfig } from "../src/config.js";
import { resolvePromptProfile } from "../src/prompt-profile.js";

function createConfig(llmProvider?: JsonLlmProvider): MoltbookRuntimeConfig {
  const packageRoot = "/tmp/outreach-agent";
  return {
    packageRoot,
    projectRoot: packageRoot,
    credentialsPath: "/tmp/credentials.json",
    statePath: "/tmp/state.json",
    heartbeatReportPath: "/tmp/heartbeat.json",
    moltbookBaseUrl: "https://www.moltbook.com/api/v1",
    defaultSubmolt: "general",
    dryRun: true,
    autoVerify: false,
    llmProvider
  };
}

function createReviewItem(): RedditReviewItem {
  return {
    id: "comment-1",
    source: {
      id: "comment-1",
      kind: "comment",
      subreddit: "AI_Agents",
      title: "Agent messaging between services",
      parentTitle: "Agent messaging between services",
      body: "How do you handle private agent-to-agent messaging when tools need encrypted coordination?",
      onOwnThread: false,
      threadPostId: "post-1"
    },
    action: "answer_publicly",
    status: "needs_human_review",
    relevanceScore: 8,
    riskScore: 1,
    draft: undefined,
    explicitProductInterest: false,
    privateMessageAssessment: {
      shouldEscalate: false,
      requiresPublicReplyFirst: false,
      explanation: "No escalation."
    },
    publicValueDeliveredFirst: true,
    whyRelevant: "agent messaging",
    gates: [],
    approvalRequired: true,
    approvalChecklist: []
  };
}

const validHookDraft =
  "Fair point. For agent-to-agent messaging, I keep transport separate from authorization: one channel for delivery, explicit capability checks before any side effect, and an audit log the operator can read without replaying the whole thread.";

function createMockLlmProvider(responses: string[]): JsonLlmProvider {
  let callIndex = 0;
  return {
    label: "mock",
    async createJsonCompletion<T>() {
      const content = responses[Math.min(callIndex, responses.length - 1)];
      callIndex += 1;
      return { content } as T;
    }
  };
}

test("buildRedditDraftValidationSpec mirrors enforceable draft rules", () => {
  const profile = resolvePromptProfile({
    venue: "reddit",
    actionType: "comment_on_post",
    parameterOverrides: {
      responseLength: "standard",
      layout: "short_hook_then_detail",
      humor: "none"
    }
  });
  const spec = buildRedditDraftValidationSpec({
    profile,
    productAliases: ["coti", "web4"],
    maxChars: 650
  });
  assert.equal(spec.maxCharacters, 650);
  assert.deepEqual(spec.forbiddenProductAliases, ["coti", "web4"]);
  assert.ok(spec.layoutRules.some((rule) => rule.includes("650")));
  assert.ok(spec.layoutRules.some((rule) => rule.includes("hook")));
  const prompt = redditDraftValidationSpecToPromptText(spec);
  assert.match(prompt, /hookThenSubstanceLayout/);
  assert.match(prompt, /coti, web4/);
});

test("draftRedditResponse requires an LLM provider", async () => {
  await assert.rejects(
    () =>
      draftRedditResponse({
        config: createConfig(),
        item: createReviewItem(),
        targeting: DEFAULT_REDDIT_TARGETING,
        actionType: "comment_on_post"
      }),
    RedditDraftGenerationError
  );
});

test("draftRedditResponse returns validated LLM output", async () => {
  const draft = await draftRedditResponse({
    config: createConfig(createMockLlmProvider([validHookDraft])),
    item: createReviewItem(),
    targeting: DEFAULT_REDDIT_TARGETING,
    actionType: "comment_on_post",
    promptParameterOverrides: {
      responseLength: "brief",
      layout: "short_hook_then_detail",
      humor: "none"
    }
  });

  assert.equal(draft.content, validHookDraft);
  assert.equal(draft.promptParameters.layout, "short_hook_then_detail");
});

test("draftRedditResponse fails closed when LLM never produces a valid draft", async () => {
  await assert.rejects(
    () =>
      draftRedditResponse({
        config: createConfig(createMockLlmProvider(["great point"])),
        item: createReviewItem(),
        targeting: DEFAULT_REDDIT_TARGETING,
        actionType: "comment_on_post",
        promptParameterOverrides: {
          responseLength: "brief",
          layout: "short_hook_then_detail",
          humor: "none"
        }
      }),
    /failed after 3 LLM attempts/
  );
});

test("validateRedditDraft rejects standalone fluff", () => {
  const profile = resolvePromptProfile({
    venue: "reddit",
    actionType: "comment_on_post",
    parameterOverrides: {
      responseLength: "brief",
      layout: "short_hook_then_detail",
      humor: "none"
    }
  });
  assert.throws(
    () => validateRedditDraft("great point", DEFAULT_REDDIT_TARGETING.productAliases, profile),
    /too fluffy/
  );
});

test("validateRedditDraft accepts hook layout without whitelist opener", () => {
  const profile = resolvePromptProfile({
    venue: "reddit",
    actionType: "reply_to_activity",
    parameterOverrides: {
      responseLength: "brief",
      layout: "short_hook_then_detail",
      humor: "none"
    }
  });
  const draft =
    "Local creds are fine for a single desktop agent. The pain starts when you share one MCP host across tools: you need scoped tokens, rotation, and a clear boundary so one compromised client cannot reuse another tool's OAuth grant.";
  assert.doesNotThrow(() =>
    validateRedditDraft(draft, DEFAULT_REDDIT_TARGETING.productAliases, profile)
  );
});

test("draftRedditResponse trims over-length draft when retries stay too long", async () => {
  const over =
    "Fair point. " +
    `${"For local agent stacks, keep inference separate from tool-auth: scoped credentials, retries, and audit history matter when one bad grant can poison the runtime. ".repeat(4)}` +
    "That split is boring but it stops the usual failure mode where every agent decision becomes ad-hoc shell glue.";
  assert.ok(over.length > 500);
  const draft = await draftRedditResponse({
    config: createConfig(createMockLlmProvider([over, over, over])),
    item: createReviewItem(),
    targeting: DEFAULT_REDDIT_TARGETING,
    actionType: "comment_on_post",
    promptParameterOverrides: {
      responseLength: "brief",
      layout: "short_hook_then_detail",
      humor: "none"
    }
  });
  assert.ok(draft.content.length <= 500);
});

test("validateRedditDraft rejects hook-only one-liner for short_hook_then_detail", () => {
  const profile = resolvePromptProfile({
    venue: "reddit",
    actionType: "comment_on_post",
    parameterOverrides: {
      responseLength: "brief",
      layout: "short_hook_then_detail",
      humor: "none"
    }
  });
  assert.throws(
    () =>
      validateRedditDraft(
        "Fair point. Totally agree with this thread.",
        DEFAULT_REDDIT_TARGETING.productAliases,
        profile
      ),
    /hook-style|substance|fluffy/i
  );
});
