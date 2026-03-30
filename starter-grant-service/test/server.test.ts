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
