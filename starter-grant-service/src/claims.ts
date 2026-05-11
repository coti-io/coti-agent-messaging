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
  StarterGrantFundingAvailability,
  StarterGrantFundingSnapshot,
  StarterGrantPayoutQueue,
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

function existingClaimReason(
  state: PersistedStarterGrantState,
  walletAddress: string,
  installId: string
): string | undefined {
  if (
    state.claims.some(
      (claim) =>
        claim.status === "pending_funding" &&
        claim.walletAddress.toLowerCase() === walletAddress.toLowerCase()
    )
  ) {
    return "wallet has a starter grant claim pending funding";
  }

  if (
    state.claims.some(
      (claim) => claim.status === "pending_funding" && claim.installId === installId
    )
  ) {
    return "install has a starter grant claim pending funding";
  }

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
    if (!claim || (claim.status !== "claimed" && claim.status !== "pending_funding")) {
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

function countRecentRejectedClaims(
  state: PersistedStarterGrantState,
  input: {
    walletAddress: string;
    installId: string;
    requesterKey?: string;
    now: Date;
    windowMs: number;
  }
): number {
  const windowStart = input.now.getTime() - input.windowMs;
  return state.claims.filter((claim) => {
    if (claim.status !== "rejected" && claim.status !== "funding_failed") {
      return false;
    }

    if (Date.parse(claim.createdAt) < windowStart) {
      return false;
    }

    return (
      claim.walletAddress.toLowerCase() === input.walletAddress.toLowerCase() ||
      claim.installId === input.installId ||
      (input.requesterKey !== undefined && claim.requesterKey === input.requesterKey)
    );
  }).length;
}

function pendingFundingReservedAmountWei(state: PersistedStarterGrantState): bigint {
  return state.claims.reduce((total, claim) => {
    if (claim.status !== "pending_funding") {
      return total;
    }

    return total + BigInt(claim.amountWei ?? "0");
  }, 0n);
}

function pendingFundingClaimsCount(state: PersistedStarterGrantState): number {
  return state.claims.filter((claim) => claim.status === "pending_funding").length;
}

function rejectClaimAttempt(
  state: PersistedStarterGrantState,
  input: {
    challenge: StarterGrantChallengeRecord;
    walletAddress: string;
    installId: string;
    requesterKey?: string;
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
    requesterKey: input.requesterKey,
    attributionRefId: input.challenge.attributionRefId,
    status: "rejected",
    reason: input.reason,
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString()
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
    attributionRefId?: string;
  }
): Promise<StarterGrantChallengeResponse> {
  const now = input.now ?? new Date();
  const walletAddress = normalizeWalletAddress(input.walletAddress);

  return store.transact(async (state) => {
    pruneState(state, now);

    const priorClaimReason = existingClaimReason(state, walletAddress, input.installId);
    if (priorClaimReason) {
      throw new Error(priorClaimReason);
    }

    const activeChallenge = latestActiveChallengeForIdentity(state, walletAddress, input.installId, now);
    if (activeChallenge) {
      if (!activeChallenge.attributionRefId && input.attributionRefId) {
        activeChallenge.attributionRefId = input.attributionRefId;
      }
      return {
        challengeId: activeChallenge.id,
        prompt: activeChallenge.prompt,
        claimPayload: activeChallenge.claimPayload,
        expiresAt: activeChallenge.expiresAt,
        walletAddress,
        installId: input.installId,
        attributionRefId: activeChallenge.attributionRefId
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
      attributionRefId: input.attributionRefId,
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
      installId: input.installId,
      attributionRefId: input.attributionRefId
    };
  });
}

export async function claimStarterGrant(
  store: StarterGrantStore,
  payoutQueue: StarterGrantPayoutQueue,
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
    rejectedClaimsPerWindow: number;
    rejectedClaimWindowMs: number;
  }
): Promise<StarterGrantClaimResponse> {
  const now = input.now ?? new Date();
  const walletAddress = normalizeWalletAddress(input.walletAddress);

  const queued = await store.transact(async (state) => {
    pruneState(state, now);

    const priorClaimReason = existingClaimReason(state, walletAddress, input.installId);
    if (priorClaimReason) {
      throw new Error(priorClaimReason);
    }

    const fundingAvailability = await payoutQueue.getFundingAvailability(
      input.amountWei,
      pendingFundingReservedAmountWei(state)
    );
    if (!fundingAvailability.hasSufficientBalance) {
      throw new Error("starter grant funder has insufficient native balance");
    }

    if (
      countRecentRejectedClaims(state, {
        walletAddress,
        installId: input.installId,
        requesterKey: input.requesterKey,
        now,
        windowMs: input.rejectedClaimWindowMs
      }) >= input.rejectedClaimsPerWindow
    ) {
      throw new Error("starter grant claim is temporarily locked after repeated failures");
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
        requesterKey: input.requesterKey,
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
        requesterKey: input.requesterKey,
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
        requesterKey: input.requesterKey,
        reason: "wallet address does not match the issued starter grant challenge",
        now
      });
    }

    if (challenge.installId !== input.installId) {
      rejectClaimAttempt(state, {
        challenge,
        walletAddress,
        installId: input.installId,
        requesterKey: input.requesterKey,
        reason: "install ID does not match the issued starter grant challenge",
        now
      });
    }

    if (challenge.claimPayload !== input.claimPayload) {
      rejectClaimAttempt(state, {
        challenge,
        walletAddress,
        installId: input.installId,
        requesterKey: input.requesterKey,
        reason: "claim payload does not match the issued starter grant challenge",
        now
      });
    }

    if (!verifyChallengeAnswer(challenge.id, input.challengeAnswer, challenge.expectedAnswerHash)) {
      rejectClaimAttempt(state, {
        challenge,
        walletAddress,
        installId: input.installId,
        requesterKey: input.requesterKey,
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
        requesterKey: input.requesterKey,
        reason: "wallet signature could not be verified",
        now
      });
    }

    if (recoveredAddress !== walletAddress) {
      rejectClaimAttempt(state, {
        challenge,
        walletAddress,
        installId: input.installId,
        requesterKey: input.requesterKey,
        reason: "wallet signature does not match the claim wallet",
        now
      });
    }

    challenge.status = "funding";
    challenge.attempts += 1;
    const claimRecord: StarterGrantClaimRecord = {
      id: randomUUID(),
      challengeId: challenge.id,
      walletAddress,
      installId: input.installId,
      requesterKey: input.requesterKey,
      attributionRefId: challenge.attributionRefId,
      status: "pending_funding",
      amountWei: input.amountWei.toString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    state.claims.push(claimRecord);
    appendAuditEvent(state, {
      type: "claim_queued",
      walletAddress,
      installId: input.installId,
      challengeId: challenge.id,
      requesterKey: input.requesterKey,
      createdAt: now.toISOString()
    });
    pruneState(state, now);

    return {
      claimId: claimRecord.id,
      challengeId: challenge.id,
      walletAddress,
      installId: input.installId,
      attributionRefId: challenge.attributionRefId,
      amountWei: input.amountWei
    };
  });

  return payoutQueue.enqueue(queued);
}

export async function getStarterGrantFundingAvailability(
  store: StarterGrantStore,
  payoutQueue: StarterGrantPayoutQueue,
  amountWei: bigint
): Promise<StarterGrantFundingAvailability> {
  return store.transact((state) =>
    payoutQueue.getFundingAvailability(amountWei, pendingFundingReservedAmountWei(state))
  );
}

export async function getStarterGrantFundingSnapshot(
  store: StarterGrantStore,
  payoutQueue: StarterGrantPayoutQueue,
  amountWei: bigint
): Promise<StarterGrantFundingSnapshot> {
  return store.transact(async (state) => ({
    availability: await payoutQueue.getFundingAvailability(
      amountWei,
      pendingFundingReservedAmountWei(state)
    ),
    pendingFundingClaimsCount: pendingFundingClaimsCount(state)
  }));
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
        status: priorClaim.claim.status === "pending_funding" ? "funding_pending" : "claimed",
        walletAddress,
        installId: input.installId,
        claim: {
          status: priorClaim.claim.status === "pending_funding" ? "pending_funding" : "claimed",
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
    bucket: string;
    requesterKey?: string;
    now?: Date;
    maxRequests: number;
    windowMs: number;
  }
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const now = input.now ?? new Date();
  if (!input.requesterKey) {
    return { allowed: false, retryAfterMs: input.windowMs };
  }
  const requesterKey = input.requesterKey;

  return store.transact(async (state) => {
    const windowStart = now.getTime() - input.windowMs;
    state.rateLimits = state.rateLimits.filter((entry) => Date.parse(entry.createdAt) >= windowStart);

    const recentRequests = state.rateLimits.filter(
      (entry) => entry.key === requesterKey && entry.bucket === input.bucket
    );
    if (recentRequests.length >= input.maxRequests) {
      const earliestAllowedAt =
        Math.min(...recentRequests.map((entry) => Date.parse(entry.createdAt))) + input.windowMs;
      appendAuditEvent(state, {
        type: "rate_limited",
        requesterKey,
        reason: input.bucket,
        createdAt: now.toISOString()
      });
      pruneState(state, now);
      return {
        allowed: false,
        retryAfterMs: Math.max(0, earliestAllowedAt - now.getTime())
      };
    }

    state.rateLimits.push({
      key: requesterKey,
      bucket: input.bucket,
      createdAt: now.toISOString()
    });
    pruneState(state, now);
    return {
      allowed: true,
      retryAfterMs: 0
    };
  });
}

export function requestKeyFromIp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return createHash("sha256").update(value).digest("hex");
}
