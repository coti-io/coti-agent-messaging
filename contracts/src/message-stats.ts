import { ethers } from "ethers";

import privateMessagingAbi from "../abi/PrivateMessaging.json";

export type CotiNetworkName = "mainnet" | "testnet";

export interface MessageStatsOptions {
  networkName: CotiNetworkName;
  contractAddress: string;
  rpcUrl: string;
  fromBlock?: number;
  toBlock?: number;
  batchSize?: number;
  top?: number;
  epoch?: bigint;
  skipUsage?: boolean;
  contractDeployBlock?: number;
  blockscoutApiUrl?: string;
  log?: (message: string) => void;
}

export interface MessageEvent {
  messageId: bigint;
  from: string;
  to: string;
  epoch: bigint;
  blockNumber: number;
}

export interface MessageDetails extends MessageEvent {
  chunkCount: number;
  usageUnits: number;
}

export interface AgentStats {
  address: string;
  sent: number;
  received: number;
  total: number;
  usageUnitsSent: number;
  multipartSent: number;
}

export interface RouteStats {
  from: string;
  to: string;
  messages: number;
}

export interface MessageStatsReport {
  network: CotiNetworkName;
  contractAddress: string;
  rpcUrl: string;
  scan: {
    fromBlock: number;
    fromBlockSource: string;
    toBlock: number;
    latestBlock: number;
    epochFilter: string | null;
    batchSize: number;
    usageUnitsIncluded: boolean;
  };
  totals: {
    messages: number;
    multipartMessages: number;
    multipartRate: number;
    uniqueSenders: number;
    uniqueRecipients: number;
    uniqueAgents: number;
    uniqueRoutes: number;
    totalChunks: number;
    totalUsageUnits: number;
  };
  averages: {
    messagesPerSender: number;
    messagesPerRecipient: number;
    messagesPerActiveAgent: number;
    chunksPerMessage: number;
    usageUnitsPerMessage: number;
    usageUnitsPerChunk: number;
  };
  distributions: {
    chunkCount: {
      min: number;
      median: number;
      p95: number;
      max: number;
    };
    usageUnits: {
      min: number;
      median: number;
      p95: number;
      max: number;
    };
  };
  coverage: {
    firstMessageAt: number | null;
    lastMessageAt: number | null;
  };
  topAgents: AgentStats[];
  topRoutes: RouteStats[];
  perEpoch: Array<{ epoch: string; messages: number }>;
  perAgent: AgentStats[];
}

type PrivateMessagingReader = {
  getMessageChunkCount(messageId: bigint): Promise<bigint>;
  getNetworkCiphertext(messageId: bigint): Promise<unknown>;
  getNetworkChunkCiphertext(messageId: bigint, chunkIndex: number): Promise<unknown>;
};

const DEFAULT_BATCH_SIZE = 10_000;
const DEFAULT_TOP = 10;
const DETAIL_CONCURRENCY = 6;

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1)
  );
  return sorted[index] ?? 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function getCipherCellCount(ciphertext: unknown): number {
  if (
    ciphertext &&
    typeof ciphertext === "object" &&
    "value" in ciphertext &&
    Array.isArray((ciphertext as { value?: unknown }).value)
  ) {
    return (ciphertext as { value: unknown[] }).value.length;
  }

  if (Array.isArray(ciphertext) && Array.isArray(ciphertext[0])) {
    return ciphertext[0].length;
  }

  return 0;
}

