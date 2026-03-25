export interface CtString {
  value: readonly (bigint | number | string)[];
}

export interface ItString {
  ciphertext: CtString;
  signature: readonly string[];
}

export interface MessageView {
  id: bigint;
  from: string;
  to: string;
  timestamp: bigint;
  epoch: bigint;
  chunkCount: bigint;
  ciphertext: CtString;
}

export interface PaginationRequest {
  account: string;
  offset?: number;
  limit?: number;
}

export interface EpochSummary {
  totalUsageUnits: bigint;
  rewardPool: bigint;
  claimedAmount: bigint;
  claimedUsageUnits: bigint;
}

export interface EpochUsage {
  epoch: bigint;
  agent: string;
  usageUnits: bigint;
  totalUsageUnits: bigint;
  pendingRewards: bigint;
  hasClaimed: boolean;
}

export interface ContractConfig {
  owner: string;
  epochDuration: bigint;
  genesisTimestamp: bigint;
  maxChunkCells: bigint;
  maxChunksPerMessage: bigint;
}

export interface AccountStats {
  account: string;
  inboxCount: bigint;
  sentCount: bigint;
}

export interface MessageMetadata {
  from: string;
  to: string;
  timestamp: bigint;
  epoch: bigint;
}

export interface SendMessageRequest {
  to: string;
  plaintext: string;
  maxChunkBytes?: number;
  gasLimit?: bigint | number | string;
  gasBufferBps?: number;
}

export interface SendMessageResult {
  transactionHash: string;
  messageId?: bigint;
}

export interface ReadMessageRequest {
  messageId: bigint | number | string;
  decrypt?: boolean;
}

export interface ReadMessageResult {
  message: MessageView;
  chunks: CtString[];
  plaintext?: string;
}

export interface ListMessagesRequest extends PaginationRequest {
  decrypt?: boolean;
}

export interface ListMessagesResult {
  ids: bigint[];
  messages?: ReadMessageResult[];
}

export interface ClaimRewardsRequest {
  epoch: bigint | number | string;
}

export interface ClaimRewardsResult {
  transactionHash: string;
  amount: bigint;
}

export interface FundEpochRequest {
  epoch: bigint | number | string;
  amountWei: bigint;
}

export interface StarterGrantServiceConfig {
  url: string;
  timeoutMs: number;
  authToken?: string;
  installIdPath?: string;
}

export interface GetStarterGrantChallengeResult {
  challengeId: string;
  prompt: string;
  claimPayload: string;
  expiresAt: string;
  walletAddress: string;
  installId: string;
}

export interface GetStarterGrantStatusResult {
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

export interface ClaimStarterGrantRequest {
  challengeId: string;
  challengeAnswer: string;
  claimPayload: string;
}

export interface ClaimStarterGrantResult {
  status: "claimed";
  walletAddress: string;
  installId: string;
  challengeId: string;
  transactionHash: string;
  amountWei: string;
}

export interface RequestStarterGrantResult extends ClaimStarterGrantResult {
  prompt: string;
  expiresAt: string;
}

export interface PrivateMessagingClientConfig {
  contractAddress: string;
  runner: any;
  aesKey?: string;
}

export type McpToolName =
  | "send_message"
  | "read_message"
  | "list_inbox"
  | "list_sent"
  | "get_contract_config"
  | "get_account_stats"
  | "get_message_metadata"
  | "get_current_epoch"
  | "get_epoch_for_timestamp"
  | "get_epoch_usage"
  | "get_pending_rewards"
  | "get_epoch_summary"
  | "claim_rewards"
  | "fund_epoch"
  | "get_starter_grant_challenge"
  | "get_starter_grant_status"
  | "claim_starter_grant"
  | "request_starter_grant";

export interface McpToolDefinition {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}
