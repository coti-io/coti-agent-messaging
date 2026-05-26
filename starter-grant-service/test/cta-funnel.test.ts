import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { Wallet } from "@coti-io/coti-ethers";

import { startStarterGrantService, type StartStarterGrantServiceDependencies } from "../src/server.js";
import type { StarterGrantServiceConfig } from "../src/types.js";

function createConfig(overrides: Partial<StarterGrantServiceConfig> = {}): StarterGrantServiceConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    challengeRoute: "/challenge",
    claimRoute: "/claim",
    statusRoute: "/status",
    healthRoute: "/health",
    statePath: path.join(os.tmpdir(), `starter-grant-cta-funnel-${Date.now()}-${Math.random()}.json`),
    authToken: "cta-funnel-secret",
    trustProxy: false,
    maxBodyBytes: 16 * 1024,
    requestTimeoutMs: 15_000,
    headersTimeoutMs: 10_000,
    keepAliveTimeoutMs: 5_000,
    challengeTtlMs: 60_000,
    starterAmountWei: 25n,
    challengeMaxRequestsPerWindow: 8,
    statusMaxRequestsPerWindow: 8,
    claimMaxRequestsPerWindow: 4,
    rateLimitWindowMs: 60_000,
    maxOutstandingChallengesPerIdentity: 3,
    rejectedClaimsPerWindow: 3,
    rejectedClaimWindowMs: 15 * 60_000,
    fundingConfirmTimeoutMs: 10_000,
    network: "testnet",
    rpcUrl: undefined,
    funderPrivateKey: Wallet.createRandom().privateKey,
    ...overrides
  };
}

function solveChallengePrompt(prompt: string): string {
  const numbers = prompt.match(/\d+/gu)?.map(Number) ?? [];
  assert.equal(numbers.length >= 2, true);
  const [left = 0, right = 0] = numbers;
  if (prompt.includes("receives")) {
    return String(left + right);
  }
  if (prompt.includes("archives")) {
    return String(left - right);
  }
  return String(left * right);
}

function buildPostOutreachRef(refId: string) {
  return {
    id: refId,
    venue: "moltbook",
    venueAccountId: "OutreachBot",
    surface: "general",
    contentType: "post",
    campaignId: "private_messaging",
    promptProfileId: "cta-funnel-test",
    promptParameters: {
      messageStyle: "technical",
      layout: "regular_paragraph",
      ctaStyle: "direct_next_step"
    },
    messageStyle: "technical",
    layout: "regular_paragraph",
    ctaStyle: "direct_next_step",
    promotionLevel: "explicit",
    productSpecificity: "product_named",
    rewardEmphasis: "balanced",
    audience: "builders",
    candidateId: "cta-funnel-post",
    generatedContentId: "cta-funnel-generated",
    utm: {
      source: "moltbook",
      medium: "outreach_agent",
      campaign: "private_messaging",
      content: "cta_funnel_test_post"
    }
  };
}

async function startTestServer(
  overrides: Partial<StarterGrantServiceConfig> = {},
  dependencies: StartStarterGrantServiceDependencies = {}
) {
  const service = await startStarterGrantService(createConfig(overrides), dependencies);
  const address = service.server.address();
  assert.ok(address && typeof address === "object");
  return {
    ...service,
    baseUrl: `http://127.0.0.1:${address.port}`,
    authHeaders: {
      Authorization: "Bearer cta-funnel-secret",
      "Content-Type": "application/json"
    }
  };
}

async function postAttributionEvent(
  baseUrl: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(`${baseUrl}/attribution/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("post CTA ref tracks click through grant claim to private message", async () => {
  const refId = "mo_cta_funnel_test";
  const wallet = Wallet.createRandom();
  const installId = "cta-funnel-install";
  const service = await startTestServer(
    {
      attributionDbPath: path.join(
        os.tmpdir(),
        `starter-grant-cta-funnel-${Date.now()}-${Math.random()}.sqlite`
      )
    },
    {
      funder: {
        async getFundingAvailability() {
          return {
            funderAddress: "0xfunder",
            onChainBalanceWei: "1000",
            reservedPendingAmountWei: "0",
            availableBalanceWei: "1000",
            estimatedGasCostWei: "1",
            requiredBalanceWei: "26",
            hasSufficientBalance: true
          };
        },
        async createStarterGrantTransfer() {
          return {
            transactionHash: "0xcta-funnel-grant",
            waitForConfirmation: async () => undefined
          };
        }
      }
    }
  );

  try {
    const registerResponse = await fetch(`${service.baseUrl}/attribution/ref`, {
      method: "POST",
      headers: service.authHeaders,
      body: JSON.stringify({ outreachRef: buildPostOutreachRef(refId) })
    });
    assert.equal(registerResponse.status, 201);

    const clickResponse = await postAttributionEvent(service.baseUrl, {
      ref: refId,
      type: "click",
      venue: "landing_page",
      metadata: {
        path: "/pm",
        utm_source: "moltbook",
        utm_campaign: "private_messaging"
      }
    });
    assert.equal(clickResponse.status, 202);

    const challengeResponse = await fetch(`${service.baseUrl}/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: wallet.address,
        installId,
        ref: refId
      })
    });
    assert.equal(challengeResponse.status, 200);
    const challenge = (await challengeResponse.json()) as {
      challengeId: string;
      prompt: string;
      claimPayload: string;
      attributionRefId?: string;
    };
    assert.equal(challenge.attributionRefId, refId);

    const claimPayload = String(challenge.claimPayload);
    const claimResponse = await fetch(`${service.baseUrl}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        walletAddress: wallet.address,
        installId,
        challengeAnswer: solveChallengePrompt(String(challenge.prompt)),
        claimPayload,
        signature: await wallet.signMessage(claimPayload)
      })
    });
    assert.equal(claimResponse.status, 200);
    const claim = (await claimResponse.json()) as { status: string; attributionRefId?: string };
    assert.equal(claim.status, "claimed");
    assert.equal(claim.attributionRefId, refId);

    const pmResponse = await postAttributionEvent(service.baseUrl, {
      ref: refId,
      type: "private_message_received",
      walletAddress: wallet.address,
      installId,
      metadata: {
        transactionHash: "0xcta-funnel-pm",
        messageId: "cta-funnel-message-1"
      }
    });
    assert.equal(pmResponse.status, 202);

    const summaryResponse = await fetch(
      `${service.baseUrl}/attribution/summary?campaignId=private_messaging`,
      { headers: { Authorization: service.authHeaders.Authorization } }
    );
    assert.equal(summaryResponse.status, 200);
    const summary = (await summaryResponse.json()) as {
      groups: Array<{
        clicks: number;
        grantChallenges: number;
        grantClaimsSucceeded: number;
        privateMessagesReceived: number;
      }>;
    };

    assert.equal(summary.groups.length, 1);
    assert.equal(summary.groups[0]?.clicks, 1);
    assert.equal(summary.groups[0]?.grantChallenges, 1);
    assert.equal(summary.groups[0]?.grantClaimsSucceeded, 1);
    assert.equal(summary.groups[0]?.privateMessagesReceived, 1);
  } finally {
    await service.close();
  }
});
