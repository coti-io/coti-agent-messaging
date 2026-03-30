export interface StarterGrantServiceConfig {
  host: string;
  port: number;
  challengeRoute: string;
  claimRoute: string;
  statusRoute: string;
  healthRoute: string;
  statePath: string;
  authToken?: string;
  trustProxy: boolean;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  keepAliveTimeoutMs: number;
  challengeTtlMs: number;
  starterAmountWei: bigint;
  challengeMaxRequestsPerWindow: number;
  statusMaxRequestsPerWindow: number;
  claimMaxRequestsPerWindow: number;
  rateLimitWindowMs: number;
  maxOutstandingChallengesPerIdentity: number;
  rejectedClaimsPerWindow: number;
  rejectedClaimWindowMs: number;
  fundingConfirmTimeoutMs: number;
  network: "testnet" | "mainnet";
  rpcUrl?: string;
  funderPrivateKey: string;
}

export interface StarterGrantChallengeRecord {
  id: string;
  walletAddress: string;
  installId: string;
  prompt: string;
  expectedAnswerHash: string;
  claimPayload: string;
  issuedAt: string;
  expiresAt: string;
  requesterKey?: string;
  status: "issued" | "funding" | "claimed" | "expired" | "rejected";
  attempts: number;
}

export interface StarterGrantClaimRecord {
  id: string;
  challengeId: string;
  walletAddress: string;
  installId: string;
  requesterKey?: string;
  status: "pending_funding" | "claimed" | "rejected" | "funding_failed";
  reason?: string;
  transactionHash?: string;
  amountWei?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface StarterGrantAuditEvent {
  id: string;
  type:
    | "challenge_issued"
    | "claim_attempted"
    | "claim_queued"
    | "claim_rejected"
    | "funding_broadcast"
    | "funding_failed"
    | "claim_succeeded"
    | "rate_limited";
  walletAddress?: string;
  installId?: string;
  challengeId?: string;
  requesterKey?: string;
  reason?: string;
  createdAt: string;
}

export interface StarterGrantRateLimitEntry {
  key: string;
  bucket: string;
  createdAt: string;
}

export interface PersistedStarterGrantState {
  challenges: StarterGrantChallengeRecord[];
  claims: StarterGrantClaimRecord[];
  audits: StarterGrantAuditEvent[];
  rateLimits: StarterGrantRateLimitEntry[];
}

export interface StarterGrantChallengeResponse {
  challengeId: string;
  prompt: string;
  claimPayload: string;
  expiresAt: string;
  walletAddress: string;
  installId: string;
}

export interface StarterGrantClaimResponse {
  status: "pending_funding" | "claimed";
  walletAddress: string;
  installId: string;
  challengeId: string;
  transactionHash?: string;
  amountWei: string;
}

export interface StarterGrantFundingAvailability {
  funderAddress: string;
  onChainBalanceWei: string;
  reservedPendingAmountWei: string;
  availableBalanceWei: string;
  estimatedGasCostWei: string;
  requiredBalanceWei: string;
  hasSufficientBalance: boolean;
}

export interface StarterGrantFundingSnapshot {
  availability: StarterGrantFundingAvailability;
  pendingFundingClaimsCount: number;
}

export interface StarterGrantStatusResponse {
  status: "eligible" | "challenge_pending" | "funding_pending" | "claimed";
  walletAddress: string;
  installId: string;
  challenge?: {
    challengeId: string;
    prompt: string;
    claimPayload: string;
    issuedAt: string;
    expiresAt: string;
  };
  claim?: {
    status: "pending_funding" | "claimed";
    challengeId: string;
    transactionHash?: string;
    amountWei?: string;
    createdAt: string;
    matchedOn: "wallet" | "install";
  };
}

export interface StarterGrantPendingTransfer {
  transactionHash: string;
  waitForConfirmation(): Promise<void>;
}

export interface StarterGrantPayoutJob {
  claimId: string;
  challengeId: string;
  walletAddress: string;
  installId: string;
  amountWei: bigint;
}

export interface StarterGrantPayoutQueue {
  enqueue(job: StarterGrantPayoutJob): Promise<StarterGrantClaimResponse>;
  getFundingAvailability(
    amountWei: bigint,
    reservedPendingAmountWei: bigint
  ): Promise<StarterGrantFundingAvailability>;
}

export interface StarterGrantFunder {
  getFundingAvailability(
    amountWei: bigint,
    reservedPendingAmountWei: bigint
  ): Promise<StarterGrantFundingAvailability>;
  createStarterGrantTransfer(
    walletAddress: string,
    amountWei: bigint
  ): Promise<StarterGrantPendingTransfer>;
}

export interface StarterGrantStore {
  transact<T>(updater: (state: PersistedStarterGrantState) => Promise<T> | T): Promise<T>;
}
