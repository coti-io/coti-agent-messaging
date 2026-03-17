import { createHash, randomUUID } from "node:crypto";

import { getAddress, verifyMessage } from "@coti-io/coti-ethers";

import { buildStarterGrantChallenge, verifyChallengeAnswer } from "./challenge.js";
import type {
  PersistedStarterGrantState,
  StarterGrantAuditEvent,
  StarterGrantChallengeRecord,
  StarterGrantChallengeResponse,
  StarterGrantClaimRecord,
  StarterGrantClaimResponse,
  StarterGrantFunder,
  StarterGrantStatusResponse,
  StarterGrantStore
} from "./types.js";

const MAX_STORED_CHALLENGES = 2_000;
const MAX_STORED_CLAIMS = 2_000;
const MAX_STORED_AUDITS = 10_000;
const MAX_STORED_RATE_LIMIT_ENTRIES = 10_000;

function normalizeWalletAddress(walletAddress: string): string {
  return getAddress(walletAddress);
}

function appendAuditEvent(state: PersistedStarterGrantState, event: Omit<StarterGrantAuditEvent, "id">): void {
  state.audits.push({
    id: randomUUID(),
    ...event
  });
}

function alreadyClaimed(state: PersistedStarterGrantState, walletAddress: string, installId: string): string | undefined {
  if (
    state.claims.some(
      (claim) => claim.status === "claimed" && claim.walletAddress.toLowerCase() === walletAddress.toLowerCase()
    )
  ) {
    return "wallet has already claimed a starter grant";
  }

  if (state.claims.some((claim) => claim.status === "claimed" && claim.installId === installId)) {
    return "install has already claimed a starter grant";
  }

  return undefined;
}

function isChallengeExpired(challenge: StarterGrantChallengeRecord, now: Date): boolean {
  return Date.parse(challenge.expiresAt) <= now.getTime();
}

function refreshChallengeStatus(challenge: StarterGrantChallengeRecord, now: Date): void {
  if (challenge.status === "issued" && isChallengeExpired(challenge, now)) {
    challenge.status = "expired";
  }
}

function keepRecent<T>(entries: T[], maxEntries: number): T[] {
  return entries.length <= maxEntries ? entries : entries.slice(-maxEntries);
}

function keepRecentChallenges(
  challenges: StarterGrantChallengeRecord[],
  maxEntries: number
): StarterGrantChallengeRecord[] {
  if (challenges.length <= maxEntries) {
    return challenges;
  }

  const active = challenges.filter((challenge) => challenge.status === "issued").slice(-maxEntries);
  if (active.length >= maxEntries) {
    return active;
  }

  const inactive = challenges.filter((challenge) => challenge.status !== "issued");
  return [...inactive.slice(-(maxEntries - active.length)), ...active].sort((left, right) => {
    return Date.parse(left.issuedAt) - Date.parse(right.issuedAt);
  });
}

function pruneState(state: PersistedStarterGrantState, now: Date): void {
  for (const challenge of state.challenges) {
    refreshChallengeStatus(challenge, now);
  }

  state.challenges = keepRecentChallenges(state.challenges, MAX_STORED_CHALLENGES);
  state.claims = keepRecent(state.claims, MAX_STORED_CLAIMS);
  state.audits = keepRecent(state.audits, MAX_STORED_AUDITS);
  state.rateLimits = keepRecent(state.rateLimits, MAX_STORED_RATE_LIMIT_ENTRIES);
}

function findChallenge(
  state: PersistedStarterGrantState,
  challengeId: string
): StarterGrantChallengeRecord | undefined {
  return state.challenges.find((challenge) => challenge.id === challengeId);
}

function latestClaimForIdentity(
  state: PersistedStarterGrantState,
  walletAddress: string,
  installId: string
): { claim: StarterGrantClaimRecord; matchedOn: "wallet" | "install" } | undefined {
  for (let index = state.claims.length - 1; index >= 0; index -= 1) {
    const claim = state.claims[index];
    if (claim?.status !== "claimed") {
      continue;
    }

    if (claim.walletAddress.toLowerCase() === walletAddress.toLowerCase()) {
      return { claim, matchedOn: "wallet" };
    }

    if (claim.installId === installId) {
      return { claim, matchedOn: "install" };
    }
  }

  return undefined;
}

function latestActiveChallengeForIdentity(
  state: PersistedStarterGrantState,
  walletAddress: string,
  installId: string,
  now: Date
): StarterGrantChallengeRecord | undefined {
  for (let index = state.challenges.length - 1; index >= 0; index -= 1) {
    const challenge = state.challenges[index];
    if (!challenge) {
      continue;
    }

    refreshChallengeStatus(challenge, now);
    if (
      challenge.status === "issued" &&
      challenge.walletAddress === walletAddress &&
      challenge.installId === installId
    ) {
      return challenge;
    }
  }

  return undefined;
}

function countActiveChallengesForIdentity(
  state: PersistedStarterGrantState,
  walletAddress: string,
  installId: string,
  now: Date
): number {
  let count = 0;
  for (const challenge of state.challenges) {
    refreshChallengeStatus(challenge, now);
    if (
      challenge.status === "issued" &&
      (challenge.walletAddress === walletAddress || challenge.installId === installId)
    ) {
      count += 1;
    }
  }
  return count;
}

