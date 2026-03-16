import test from "node:test";
import assert from "node:assert/strict";

import {
  createBridgeJsonLlmProvider,
  type ChatMessage
} from "../src/llm-client.js";
import {
  buildMainLlmProvider,
  buildVerificationLlmProvider,
  type MoltbookRuntimeConfig
} from "../src/config.js";

test("bridge provider posts the same message payload shape and unwraps result", async () => {
  const requests: Array<{
    url: string;
    authorization: string | null;
    messages: ChatMessage[];
  }> = [];
  const provider = createBridgeJsonLlmProvider(
    {
      url: "http://127.0.0.1:4318/json-completion",
      timeoutMs: 5000,
      label: "local-bridge",
      authToken: "bridge-secret"
    },
    async (url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: ChatMessage[] };
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("Authorization"),
        messages: body.messages
      });
      return new Response(
        JSON.stringify({
          result: {
            selectedCandidateId: "comment:post-1",
            rationale: "Returned by bridge."
          }
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

  const response = await provider.createJsonCompletion<{
    selectedCandidateId: string;
    rationale: string;
  }>([
    {
      role: "system",
      content: "Select one candidate."
    },
    {
      role: "user",
      content: "Candidate shortlist."
    }
  ]);

  assert.deepEqual(response, {
    selectedCandidateId: "comment:post-1",
    rationale: "Returned by bridge."
  });
  assert.deepEqual(requests, [
    {
      url: "http://127.0.0.1:4318/json-completion",
      authorization: "Bearer bridge-secret",
      messages: [
        {
          role: "system",
          content: "Select one candidate."
        },
        {
          role: "user",
          content: "Candidate shortlist."
        }
      ]
    }
  ]);
});

test("bridge config is preferred over HTTP config when building providers", async () => {
  const config: MoltbookRuntimeConfig = {
    packageRoot: "/tmp/package",
    projectRoot: "/tmp/project",
    credentialsPath: "/tmp/credentials.json",
    statePath: "/tmp/state.json",
    heartbeatReportPath: "/tmp/last-heartbeat.json",
    moltbookBaseUrl: "https://www.moltbook.com/api/v1",
    defaultSubmolt: "general",
    dryRun: false,
    autoVerify: false,
    llm: {
      apiKey: "http-secret",
      baseUrl: "https://openrouter.example/v1",
      model: "http-model",
      timeoutMs: 5000
    },
    verificationLlm: {
      apiKey: "verify-secret",
      baseUrl: "https://verify.example/v1",
      model: "verify-model",
      timeoutMs: 5000
    },
    llmBridge: {
      url: "http://127.0.0.1:4318/json-completion",
      timeoutMs: 4000,
      label: "main-bridge"
    },
    verificationLlmBridge: {
      url: "http://127.0.0.1:4319/json-completion",
      timeoutMs: 3000,
      label: "verify-bridge"
    }
  };
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ result: { ok: true } }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  };

  const mainProvider = buildMainLlmProvider(config, fetchImpl);
  const verificationProvider = buildVerificationLlmProvider(config, fetchImpl);
  await mainProvider!.createJsonCompletion<{ ok: boolean }>([]);
  await verificationProvider!.createJsonCompletion<{ ok: boolean }>([]);

  assert.deepEqual(calls, [
    "http://127.0.0.1:4318/json-completion",
    "http://127.0.0.1:4319/json-completion"
  ]);
});
