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
    statePath: path.join(os.tmpdir(), `starter-grant-test-${Date.now()}-${Math.random()}.json`),
    authToken: undefined,
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

function buildOutreachRef(refId: string) {
  return {
    id: refId,
    venue: "moltbook",
    venueAccountId: "OutreachBot",
    surface: "general",
    contentType: "post",
    campaignId: "private_messaging",
    promptProfileId: "aggressive-structured",
    promptParameters: {
      messageStyle: "aggressive",
      layout: "structured_bullets"
    },
    messageStyle: "aggressive",
    layout: "structured_bullets",
    ctaStyle: "direct_next_step",
    promotionLevel: "explicit",
    productSpecificity: "product_named",
    rewardEmphasis: "balanced",
    audience: "builders",
    candidateId: "create-post",
    generatedContentId: "generated-1",
    utm: {
      source: "moltbook",
      medium: "outreach_agent",
      campaign: "private_messaging",
      content: "aggressive_structured_post"
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
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

test("challenge route rejects oversized JSON bodies", async () => {
  const service = await startTestServer({ maxBodyBytes: 256 });
  const wallet = Wallet.createRandom();

  try {
    const response = await fetch(`${service.baseUrl}/challenge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        walletAddress: wallet.address,
        installId: "install-alpha",
        extra: "x".repeat(2048)
      })
    });

    assert.equal(response.status, 413);
    const body = await response.json();
    assert.match(String(body.error), /too large/i);
  } finally {
    await service.close();
  }
});

test("challenge route requires application/json", async () => {
  const service = await startTestServer();

  try {
    const response = await fetch(`${service.baseUrl}/challenge`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain"
      },
      body: "not-json"
    });

    assert.equal(response.status, 415);
    const body = await response.json();
    assert.match(String(body.error), /application\/json/i);
  } finally {
    await service.close();
  }
});

test("x-forwarded-for only affects throttling when trustProxy is enabled", async () => {
  const wallet = Wallet.createRandom();
  const requestBody = (installId: string) =>
    JSON.stringify({
      walletAddress: wallet.address,
      installId
    });

  const untrusted = await startTestServer({
    trustProxy: false,
    challengeMaxRequestsPerWindow: 1
  });

  try {
    const first = await fetch(`${untrusted.baseUrl}/challenge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.10"
      },
      body: requestBody("install-a")
    });
    const second = await fetch(`${untrusted.baseUrl}/challenge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.11"
      },
      body: requestBody("install-b")
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
  } finally {
    await untrusted.close();
  }

  const trusted = await startTestServer({
    trustProxy: true,
    challengeMaxRequestsPerWindow: 1
  });

  try {
    const first = await fetch(`${trusted.baseUrl}/challenge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.10"
      },
      body: requestBody("install-c")
    });
    const second = await fetch(`${trusted.baseUrl}/challenge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.11"
      },
      body: requestBody("install-d")
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
  } finally {
    await trusted.close();
  }
});

test("health route returns funding capacity details when funder is healthy", async () => {
  const service = await startTestServer(
    {},
    {
      funder: {
        async getFundingAvailability() {
          return {
            funderAddress: "0xfunder",
            onChainBalanceWei: "1000",
            reservedPendingAmountWei: "100",
            availableBalanceWei: "900",
            estimatedGasCostWei: "50",
            requiredBalanceWei: "150",
            hasSufficientBalance: true
          };
        },
        async createStarterGrantTransfer() {
          return {
            transactionHash: "0xgrant",
            waitForConfirmation: async () => undefined
          };
        }
      }
    }
  );

  try {
    const response = await fetch(`${service.baseUrl}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(body.funderAvailable, true);
    assert.equal(body.funding.funderAddress, "0xfunder");
    assert.equal(body.funding.pendingFundingClaimsCount, 0);
    assert.equal(body.funding.estimatedClaimsRemaining, 6);
    assert.equal(body.funding.onChainBalanceNative, "0.000000000000001");
    assert.equal(body.funding.availableBalanceNative, "0.0000000000000009");
  } finally {
    await service.close();
  }
});

test("health route reports degraded when funder cannot cover another claim", async () => {
  const service = await startTestServer(
    {},
    {
      funder: {
        async getFundingAvailability() {
          return {
            funderAddress: "0xfunder",
            onChainBalanceWei: "120",
            reservedPendingAmountWei: "0",
            availableBalanceWei: "120",
            estimatedGasCostWei: "50",
            requiredBalanceWei: "150",
            hasSufficientBalance: false
          };
        },
        async createStarterGrantTransfer() {
          return {
            transactionHash: "0xgrant",
            waitForConfirmation: async () => undefined
          };
        }
      }
    }
  );

  try {
    const response = await fetch(`${service.baseUrl}/health`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.status, "degraded");
    assert.equal(body.reason, "insufficient_funder_balance");
    assert.equal(body.funding.pendingFundingClaimsCount, 0);
    assert.equal(body.funding.estimatedClaimsRemaining, 0);
    assert.equal(body.funding.requiredBalanceNative, "0.00000000000000015");
  } finally {
    await service.close();
  }
});