function rejectClaimAttempt(
  state: PersistedStarterGrantState,
  input: {
    challenge: StarterGrantChallengeRecord;
    walletAddress: string;
    installId: string;
    reason: string;
    now: Date;
    challengeStatus?: StarterGrantChallengeRecord["status"];
  }
): never {
  input.challenge.status = input.challengeStatus ?? "rejected";
  input.challenge.attempts += 1;
  state.claims.push({
    id: randomUUID(),
    challengeId: input.challenge.id,
    walletAddress: input.walletAddress,
    installId: input.installId,
    status: "rejected",
    reason: input.reason,
    createdAt: input.now.toISOString()
  });
  appendAuditEvent(state, {
    type: "claim_rejected",
    walletAddress: input.walletAddress,
    installId: input.installId,
    challengeId: input.challenge.id,
    reason: input.reason,
    createdAt: input.now.toISOString()
  });
  throw new Error(input.reason);
}

export async function issueStarterGrantChallenge(
  store: StarterGrantStore,
  input: {
    walletAddress: string;
    installId: string;
    requesterKey?: string;
    now?: Date;
    ttlMs: number;
    maxOutstandingChallengesPerIdentity: number;
  }
): Promise<StarterGrantChallengeResponse> {
  const now = input.now ?? new Date();
  const walletAddress = normalizeWalletAddress(input.walletAddress);

  return store.transact(async (state) => {
    pruneState(state, now);

    const priorClaimReason = alreadyClaimed(state, walletAddress, input.installId);
    if (priorClaimReason) {
      throw new Error(priorClaimReason);
    }

    const activeChallenge = latestActiveChallengeForIdentity(state, walletAddress, input.installId, now);
    if (activeChallenge) {
      return {
        challengeId: activeChallenge.id,
        prompt: activeChallenge.prompt,
        claimPayload: activeChallenge.claimPayload,
        expiresAt: activeChallenge.expiresAt,
        walletAddress,
        installId: input.installId
      };
    }

    if (
      countActiveChallengesForIdentity(state, walletAddress, input.installId, now) >=
      input.maxOutstandingChallengesPerIdentity
    ) {
      throw new Error("too many outstanding starter grant challenges for this wallet or install");
    }

    const challenge = buildStarterGrantChallenge({
      walletAddress,
      installId: input.installId,
      issuedAt: now,
      ttlMs: input.ttlMs
    });
    state.challenges.push({
      id: challenge.challengeId,
      walletAddress,
      installId: input.installId,
      prompt: challenge.prompt,
      expectedAnswerHash: challenge.expectedAnswerHash,
      claimPayload: challenge.claimPayload,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
      requesterKey: input.requesterKey,
      status: "issued",
      attempts: 0
    });
    appendAuditEvent(state, {
      type: "challenge_issued",
      walletAddress,
      installId: input.installId,
      challengeId: challenge.challengeId,
      requesterKey: input.requesterKey,
      createdAt: now.toISOString()
    });
    pruneState(state, now);

    return {
      challengeId: challenge.challengeId,
      prompt: challenge.prompt,
      claimPayload: challenge.claimPayload,
      expiresAt: challenge.expiresAt,
      walletAddress,
      installId: input.installId
    };
  });
}

