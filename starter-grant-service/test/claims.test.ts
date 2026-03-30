import test from "node:test";
import assert from "node:assert/strict";

import { Wallet } from "@coti-io/coti-ethers";

import {
  claimStarterGrant,
  consumeStarterGrantRateLimit,
  getStarterGrantStatus,
  issueStarterGrantChallenge
} from "../src/claims.js";
import { SerialStarterGrantPayoutQueue } from "../src/payout-queue.js";
import type {
  PersistedStarterGrantState,
  StarterGrantFunder,
  StarterGrantStore
} from "../src/types.js";

class InMemoryStore implements StarterGrantStore {
  state: PersistedStarterGrantState = {
    challenges: [],
    claims: [],
    audits: [],
    rateLimits: []
  };

  async transact<T>(updater: (state: PersistedStarterGrantState) => Promise<T> | T): Promise<T> {
    const nextState = structuredClone(this.state);
    try {
      const result = await updater(nextState);
      this.state = nextState;
      return result;
    } catch (error) {
      this.state = nextState;
      throw error;
    }
  }
}

function solvePrompt(prompt: string): string {
  const numbers = [...prompt.matchAll(/\b\d+\b/g)].map((match) => Number(match[0]));
  assert.equal(numbers.length >= 2, true);
  const [left, right] = numbers;

  if (/\bchunk-thread pairs\b/i.test(prompt)) {
    return String(left * right);
  }

  if (/\bremain\b/i.test(prompt)) {
    return String(left - right);
  }

  return String(left + right);
}

function createClaimOptions() {
  return {
    rejectedClaimsPerWindow: 3,
    rejectedClaimWindowMs: 15 * 60_000
  };
}

function createQueue(
  store: StarterGrantStore,
  input?: {
    onCreate?: (walletAddress: string, amountWei: bigint) => Promise<{
      transactionHash: string;
      waitForConfirmation(): Promise<void>;
    }>;
  }
) {
  const funderCalls: Array<{ walletAddress: string; amountWei: bigint }> = [];
  const funder: StarterGrantFunder = {
    async createStarterGrantTransfer(walletAddress: string, amountWei: bigint) {
      funderCalls.push({ walletAddress, amountWei });
      if (input?.onCreate) {
        return input.onCreate(walletAddress, amountWei);
      }

      return {
        transactionHash: "0xstartergrant",
        waitForConfirmation: async () => undefined
      };
    }
  };

  return {
    queue: new SerialStarterGrantPayoutQueue(store, funder),
    funderCalls
  };
}

test("starter grant claim succeeds once with combined challenge answer and wallet signature", async () => {
  const store = new InMemoryStore();
  const wallet = Wallet.createRandom();
  const { queue, funderCalls } = createQueue(store);

  const challenge = await issueStarterGrantChallenge(store, {
    walletAddress: wallet.address,
    installId: "install-alpha",
    ttlMs: 60_000,
    maxOutstandingChallengesPerIdentity: 3,
    now: new Date("2026-03-17T10:00:00.000Z")
  });
  const signature = await wallet.signMessage(challenge.claimPayload);
  const answer = solvePrompt(challenge.prompt);

  const claim = await claimStarterGrant(store, queue, {
    challengeId: challenge.challengeId,
    walletAddress: wallet.address,
    installId: challenge.installId,
    challengeAnswer: answer,
    claimPayload: challenge.claimPayload,
    signature,
    amountWei: 25n,
    now: new Date("2026-03-17T10:00:05.000Z"),
    ...createClaimOptions()
  });

  assert.equal(claim.status, "claimed");
  assert.equal(claim.walletAddress, wallet.address);
  assert.equal(claim.transactionHash, "0xstartergrant");
  assert.deepEqual(funderCalls, [{ walletAddress: wallet.address, amountWei: 25n }]);
  assert.equal(store.state.claims.filter((entry) => entry.status === "claimed").length, 1);
});

