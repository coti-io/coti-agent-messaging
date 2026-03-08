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

export interface PrivateAgentMessagingClientConfig {
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
  | "fund_epoch";

export interface McpToolDefinition {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}