export async function claimStarterGrant(
  store: StarterGrantStore,
  funder: StarterGrantFunder,
  input: {
    challengeId: string;
    walletAddress: string;
    installId: string;
    challengeAnswer: string;
    claimPayload: string;
    signature: string;
    amountWei: bigint;
    requesterKey?: string;
    now?: Date;
  }
): Promise<StarterGrantClaimResponse> {
  const now = input.now ?? new Date();
  const walletAddress = normalizeWalletAddress(input.walletAddress);

  return store.transact(async (state) => {
    pruneState(state, now);

    const priorClaimReason = alreadyClaimed(state, walletAddress, input.installId);
    if (priorClaimReason) {
      throw new Error(priorClaimReason);
    }

    const challenge = findChallenge(state, input.challengeId);
    if (!challenge) {
      throw new Error("starter grant challenge was not found");
    }

    appendAuditEvent(state, {
      type: "claim_attempted",
      walletAddress,
      installId: input.installId,
      challengeId: input.challengeId,
      requesterKey: input.requesterKey,
      createdAt: now.toISOString()
    });

    if (challenge.status !== "issued") {
      rejectClaimAttempt(state, {
        challenge,
        walletAddress,
        installId: input.installId,
        reason: `starter grant challenge is no longer claimable (${challenge.status})`,
        now,
        challengeStatus: challenge.status === "expired" ? "expired" : undefined
      });
    }

    if (Date.parse(challenge.expiresAt) <= now.getTime()) {
      rejectClaimAttempt(state, {
        challenge,
        walletAddress,
        installId: input.installId,
        reason: "starter grant challenge has expired",
        now,
        challengeStatus: "expired"
      });
    }

    if (challenge.walletAddress !== walletAddress) {
      rejectClaimAttempt(state, {
        challenge,
        walletAddress,
        installId: input.installId,
        reason: "wallet address does not match the issued starter grant challenge",
        now
      });
    }

    if (challenge.installId !== input.installId) {
      rejectClaimAttempt(state, {
        challenge,
        walletAddress,
        installId: input.installId,
        reason: "install ID does not match the issued starter grant challenge",
        now
      });
    }

    if (challenge.claimPayload !== input.claimPayload) {
      rejectClaimAttempt(state, {
        challenge,
        walletAddress,
        installId: input.installId,
        reason: "claim payload does not match the issued starter grant challenge",
        now
      });
    }

    if (!verifyChallengeAnswer(challenge.id, input.challengeAnswer, challenge.expectedAnswerHash)) {
      rejectClaimAttempt(state, {
        challenge,
        walletAddress,
        installId: input.installId,
        reason: "starter grant challenge answer is incorrect",
        now
      });
    }

    let recoveredAddress: string;
    try {
      recoveredAddress = normalizeWalletAddress(verifyMessage(input.claimPayload, input.signature));
    } catch {
      rejectClaimAttempt(state, {
        challenge,
        walletAddress,
        installId: input.installId,
        reason: "wallet signature could not be verified",
        now
      });
    }

    if (recoveredAddress !== walletAddress) {
      rejectClaimAttempt(state, {
        challenge,
        walletAddress,
        installId: input.installId,
        reason: "wallet signature does not match the claim wallet",
        now
      });
    }

    const transaction = await funder.fundStarterGrant(walletAddress, input.amountWei);
    challenge.status = "claimed";
    challenge.attempts += 1;
    const claimRecord: StarterGrantClaimRecord = {
      id: randomUUID(),
      challengeId: challenge.id,
      walletAddress,
      installId: input.installId,
      status: "claimed",
      transactionHash: transaction.transactionHash,
      amountWei: input.amountWei.toString(),
      createdAt: now.toISOString()
    };
    state.claims.push(claimRecord);
    appendAuditEvent(state, {
      type: "claim_succeeded",
      walletAddress,
      installId: input.installId,
      challengeId: challenge.id,
      requesterKey: input.requesterKey,
      createdAt: now.toISOString()
    });
    pruneState(state, now);

    return {
      status: "claimed",
      walletAddress,
      installId: input.installId,
      challengeId: challenge.id,
      transactionHash: transaction.transactionHash,
      amountWei: input.amountWei.toString()
    };
  });
}

export async function getStarterGrantStatus(
  store: StarterGrantStore,
  input: {
    walletAddress: string;
    installId: string;
    now?: Date;
  }
): Promise<StarterGrantStatusResponse> {
  const now = input.now ?? new Date();
  const walletAddress = normalizeWalletAddress(input.walletAddress);

  return store.transact(async (state) => {
    pruneState(state, now);

    const priorClaim = latestClaimForIdentity(state, walletAddress, input.installId);
    if (priorClaim) {
      return {
        status: "claimed",
        walletAddress,
        installId: input.installId,
        claim: {
          challengeId: priorClaim.claim.challengeId,
          transactionHash: priorClaim.claim.transactionHash,
          amountWei: priorClaim.claim.amountWei,
          createdAt: priorClaim.claim.createdAt,
          matchedOn: priorClaim.matchedOn
        }
      };
    }

    const activeChallenge = latestActiveChallengeForIdentity(state, walletAddress, input.installId, now);
    if (activeChallenge) {
      return {
        status: "challenge_pending",
        walletAddress,
        installId: input.installId,
        challenge: {
          challengeId: activeChallenge.id,
          prompt: activeChallenge.prompt,
          claimPayload: activeChallenge.claimPayload,
          issuedAt: activeChallenge.issuedAt,
          expiresAt: activeChallenge.expiresAt
        }
      };
    }

    return {
      status: "eligible",
      walletAddress,
      installId: input.installId
    };
  });
}

export async function consumeStarterGrantRateLimit(
  store: StarterGrantStore,
  input: {
    requesterKey?: string;
    now?: Date;
    maxRequests: number;
    windowMs: number;
  }
): Promise<boolean> {
  const now = input.now ?? new Date();
  if (!input.requesterKey) {
    return false;
  }
  const requesterKey = input.requesterKey;

  return store.transact(async (state) => {
    const windowStart = now.getTime() - input.windowMs;
    state.rateLimits = state.rateLimits.filter((entry) => Date.parse(entry.createdAt) >= windowStart);

    const recentRequests = state.rateLimits.filter((entry) => entry.key === requesterKey);
    if (recentRequests.length >= input.maxRequests) {
      appendAuditEvent(state, {
        type: "rate_limited",
        requesterKey,
        createdAt: now.toISOString()
      });
      pruneState(state, now);
      return false;
    }

    state.rateLimits.push({
      key: requesterKey,
      createdAt: now.toISOString()
    });
    pruneState(state, now);
    return true;
  });
}

export function requestKeyFromIp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return createHash("sha256").update(value).digest("hex");
}