test("starter grant claim rejects duplicate wallet and install claims", async () => {
  const store = new InMemoryStore();
  const wallet = Wallet.createRandom();
  const { queue } = createQueue(store);

  const challenge = await issueStarterGrantChallenge(store, {
    walletAddress: wallet.address,
    installId: "install-alpha",
    ttlMs: 60_000,
    maxOutstandingChallengesPerIdentity: 3,
    now: new Date("2026-03-17T10:00:00.000Z")
  });
  const signature = await wallet.signMessage(challenge.claimPayload);
  const answer = solvePrompt(challenge.prompt);

  await claimStarterGrant(store, queue, {
    challengeId: challenge.challengeId,
    walletAddress: wallet.address,
    installId: challenge.installId,
    challengeAnswer: answer,
    claimPayload: challenge.claimPayload,
    signature,
    amountWei: 25n,
    now: new Date("2026-03-17T10:00:05.000Z"),
    ...createClaimOptions()
  });

  await assert.rejects(
    () =>
      issueStarterGrantChallenge(store, {
        walletAddress: wallet.address,
        installId: challenge.installId,
        ttlMs: 60_000,
        maxOutstandingChallengesPerIdentity: 3
      }),
    /already claimed/
  );
});

test("starter grant status returns the pending challenge instead of issuing duplicates", async () => {
  const store = new InMemoryStore();
  const wallet = Wallet.createRandom();

  const first = await issueStarterGrantChallenge(store, {
    walletAddress: wallet.address,
    installId: "install-alpha",
    ttlMs: 60_000,
    maxOutstandingChallengesPerIdentity: 3,
    now: new Date("2026-03-17T10:00:00.000Z")
  });
  const second = await issueStarterGrantChallenge(store, {
    walletAddress: wallet.address,
    installId: "install-alpha",
    ttlMs: 60_000,
    maxOutstandingChallengesPerIdentity: 3,
    now: new Date("2026-03-17T10:00:05.000Z")
  });

  assert.equal(second.challengeId, first.challengeId);
  assert.equal(store.state.challenges.length, 1);

  const status = await getStarterGrantStatus(store, {
    walletAddress: wallet.address,
    installId: "install-alpha",
    now: new Date("2026-03-17T10:00:10.000Z")
  });

  assert.equal(status.status, "challenge_pending");
  assert.equal(status.challenge?.challengeId, first.challengeId);
});

test("starter grant claim rejects expired challenges and preserves the expired state", async () => {
  const store = new InMemoryStore();
  const wallet = Wallet.createRandom();
  const { queue } = createQueue(store);

  const challenge = await issueStarterGrantChallenge(store, {
    walletAddress: wallet.address,
    installId: "install-alpha",
    ttlMs: 1_000,
    maxOutstandingChallengesPerIdentity: 3,
    now: new Date("2026-03-17T10:00:00.000Z")
  });

  await assert.rejects(
    () =>
      claimStarterGrant(store, queue, {
        challengeId: challenge.challengeId,
        walletAddress: wallet.address,
        installId: challenge.installId,
        challengeAnswer: solvePrompt(challenge.prompt),
        claimPayload: challenge.claimPayload,
        signature: "0xbad",
        amountWei: 25n,
        now: new Date("2026-03-17T10:00:05.000Z"),
        ...createClaimOptions()
      }),
    /expired/
  );

  assert.equal(store.state.challenges[0]?.status, "expired");
});

test("starter grant claim rejects wrong answers", async () => {
  const store = new InMemoryStore();
  const wallet = Wallet.createRandom();
  const { queue } = createQueue(store);

  const challenge = await issueStarterGrantChallenge(store, {
    walletAddress: wallet.address,
    installId: "install-alpha",
    ttlMs: 60_000,
    maxOutstandingChallengesPerIdentity: 3,
    now: new Date("2026-03-17T10:00:00.000Z")
  });

  await assert.rejects(
    async () => {
      const signature = await wallet.signMessage(challenge.claimPayload);
      return claimStarterGrant(store, queue, {
        challengeId: challenge.challengeId,
        walletAddress: wallet.address,
        installId: challenge.installId,
        challengeAnswer: "999999",
        claimPayload: challenge.claimPayload,
        signature,
        amountWei: 25n,
        now: new Date("2026-03-17T10:00:05.000Z"),
        ...createClaimOptions()
      });
    },
    /incorrect/
  );

  assert.equal(store.state.claims[store.state.claims.length - 1]?.status, "rejected");
});

