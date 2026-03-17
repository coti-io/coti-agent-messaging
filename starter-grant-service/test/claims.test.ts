import test from "node:test";
import assert from "node:assert/strict";

import { Wallet } from "@coti-io/coti-ethers";

import {
  claimStarterGrant,
  consumeStarterGrantRateLimit,
  getStarterGrantStatus,
  issueStarterGrantChallenge
} from "../src/claims.js";
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

test("starter grant claim succeeds once with combined challenge answer and wallet signature", async () => {
  const store = new InMemoryStore();
  const wallet = Wallet.createRandom();
  const funderCalls: Array<{ walletAddress: string; amountWei: bigint }> = [];
  const funder: StarterGrantFunder = {
    async fundStarterGrant(walletAddress, amountWei) {
      funderCalls.push({ walletAddress, amountWei });
      return { transactionHash: "0xstartergrant" };
    }
  };

  const challenge = await issueStarterGrantChallenge(store, {
    walletAddress: wallet.address,
    installId: "install-alpha",
    ttlMs: 60_000,
    maxOutstandingChallengesPerIdentity: 3,
    now: new Date("2026-03-17T10:00:00.000Z")
  });
  const signature = await wallet.signMessage(challenge.claimPayload);
  const answer = solvePrompt(challenge.prompt);

  const claim = await claimStarterGrant(store, funder, {
    challengeId: challenge.challengeId,
    walletAddress: wallet.address,
    installId: challenge.installId,
    challengeAnswer: answer,
    claimPayload: challenge.claimPayload,
    signature,
    amountWei: 25n,
    now: new Date("2026-03-17T10:00:05.000Z")
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
  const funder: StarterGrantFunder = {
    async fundStarterGrant() {
      return { transactionHash: "0xstartergrant" };
    }
  };

  const challenge = await issueStarterGrantChallenge(store, {
    walletAddress: wallet.address,
    installId: "install-alpha",
    ttlMs: 60_000,
    maxOutstandingChallengesPerIdentity: 3,
    now: new Date("2026-03-17T10:00:00.000Z")
  });
  const signature = await wallet.signMessage(challenge.claimPayload);
  const answer = solvePrompt(challenge.prompt);

  await claimStarterGrant(store, funder, {
    challengeId: challenge.challengeId,
    walletAddress: wallet.address,
    installId: challenge.installId,
    challengeAnswer: answer,
    claimPayload: challenge.claimPayload,
    signature,
    amountWei: 25n,
    now: new Date("2026-03-17T10:00:05.000Z")
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
  const funder: StarterGrantFunder = {
    async fundStarterGrant() {
      return { transactionHash: "0xstartergrant" };
    }
  };

  const challenge = await issueStarterGrantChallenge(store, {
    walletAddress: wallet.address,
    installId: "install-alpha",
    ttlMs: 1_000,
    maxOutstandingChallengesPerIdentity: 3,
    now: new Date("2026-03-17T10:00:00.000Z")
  });

  await assert.rejects(
    () =>
      claimStarterGrant(store, funder, {
        challengeId: challenge.challengeId,
        walletAddress: wallet.address,
        installId: challenge.installId,
        challengeAnswer: solvePrompt(challenge.prompt),
        claimPayload: challenge.claimPayload,
        signature: "0xbad",
        amountWei: 25n,
        now: new Date("2026-03-17T10:00:05.000Z")
      }),
    /expired/
  );

  assert.equal(store.state.challenges[0]?.status, "expired");
});

test("starter grant claim rejects wrong answers", async () => {
  const store = new InMemoryStore();
  const wallet = Wallet.createRandom();
  const funder: StarterGrantFunder = {
    async fundStarterGrant() {
      return { transactionHash: "0xstartergrant" };
    }
  };

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
      return claimStarterGrant(store, funder, {
        challengeId: challenge.challengeId,
        walletAddress: wallet.address,
        installId: challenge.installId,
        challengeAnswer: "999999",
        claimPayload: challenge.claimPayload,
        signature,
        amountWei: 25n,
        now: new Date("2026-03-17T10:00:05.000Z")
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
  const funder: StarterGrantFunder = {
    async fundStarterGrant() {
      return { transactionHash: "0xstartergrant" };
    }
  };

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
      claimStarterGrant(store, funder, {
        challengeId: challenge.challengeId,
        walletAddress: otherWallet.address,
        installId: challenge.installId,
        challengeAnswer: solvePrompt(challenge.prompt),
        claimPayload: challenge.claimPayload,
        signature,
        amountWei: 25n,
        now: new Date("2026-03-17T10:00:05.000Z")
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
      claimStarterGrant(store, funder, {
        challengeId: nextChallenge.challengeId,
        walletAddress: wallet.address,
        installId: "install-gamma",
        challengeAnswer: solvePrompt(nextChallenge.prompt),
        claimPayload: nextChallenge.claimPayload,
        signature: nextSignature,
        amountWei: 25n,
        now: new Date("2026-03-17T10:01:05.000Z")
      }),
    /install ID does not match/
  );
});

test("starter grant claim is not burned if funding fails before confirmation", async () => {
  const store = new InMemoryStore();
  const wallet = Wallet.createRandom();
  const funder: StarterGrantFunder = {
    async fundStarterGrant() {
      throw new Error("starter grant transfer was not confirmed");
    }
  };

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
      claimStarterGrant(store, funder, {
        challengeId: challenge.challengeId,
        walletAddress: wallet.address,
        installId: challenge.installId,
        challengeAnswer: solvePrompt(challenge.prompt),
        claimPayload: challenge.claimPayload,
        signature,
        amountWei: 25n,
        now: new Date("2026-03-17T10:00:05.000Z")
      }),
    /not confirmed/
  );

  const status = await getStarterGrantStatus(store, {
    walletAddress: wallet.address,
    installId: challenge.installId,
    now: new Date("2026-03-17T10:00:10.000Z")
  });

  assert.equal(status.status, "challenge_pending");
  assert.equal(status.challenge?.challengeId, challenge.challengeId);
  assert.equal(store.state.claims.filter((entry) => entry.status === "claimed").length, 0);
});

test("starter grant rate limiting persists in store state", async () => {
  const store = new InMemoryStore();

  assert.equal(
    await consumeStarterGrantRateLimit(store, {
      requesterKey: "requester-1",
      maxRequests: 2,
      windowMs: 60_000,
      now: new Date("2026-03-17T10:00:00.000Z")
    }),
    true
  );
  assert.equal(
    await consumeStarterGrantRateLimit(store, {
      requesterKey: "requester-1",
      maxRequests: 2,
      windowMs: 60_000,
      now: new Date("2026-03-17T10:00:10.000Z")
    }),
    true
  );
  assert.equal(
    await consumeStarterGrantRateLimit(store, {
      requesterKey: "requester-1",
      maxRequests: 2,
      windowMs: 60_000,
      now: new Date("2026-03-17T10:00:20.000Z")
    }),
    false
  );
  assert.equal(store.state.audits[store.state.audits.length - 1]?.type, "rate_limited");
});
