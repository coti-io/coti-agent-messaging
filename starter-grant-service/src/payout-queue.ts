import { randomUUID } from "node:crypto";

import type {
  PersistedStarterGrantState,
  StarterGrantAuditEvent,
  StarterGrantClaimRecord,
  StarterGrantClaimResponse,
  StarterGrantChallengeRecord,
  StarterGrantFunder,
  StarterGrantFundingAvailability,
  StarterGrantPayoutJob,
  StarterGrantPayoutQueue,
  StarterGrantStore
} from "./types.js";

function appendAuditEvent(state: PersistedStarterGrantState, event: Omit<StarterGrantAuditEvent, "id">): void {
  state.audits.push({
    id: randomUUID(),
    ...event
  });
}

function findClaim(
  state: PersistedStarterGrantState,
  claimId: string
): StarterGrantClaimRecord | undefined {
  return state.claims.find((claim) => claim.id === claimId);
}

function findChallenge(
  state: PersistedStarterGrantState,
  challengeId: string
): StarterGrantChallengeRecord | undefined {
  return state.challenges.find((challenge) => challenge.id === challengeId);
}

function classifyFundingError(error: unknown): "pending" | "failed" {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out/i.test(message) ? "pending" : "failed";
}

export class SerialStarterGrantPayoutQueue implements StarterGrantPayoutQueue {
  private queue = Promise.resolve();

  constructor(
    private readonly store: StarterGrantStore,
    private readonly funder: StarterGrantFunder
  ) {}

  getFundingAvailability(
    amountWei: bigint,
    reservedPendingAmountWei: bigint
  ): Promise<StarterGrantFundingAvailability> {
    return this.funder.getFundingAvailability(amountWei, reservedPendingAmountWei);
  }

  enqueue(job: StarterGrantPayoutJob): Promise<StarterGrantClaimResponse> {
    const operation = this.queue.catch(() => undefined).then(() => this.process(job));
    this.queue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async process(job: StarterGrantPayoutJob): Promise<StarterGrantClaimResponse> {
    let transfer;
    try {
      transfer = await this.funder.createStarterGrantTransfer(job.walletAddress, job.amountWei);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.transact((state) => {
        const claim = findClaim(state, job.claimId);
        const challenge = findChallenge(state, job.challengeId);
        const now = new Date().toISOString();

        if (claim && claim.status === "pending_funding") {
          claim.status = "funding_failed";
          claim.reason = message;
          claim.updatedAt = now;
        }

        if (challenge && challenge.status === "funding") {
          challenge.status = Date.parse(challenge.expiresAt) <= Date.now() ? "expired" : "issued";
        }

        appendAuditEvent(state, {
          type: "funding_failed",
          walletAddress: job.walletAddress,
          installId: job.installId,
          challengeId: job.challengeId,
          reason: message,
          createdAt: now
        });
      });
      throw error;
    }

    await this.store.transact((state) => {
      const claim = findClaim(state, job.claimId);
      const now = new Date().toISOString();
      if (claim) {
        claim.transactionHash = transfer.transactionHash;
        claim.updatedAt = now;
      }

      appendAuditEvent(state, {
        type: "funding_broadcast",
        walletAddress: job.walletAddress,
        installId: job.installId,
        challengeId: job.challengeId,
        createdAt: now
      });
    });

    try {
      await transfer.waitForConfirmation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorKind = classifyFundingError(error);

      const response = await this.store.transact<StarterGrantClaimResponse>((state) => {
        const claim = findClaim(state, job.claimId);
        const challenge = findChallenge(state, job.challengeId);
        const now = new Date().toISOString();

        if (claim) {
          claim.updatedAt = now;
          claim.reason = message;
          if (errorKind === "failed") {
            claim.status = "funding_failed";
          }
        }

        if (challenge && challenge.status === "funding" && errorKind === "failed") {
          challenge.status = Date.parse(challenge.expiresAt) <= Date.now() ? "expired" : "issued";
        }

        appendAuditEvent(state, {
          type: "funding_failed",
          walletAddress: job.walletAddress,
          installId: job.installId,
          challengeId: job.challengeId,
          reason: message,
          createdAt: now
        });

        return {
          status: "pending_funding",
          walletAddress: job.walletAddress,
          installId: job.installId,
          challengeId: job.challengeId,
          attributionRefId: job.attributionRefId,
          transactionHash: transfer.transactionHash,
          amountWei: job.amountWei.toString()
        };
      });

      if (errorKind === "pending") {
        return response;
      }

      throw error;
    }

    return this.store.transact<StarterGrantClaimResponse>((state) => {
      const claim = findClaim(state, job.claimId);
      const challenge = findChallenge(state, job.challengeId);
      const now = new Date().toISOString();

      if (claim) {
        claim.status = "claimed";
        claim.reason = undefined;
        claim.updatedAt = now;
      }

      if (challenge) {
        challenge.status = "claimed";
      }

      appendAuditEvent(state, {
        type: "claim_succeeded",
        walletAddress: job.walletAddress,
        installId: job.installId,
        challengeId: job.challengeId,
        createdAt: now
      });

      return {
        status: "claimed",
        walletAddress: job.walletAddress,
        installId: job.installId,
        challengeId: job.challengeId,
        attributionRefId: job.attributionRefId,
        transactionHash: transfer.transactionHash,
        amountWei: job.amountWei.toString()
      };
    });
  }
}