test("starter grant claim rejects mismatched wallet or install identity", async () => {
  const store = new InMemoryStore();
  const wallet = Wallet.createRandom();
  const otherWallet = Wallet.createRandom();
  const { queue } = createQueue(store);

  const challenge = await issueStarterGrantChallenge(store, {
    walletAddress: wallet.address,
    installId: "install-alpha",
    ttlMs: 60_000,
    maxOutstandingChallengesPerIdentity: 3,
    now: new Date("2026-03-17T10:00:00.000Z")
  });
  const signature = await wallet.signMessage(challenge.claimPayload);

  await assert.rejects(
    () =>
      claimStarterGrant(store, queue, {
        challengeId: challenge.challengeId,
        walletAddress: otherWallet.address,
        installId: challenge.installId,
        challengeAnswer: solvePrompt(challenge.prompt),
        claimPayload: challenge.claimPayload,
        signature,
        amountWei: 25n,
        now: new Date("2026-03-17T10:00:05.000Z"),
        ...createClaimOptions()
      }),
    /wallet address does not match/
  );

  const nextChallenge = await issueStarterGrantChallenge(store, {
    walletAddress: wallet.address,
    installId: "install-beta",
    ttlMs: 60_000,
    maxOutstandingChallengesPerIdentity: 3,
    now: new Date("2026-03-17T10:01:00.000Z")
  });
  const nextSignature = await wallet.signMessage(nextChallenge.claimPayload);

  await assert.rejects(
    () =>
      claimStarterGrant(store, queue, {
        challengeId: nextChallenge.challengeId,
        walletAddress: wallet.address,
        installId: "install-gamma",
        challengeAnswer: solvePrompt(nextChallenge.prompt),
        claimPayload: nextChallenge.claimPayload,
        signature: nextSignature,
        amountWei: 25n,
        now: new Date("2026-03-17T10:01:05.000Z"),
        ...createClaimOptions()
      }),
    /install ID does not match/
  );
});

test("starter grant claim is not burned if funding fails before confirmation", async () => {
  const store = new InMemoryStore();
  const wallet = Wallet.createRandom();
  const baseTime = new Date();
  const { queue } = createQueue(store, {
    onCreate: async () => ({
      transactionHash: "0xstartergrant",
      waitForConfirmation: async () => {
        throw new Error("starter grant transfer was not confirmed");
      }
    })
  });

  const challenge = await issueStarterGrantChallenge(store, {
    walletAddress: wallet.address,
    installId: "install-alpha",
    ttlMs: 60_000,
    maxOutstandingChallengesPerIdentity: 3,
    now: baseTime
  });
  const signature = await wallet.signMessage(challenge.claimPayload);

  await assert.rejects(
    () =>
      claimStarterGrant(store, queue, {
        challengeId: challenge.challengeId,
        walletAddress: wallet.address,
        installId: challenge.installId,
        challengeAnswer: solvePrompt(challenge.prompt),
        claimPayload: challenge.claimPayload,
        signature,
        amountWei: 25n,
        now: new Date(baseTime.getTime() + 5_000),
        ...createClaimOptions()
      }),
    /not confirmed/
  );

  const status = await getStarterGrantStatus(store, {
    walletAddress: wallet.address,
    installId: challenge.installId,
    now: new Date(baseTime.getTime() + 10_000)
  });

  assert.equal(status.status, "challenge_pending");
  assert.equal(status.challenge?.challengeId, challenge.challengeId);
  assert.equal(store.state.claims.filter((entry) => entry.status === "claimed").length, 0);
});

