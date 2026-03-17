import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { Wallet } from "@coti-io/coti-ethers";

import {
  claimStarterGrant,
  getStarterGrantChallenge,
  getStarterGrantStatus,
  requestStarterGrant
} from "../src/starter-grants.js";
import type { PrivateAgentMessagingClient } from "../src/client.js";
import type { StarterGrantServiceConfig } from "../src/types.js";

test("starter grant helpers reuse the same install ID and sign the claim payload", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "starter-grant-sdk-"));
  const wallet = Wallet.createRandom();
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const config: StarterGrantServiceConfig = {
    url: "https://starter-grants.test",
    timeoutMs: 5_000,
    installIdPath: path.join(tempDir, "install-state.json")
  };
  const client = {
    getAddress: async () => wallet.address,
    signMessage: async (message: string | Uint8Array) => wallet.signMessage(message)
  } as PrivateAgentMessagingClient;

  try {
    const challenge = await getStarterGrantChallenge(
      client,
      config,
      async (url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        requests.push({ url: String(url), body });
        return new Response(
          JSON.stringify({
            challengeId: "challenge-1",
            prompt: "Starter grant check: what is 12 + 8?",
            claimPayload: "opaque-claim-payload",
            expiresAt: "2026-03-17T12:00:00.000Z",
            walletAddress: wallet.address,
            installId: body.installId
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    );

    const claim = await claimStarterGrant(
      client,
      config,
      {
        challengeId: challenge.challengeId,
        challengeAnswer: "20",
        claimPayload: challenge.claimPayload
      },
      async (url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        requests.push({ url: String(url), body });
        return new Response(
          JSON.stringify({
            status: "claimed",
            walletAddress: wallet.address,
            installId: body.installId,
            challengeId: body.challengeId,
            transactionHash: "0xstartergrant",
            amountWei: "25"
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    );

    assert.equal(challenge.challengeId, "challenge-1");
    assert.equal(claim.status, "claimed");
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.url, "https://starter-grants.test/challenge");
    assert.equal(requests[1]?.url, "https://starter-grants.test/claim");
    assert.equal(requests[0]?.body.walletAddress, wallet.address);
    assert.equal(requests[0]?.body.installId, requests[1]?.body.installId);
    assert.equal(requests[1]?.body.walletAddress, wallet.address);
    assert.equal(requests[1]?.body.challengeAnswer, "20");
    assert.equal(typeof requests[1]?.body.signature, "string");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("starter grant helper can request status and solve the trivial prompt in one call", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "starter-grant-sdk-"));
  const wallet = Wallet.createRandom();
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const config: StarterGrantServiceConfig = {
    url: "https://starter-grants.test",
    timeoutMs: 5_000,
    installIdPath: path.join(tempDir, "install-state.json")
  };
  const client = {
    getAddress: async () => wallet.address,
    signMessage: async (message: string | Uint8Array) => wallet.signMessage(message)
  } as PrivateAgentMessagingClient;

  try {
    const status = await getStarterGrantStatus(
      client,
      config,
      async (url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        requests.push({ url: String(url), body });
        return new Response(
          JSON.stringify({
            status: "eligible",
            walletAddress: wallet.address,
            installId: body.installId
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    );

    const claim = await requestStarterGrant(
      client,
      config,
      async (url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        requests.push({ url: String(url), body });

        if (String(url).endsWith("/challenge")) {
          return new Response(
            JSON.stringify({
              challengeId: "challenge-2",
              prompt:
                "Starter grant check: if an agent has 12 queued messages and archives 7, how many remain? Reply with digits only.",
              claimPayload: "opaque-claim-payload",
              expiresAt: "2026-03-17T12:00:00.000Z",
              walletAddress: wallet.address,
              installId: body.installId
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response(
          JSON.stringify({
            status: "claimed",
            walletAddress: wallet.address,
            installId: body.installId,
            challengeId: body.challengeId,
            transactionHash: "0xstartergrant",
            amountWei: "25"
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    );

    assert.equal(status.status, "eligible");
    assert.equal(claim.status, "claimed");
    assert.equal(claim.prompt.includes("archives 7"), true);
    assert.equal(requests[0]?.url, "https://starter-grants.test/status");
    assert.equal(requests[1]?.url, "https://starter-grants.test/challenge");
    assert.equal(requests[2]?.url, "https://starter-grants.test/claim");
    assert.equal(requests[1]?.body.installId, requests[2]?.body.installId);
    assert.equal(requests[2]?.body.challengeAnswer, "5");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
