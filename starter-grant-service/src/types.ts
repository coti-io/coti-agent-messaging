export interface StarterGrantServiceConfig {
  host: string;
  port: number;
  challengeRoute: string;
  claimRoute: string;
  statusRoute: string;
  healthRoute: string;
  statePath: string;
  authToken?: string;
  challengeTtlMs: number;
  starterAmountWei: bigint;
  maxRequestsPerWindow: number;
  rateLimitWindowMs: number;
  maxOutstandingChallengesPerIdentity: number;
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
  status: "issued" | "claimed" | "expired" | "rejected";
  attempts: number;
}

export interface StarterGrantClaimRecord {
  id: string;
  challengeId: string;
  walletAddress: string;
  installId: string;
  status: "claimed" | "rejected";
  reason?: string;
  transactionHash?: string;
  amountWei?: string;
  createdAt: string;
}

export interface StarterGrantAuditEvent {
  id: string;
  type:
    | "challenge_issued"
    | "claim_attempted"
    | "claim_rejected"
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
  status: "claimed";
  walletAddress: string;
  installId: string;
  challengeId: string;
  transactionHash: string;
  amountWei: string;
}

export interface StarterGrantStatusResponse {
  status: "eligible" | "challenge_pending" | "claimed";
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
    challengeId: string;
    transactionHash?: string;
    amountWei?: string;
    createdAt: string;
    matchedOn: "wallet" | "install";
  };
}

export interface StarterGrantFunder {
  fundStarterGrant(walletAddress: string, amountWei: bigint): Promise<{ transactionHash: string }>;
}

export interface StarterGrantStore {
  transact<T>(updater: (state: PersistedStarterGrantState) => Promise<T> | T): Promise<T>;
}