test("starter grant claim returns pending funding when confirmation times out", async () => {
  const store = new InMemoryStore();
  const wallet = Wallet.createRandom();
  const { queue } = createQueue(store, {
    onCreate: async () => ({
      transactionHash: "0xpendinggrant",
      waitForConfirmation: async () => {
        throw new Error("starter grant transfer confirmation timed out");
      }
    })
  });

  const challenge = await issueStarterGrantChallenge(store, {
    walletAddress: wallet.address,
    installId: "install-alpha",
    ttlMs: 60_000,
    maxOutstandingChallengesPerIdentity: 3,
    now: new Date("2026-03-17T10:00:00.000Z")
  });
  const signature = await wallet.signMessage(challenge.claimPayload);

  const claim = await claimStarterGrant(store, queue, {
    challengeId: challenge.challengeId,
    walletAddress: wallet.address,
    installId: challenge.installId,
    challengeAnswer: solvePrompt(challenge.prompt),
    claimPayload: challenge.claimPayload,
    signature,
    amountWei: 25n,
    now: new Date("2026-03-17T10:00:05.000Z"),
    ...createClaimOptions()
  });

  assert.equal(claim.status, "pending_funding");
  assert.equal(claim.transactionHash, "0xpendinggrant");

  const status = await getStarterGrantStatus(store, {
    walletAddress: wallet.address,
    installId: challenge.installId,
    now: new Date("2026-03-17T10:00:10.000Z")
  });

  assert.equal(status.status, "funding_pending");
  assert.equal(status.claim?.transactionHash, "0xpendinggrant");
});

test("payout queue processes grants serially", async () => {
  const store = new InMemoryStore();
  let releaseFirstTransfer!: () => void;
  const started: string[] = [];

  const queue = new SerialStarterGrantPayoutQueue(store, {
    async createStarterGrantTransfer(walletAddress: string) {
      started.push(walletAddress);
      if (started.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstTransfer = resolve;
        });
      }

      return {
        transactionHash: `0x${started.length}`,
        waitForConfirmation: async () => undefined
      };
    }
  });

  const first = queue.enqueue({
    claimId: "claim-1",
    challengeId: "challenge-1",
    walletAddress: "wallet-1",
    installId: "install-1",
    amountWei: 25n
  });
  const second = queue.enqueue({
    claimId: "claim-2",
    challengeId: "challenge-2",
    walletAddress: "wallet-2",
    installId: "install-2",
    amountWei: 25n
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(started, ["wallet-1"]);

  releaseFirstTransfer();
  await Promise.all([first, second]);
  assert.deepEqual(started, ["wallet-1", "wallet-2"]);
});

test("starter grant rate limiting persists in store state", async () => {
  const store = new InMemoryStore();

  assert.equal(
    (
      await consumeStarterGrantRateLimit(store, {
        bucket: "challenge",
        requesterKey: "requester-1",
        maxRequests: 2,
        windowMs: 60_000,
        now: new Date("2026-03-17T10:00:00.000Z")
      })
    ).allowed,
    true
  );
  assert.equal(
    (
      await consumeStarterGrantRateLimit(store, {
        bucket: "challenge",
        requesterKey: "requester-1",
        maxRequests: 2,
        windowMs: 60_000,
        now: new Date("2026-03-17T10:00:10.000Z")
      })
    ).allowed,
    true
  );
  assert.equal(
    (
      await consumeStarterGrantRateLimit(store, {
        bucket: "challenge",
        requesterKey: "requester-1",
        maxRequests: 2,
        windowMs: 60_000,
        now: new Date("2026-03-17T10:00:20.000Z")
      })
    ).allowed,
    false
  );
  assert.equal(store.state.audits[store.state.audits.length - 1]?.type, "rate_limited");
});

test("starter grant rate limiting is bucket-specific", async () => {
  const store = new InMemoryStore();

  assert.equal(
    (
      await consumeStarterGrantRateLimit(store, {
        bucket: "challenge",
        requesterKey: "requester-1",
        maxRequests: 1,
        windowMs: 60_000,
        now: new Date("2026-03-17T10:00:00.000Z")
      })
    ).allowed,
    true
  );
  assert.equal(
    (
      await consumeStarterGrantRateLimit(store, {
        bucket: "status",
        requesterKey: "requester-1",
        maxRequests: 1,
        windowMs: 60_000,
        now: new Date("2026-03-17T10:00:00.000Z")
      })
    ).allowed,
    true
  );
});