function incrementMap(map: Map<string, number>, key: string, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      }
    }
  }

  throw new Error(
    `${label} failed after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex] as T, currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );

  return results;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }

  return response.json() as Promise<unknown>;
}

function getBlockscoutBaseUrl(options: MessageStatsOptions): string {
  if (options.blockscoutApiUrl) {
    return options.blockscoutApiUrl.replace(/\/+$/, "");
  }

  return options.networkName === "mainnet"
    ? "https://mainnet.cotiscan.io"
    : "https://testnet.cotiscan.io";
}

async function findDeploymentBlockFromExplorer(options: MessageStatsOptions): Promise<number> {
  const baseUrl = getBlockscoutBaseUrl(options);
  const addressUrl = `${baseUrl}/api/v2/addresses/${options.contractAddress}`;
  const addressPayload = await fetchJson(addressUrl);

  if (!isRecord(addressPayload)) {
    throw new Error(`Unexpected Blockscout address response from ${addressUrl}.`);
  }

  const creationTransactionHash = addressPayload.creation_transaction_hash;
  if (typeof creationTransactionHash !== "string" || !creationTransactionHash) {
    throw new Error(`Blockscout did not return a creation transaction for ${options.contractAddress}.`);
  }

  const txUrl = `${baseUrl}/api/v2/transactions/${creationTransactionHash}`;
  const txPayload = await fetchJson(txUrl);
  if (!isRecord(txPayload)) {
    throw new Error(`Unexpected Blockscout transaction response from ${txUrl}.`);
  }

  const blockNumber = txPayload.block_number;
  if (typeof blockNumber !== "number" || !Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error(`Blockscout returned an invalid deployment block for ${options.contractAddress}.`);
  }

  return blockNumber;
}

async function findDeploymentBlock(
  provider: ethers.JsonRpcProvider,
  contractAddress: string,
  latestBlock: number
): Promise<number> {
  const latestCode = await withRetry(`getCode(${contractAddress}, ${latestBlock})`, () =>
    provider.getCode(contractAddress, latestBlock)
  );

  if (latestCode === "0x") {
    throw new Error(`No contract code found at ${contractAddress} on latest block ${latestBlock}.`);
  }

  let low = 0;
  let high = latestBlock;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const code = await withRetry(`getCode(${contractAddress}, ${mid})`, () =>
      provider.getCode(contractAddress, mid)
    );

    if (code === "0x") {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

async function hasContractLog(
  provider: ethers.JsonRpcProvider,
  contractAddress: string,
  fromBlock: number,
  toBlock: number
): Promise<boolean> {
  const logs = await withRetry(`getLogs(${contractAddress}, ${fromBlock}-${toBlock})`, () =>
    provider.getLogs({
      address: contractAddress,
      fromBlock,
      toBlock
    })
  );

  return logs.length > 0;
}

async function findFirstContractLogBlock(
  provider: ethers.JsonRpcProvider,
  contractAddress: string,
  latestBlock: number
): Promise<number> {
  if (!(await hasContractLog(provider, contractAddress, 0, latestBlock))) {
    throw new Error(`No logs found for ${contractAddress} through block ${latestBlock}.`);
  }

  let low = 0;
  let high = latestBlock;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (await hasContractLog(provider, contractAddress, 0, mid)) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  return low;
}

async function resolveFromBlock(
  provider: ethers.JsonRpcProvider,
  options: MessageStatsOptions,
  toBlock: number
): Promise<{ fromBlock: number; source: string }> {
  if (options.fromBlock !== undefined) {
    return { fromBlock: options.fromBlock, source: "cli" };
  }

  if (options.contractDeployBlock !== undefined) {
    return { fromBlock: options.contractDeployBlock, source: "CONTRACT_DEPLOY_BLOCK" };
  }

  options.log?.("Resolving contract deployment block from Blockscout...");
  try {
    return {
      fromBlock: await findDeploymentBlockFromExplorer(options),
      source: "Blockscout creation transaction"
    };
  } catch (error) {
    options.log?.(
      `Could not resolve deployment block from Blockscout: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  options.log?.("Resolving contract deployment block...");
  try {
    return {
      fromBlock: await findDeploymentBlock(provider, options.contractAddress, toBlock),
      source: "archive getCode"
    };
  } catch (error) {
    options.log?.(
      `Could not resolve exact deployment block from historical contract code: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    options.log?.("Falling back to earliest contract log block...");
    return {
      fromBlock: await findFirstContractLogBlock(provider, options.contractAddress, toBlock),
      source: "earliest contract log"
    };
  }
}

async function fetchMessageEvents(
  provider: ethers.JsonRpcProvider,
  contractAddress: string,
  fromBlock: number,
  toBlock: number,
  batchSize: number,
  log?: (message: string) => void
): Promise<MessageEvent[]> {
  const iface = new ethers.Interface(privateMessagingAbi);
  const event = iface.getEvent("MessageSent");
  if (!event) {
    throw new Error("MessageSent event not found in ABI.");
  }
  const events: MessageEvent[] = [];

  for (let start = fromBlock; start <= toBlock; start += batchSize) {
    const end = Math.min(toBlock, start + batchSize - 1);
    log?.(`Scanning blocks ${start}-${end}...`);
    const logs = await provider.getLogs({
      address: contractAddress,
      topics: [event.topicHash],
      fromBlock: start,
      toBlock: end
    });

    for (const logEntry of logs) {
      const parsed = iface.parseLog(logEntry);
      if (!parsed) {
        continue;
      }

      events.push({
        messageId: parsed.args[0] as bigint,
        from: ethers.getAddress(parsed.args[1] as string),
        to: ethers.getAddress(parsed.args[2] as string),
        epoch: parsed.args[3] as bigint,
        blockNumber: logEntry.blockNumber
      });
    }
  }

  return events;
}

async function getMessageUsageUnits(
  contract: PrivateMessagingReader,
  messageId: bigint,
  chunkCount: number
): Promise<number> {
  const firstChunk = await withRetry(`getNetworkCiphertext(${messageId})`, () =>
    contract.getNetworkCiphertext(messageId)
  );

  let totalUsageUnits = getCipherCellCount(firstChunk);

  if (chunkCount <= 1) {
    return totalUsageUnits;
  }

  const extraChunks = await Promise.all(
    Array.from({ length: chunkCount - 1 }, (_, index) =>
      withRetry(`getNetworkChunkCiphertext(${messageId}, ${index + 1})`, () =>
        contract.getNetworkChunkCiphertext(messageId, index + 1)
      )
    )
  );

  for (const chunk of extraChunks) {
    totalUsageUnits += getCipherCellCount(chunk);
  }

  return totalUsageUnits;
}

async function enrichMessages(
  contract: PrivateMessagingReader,
  messages: readonly MessageEvent[],
  skipUsage: boolean,
  log?: (message: string) => void
): Promise<MessageDetails[]> {
  return mapWithConcurrency(messages, DETAIL_CONCURRENCY, async (message, index) => {
    log?.(`Hydrating message ${index + 1}/${messages.length} (${message.messageId})...`);

    const chunkCountRaw = await withRetry(`getMessageChunkCount(${message.messageId})`, () =>
      contract.getMessageChunkCount(message.messageId)
    );
    const chunkCount = Number(chunkCountRaw);

    if (!Number.isSafeInteger(chunkCount) || chunkCount <= 0) {
      throw new Error(`Invalid chunk count for message ${message.messageId}: ${chunkCountRaw}`);
    }

    const usageUnits = skipUsage
      ? 0
      : await getMessageUsageUnits(contract, message.messageId, chunkCount);

    return {
      ...message,
      chunkCount,
      usageUnits
    };
  });
}

function buildAgentStats(messages: readonly MessageDetails[]): Map<string, Omit<AgentStats, "address">> {
  const stats = new Map<string, Omit<AgentStats, "address">>();

  function ensure(address: string): Omit<AgentStats, "address"> {
    const existing = stats.get(address);
    if (existing) {
      return existing;
    }

    const created = {
      sent: 0,
      received: 0,
      total: 0,
      usageUnitsSent: 0,
      multipartSent: 0
    };
    stats.set(address, created);
    return created;
  }

  for (const message of messages) {
    const sender = ensure(message.from);
    sender.sent += 1;
    sender.total += 1;
    sender.usageUnitsSent += message.usageUnits;
    if (message.chunkCount > 1) {
      sender.multipartSent += 1;
    }

    const recipient = ensure(message.to);
    recipient.received += 1;
    recipient.total += 1;
  }

  return stats;
}

function buildRouteStats(messages: readonly MessageDetails[]): RouteStats[] {
  const routes = new Map<string, RouteStats>();

  for (const message of messages) {
    const key = `${message.from}->${message.to}`;
    const existing = routes.get(key);
    if (existing) {
      existing.messages += 1;
      continue;
    }

    routes.set(key, {
      from: message.from,
      to: message.to,
      messages: 1
    });
  }

  return [...routes.values()].sort((left, right) => right.messages - left.messages);
}

export async function collectMessageStats(options: MessageStatsOptions): Promise<MessageStatsReport> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const top = options.top ?? DEFAULT_TOP;
  const skipUsage = options.skipUsage ?? false;
  const provider = new ethers.JsonRpcProvider(options.rpcUrl);
  const latestBlock = await provider.getBlockNumber();
  const toBlock = options.toBlock ?? latestBlock;
  const { fromBlock, source: fromBlockSource } = await resolveFromBlock(provider, options, toBlock);
  const contract = new ethers.Contract(
    options.contractAddress,
    privateMessagingAbi,
    provider
  ) as unknown as PrivateMessagingReader;

  const scannedMessages = await fetchMessageEvents(
    provider,
    options.contractAddress,
    fromBlock,
    toBlock,
    batchSize,
    options.log
  );

  const filteredMessages =
    options.epoch === undefined
      ? scannedMessages
      : scannedMessages.filter((message) => message.epoch === options.epoch);
  const messages = await enrichMessages(contract, filteredMessages, skipUsage, options.log);

  const totalMessages = messages.length;
  const agentStats = buildAgentStats(messages);
  const routeStats = buildRouteStats(messages);
  const senderSet = new Set(messages.map((message) => message.from));
  const recipientSet = new Set(messages.map((message) => message.to));
  const participantSet = new Set([...senderSet, ...recipientSet]);
  const chunkCounts = messages.map((message) => message.chunkCount);
  const usageUnits = messages.map((message) => message.usageUnits);
  const multipartMessages = chunkCounts.filter((chunkCount) => chunkCount > 1).length;
  const epochCounts = new Map<string, number>();

  for (const message of messages) {
    incrementMap(epochCounts, message.epoch.toString());
  }

  const topAgents = [...agentStats.entries()]
    .map(([address, stats]) => ({
      address,
      ...stats
    }))
    .sort((left, right) => {
      if (right.sent !== left.sent) {
        return right.sent - left.sent;
      }
      return right.total - left.total;
    });

  const firstBlockNumber =
    messages.length > 0 ? Math.min(...messages.map((message) => message.blockNumber)) : undefined;
  const lastBlockNumber =
    messages.length > 0 ? Math.max(...messages.map((message) => message.blockNumber)) : undefined;
  const [firstBlock, lastBlock] = await Promise.all([
    firstBlockNumber === undefined ? Promise.resolve(null) : provider.getBlock(firstBlockNumber),
    lastBlockNumber === undefined ? Promise.resolve(null) : provider.getBlock(lastBlockNumber)
  ]);

  return {
    network: options.networkName,
    contractAddress: options.contractAddress,
    rpcUrl: options.rpcUrl,
    scan: {
      fromBlock,
      fromBlockSource,
      toBlock,
      latestBlock,
      epochFilter: options.epoch?.toString() ?? null,
      batchSize,
      usageUnitsIncluded: !skipUsage
    },
    totals: {
      messages: totalMessages,
      multipartMessages,
      multipartRate: totalMessages === 0 ? 0 : multipartMessages / totalMessages,
      uniqueSenders: senderSet.size,
      uniqueRecipients: recipientSet.size,
      uniqueAgents: participantSet.size,
      uniqueRoutes: routeStats.length,
      totalChunks: sum(chunkCounts),
      totalUsageUnits: sum(usageUnits)
    },
    averages: {
      messagesPerSender: senderSet.size === 0 ? 0 : totalMessages / senderSet.size,
      messagesPerRecipient: recipientSet.size === 0 ? 0 : totalMessages / recipientSet.size,
      messagesPerActiveAgent:
        participantSet.size === 0 ? 0 : (totalMessages * 2) / participantSet.size,
      chunksPerMessage: average(chunkCounts),
      usageUnitsPerMessage: average(usageUnits),
      usageUnitsPerChunk: sum(chunkCounts) === 0 ? 0 : sum(usageUnits) / sum(chunkCounts)
    },
    distributions: {
      chunkCount: {
        min: chunkCounts.length === 0 ? 0 : Math.min(...chunkCounts),
        median: percentile(chunkCounts, 50),
        p95: percentile(chunkCounts, 95),
        max: chunkCounts.length === 0 ? 0 : Math.max(...chunkCounts)
      },
      usageUnits: {
        min: usageUnits.length === 0 ? 0 : Math.min(...usageUnits),
        median: percentile(usageUnits, 50),
        p95: percentile(usageUnits, 95),
        max: usageUnits.length === 0 ? 0 : Math.max(...usageUnits)
      }
    },
    coverage: {
      firstMessageAt: firstBlock?.timestamp ?? null,
      lastMessageAt: lastBlock?.timestamp ?? null
    },
    topAgents: topAgents.slice(0, top),
    topRoutes: routeStats.slice(0, top),
    perEpoch: [...epochCounts.entries()]
      .map(([epoch, count]) => ({ epoch, messages: count }))
      .sort((left, right) => Number(left.epoch) - Number(right.epoch)),
    perAgent: topAgents
  };
}

export function resolveMessageStatsRpcUrl(
  networkName: CotiNetworkName,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (env.COTI_RPC_URL) {
    return env.COTI_RPC_URL;
  }

  return networkName === "mainnet"
    ? env.COTI_MAINNET_RPC_URL ?? "https://mainnet.coti.io/rpc"
    : env.COTI_TESTNET_RPC_URL ?? "https://testnet.coti.io/rpc";
}

export function formatTimestamp(unixSeconds: number | undefined | null): string {
  if (!unixSeconds) {
    return "n/a";
  }
  return new Date(unixSeconds * 1_000).toISOString();
}

export function formatNumber(value: number, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits
  }).format(value);
}