test("shared attribution db joins outreach refs with grant and usage events", async () => {
  const wallet = Wallet.createRandom();
  const refId = "mb_testref_1";
  const service = await startTestServer(
    {
      attributionDbPath: path.join(os.tmpdir(), `starter-grant-attribution-${Date.now()}-${Math.random()}.sqlite`)
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
            transactionHash: "0xgrant",
            waitForConfirmation: async () => undefined
          };
        }
      }
    }
  );

  try {
    const challengeResponse = await fetch(`${service.baseUrl}/challenge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        walletAddress: wallet.address,
        installId: "install-attribution",
        ref: refId,
        outreachRef: buildOutreachRef(refId)
      })
    });
    assert.equal(challengeResponse.status, 200);
    const challenge = await challengeResponse.json();
    assert.equal(challenge.attributionRefId, refId);

    const claimPayload = String(challenge.claimPayload);
    const claimResponse = await fetch(`${service.baseUrl}/claim`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        walletAddress: wallet.address,
        installId: "install-attribution",
        challengeAnswer: solveChallengePrompt(String(challenge.prompt)),
        claimPayload,
        signature: await wallet.signMessage(claimPayload)
      })
    });
    assert.equal(claimResponse.status, 200);
    const claim = await claimResponse.json();
    assert.equal(claim.status, "claimed");
    assert.equal(claim.attributionRefId, refId);

    const eventResponse = await fetch(`${service.baseUrl}/attribution/event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ref: refId,
        type: "skill_usage",
        walletAddress: wallet.address,
        installId: "install-attribution",
        skillId: "private-message-send"
      })
    });
    assert.equal(eventResponse.status, 202);

    const summaryResponse = await fetch(`${service.baseUrl}/attribution/summary?campaignId=private_messaging`);
    assert.equal(summaryResponse.status, 200);
    const summary = await summaryResponse.json();
    assert.equal(summary.groups.length, 1);
    assert.equal(summary.groups[0].promptProfileId, "aggressive-structured");
    assert.equal(summary.groups[0].messageStyle, "aggressive");
    assert.equal(summary.groups[0].layout, "structured_bullets");
    assert.equal(summary.groups[0].grantChallenges, 1);
    assert.equal(summary.groups[0].grantClaimAttempts, 1);
    assert.equal(summary.groups[0].grantClaimsSucceeded, 1);
    assert.equal(summary.groups[0].skillUsages, 1);
  } finally {
    await service.close();
  }
});

test("manual ref registration persists refs for later public click events", async () => {
  const service = await startTestServer({
    authToken: "secret-token",
    attributionDbPath: path.join(os.tmpdir(), `starter-grant-manual-ref-${Date.now()}-${Math.random()}.sqlite`)
  });

  try {
    const registerResponse = await fetch(`${service.baseUrl}/attribution/ref`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-token"
      },
      body: JSON.stringify({
        outreachRef: buildOutreachRef("manual-twitter-ref")
      })
    });
    assert.equal(registerResponse.status, 201);

    const clickResponse = await fetch(`${service.baseUrl}/attribution/event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ref: "manual-twitter-ref",
        type: "click",
        venue: "twitter",
        metadata: {
          utm_source: "twitter"
        }
      })
    });
    assert.equal(clickResponse.status, 202);

    const summaryResponse = await fetch(
      `${service.baseUrl}/attribution/summary?campaignId=private_messaging`,
      {
        headers: {
          Authorization: "Bearer secret-token"
        }
      }
    );
    assert.equal(summaryResponse.status, 200);
    const summary = await summaryResponse.json();
    assert.equal(summary.groups.length, 1);
    assert.equal(summary.groups[0].clicks, 1);
  } finally {
    await service.close();
  }
});

test("public attribution events reject non-click traffic when auth is required", async () => {
  const service = await startTestServer({
    authToken: "secret-token",
    attributionDbPath: path.join(os.tmpdir(), `starter-grant-public-event-${Date.now()}-${Math.random()}.sqlite`)
  });

  try {
    const response = await fetch(`${service.baseUrl}/attribution/event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ref: "manual-twitter-ref",
        type: "skill_usage",
        skillId: "private-message-send"
      })
    });
    assert.equal(response.status, 401);
  } finally {
    await service.close();
  }
});

test("grant routes stay public while analytics routes require auth", async () => {
  const wallet = Wallet.createRandom();
  const service = await startTestServer({
    authToken: "secret-token",
    attributionDbPath: path.join(os.tmpdir(), `starter-grant-auth-split-${Date.now()}-${Math.random()}.sqlite`)
  }, {
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
          transactionHash: "0xgrant",
          waitForConfirmation: async () => undefined
        };
      }
    }
  });

  try {
    const challengeResponse = await fetch(`${service.baseUrl}/challenge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        walletAddress: wallet.address,
        installId: "install-public-grant"
      })
    });
    assert.equal(challengeResponse.status, 200);
    const challenge = await challengeResponse.json();

    const statusResponse = await fetch(`${service.baseUrl}/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        walletAddress: wallet.address,
        installId: "install-public-grant"
      })
    });
    assert.equal(statusResponse.status, 200);

    const claimPayload = String(challenge.claimPayload);
    const claimResponse = await fetch(`${service.baseUrl}/claim`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        walletAddress: wallet.address,
        installId: "install-public-grant",
        challengeAnswer: solveChallengePrompt(String(challenge.prompt)),
        claimPayload,
        signature: await wallet.signMessage(claimPayload)
      })
    });
    assert.equal(claimResponse.status, 200);

    const registerRefResponse = await fetch(`${service.baseUrl}/attribution/ref`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        outreachRef: buildOutreachRef("unauthorized-ref")
      })
    });
    assert.equal(registerRefResponse.status, 401);

    const summaryResponse = await fetch(`${service.baseUrl}/attribution/summary`);
    assert.equal(summaryResponse.status, 401);
  } finally {
    await service.close();
  }
});
