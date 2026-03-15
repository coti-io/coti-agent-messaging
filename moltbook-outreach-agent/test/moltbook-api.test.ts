import test from "node:test";
import assert from "node:assert/strict";

import { MoltbookApiClient, solveVerificationChallenge } from "../src/moltbook-api.js";

test("refuses to send an API key to a non-Moltbook host", async () => {
  const client = new MoltbookApiClient({
    baseUrl: "https://example.com/api/v1",
    apiKey: "moltbook_secret"
  });

  await assert.rejects(() => client.getHome(), /Only www\.moltbook\.com is allowed/);
});

test("adds the bearer token for authenticated Moltbook requests", async () => {
  let authorizationHeader: string | null = null;

  const client = new MoltbookApiClient({
    baseUrl: "https://www.moltbook.com/api/v1",
    apiKey: "moltbook_secret",
    fetchImpl: async (_url, init) => {
      authorizationHeader = new Headers(init?.headers).get("Authorization");
      return new Response(JSON.stringify({ status: "claimed" }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
  });

  const result = await client.getStatus();
  assert.equal(result.status, "claimed");
  assert.equal(authorizationHeader, "Bearer moltbook_secret");
});

test("solves the documented verification challenge example", () => {
  const answer = solveVerificationChallenge(
    "A] lO^bSt-Er S[wImS aT/ tW]eNn-Tyy mE^tE[rS aNd] SlO/wS bY^ fI[vE, wH-aTs] ThE/ nEw^ SpE[eD?"
  );

  assert.equal(answer, "15.00");
});

