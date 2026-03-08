import type {
  ClaimRewardsRequest,
  ClaimRewardsResult,
  ContractConfig,
  EpochUsage,
  EpochSummary,
  FundEpochRequest
} from "./types.js";
import { PrivateAgentMessagingClient } from "./client.js";

export async function getCurrentEpoch(client: PrivateAgentMessagingClient): Promise<bigint> {
  return BigInt(await client.contract.currentEpoch());
}

export async function getEpochForTimestamp(
  client: PrivateAgentMessagingClient,
  timestamp: bigint | number | string
): Promise<bigint> {
  return BigInt(await client.contract.epochForTimestamp(timestamp));
}

export async function getContractConfig(
  client: PrivateAgentMessagingClient
): Promise<ContractConfig> {
  const [owner, epochDuration, genesisTimestamp, maxChunkCells, maxChunksPerMessage] =
    await Promise.all([
      client.contract.owner(),
      client.contract.epochDuration(),
      client.contract.genesisTimestamp(),
      client.contract.MAX_CHUNK_CELLS(),
      client.contract.MAX_CHUNKS_PER_MESSAGE()
    ]);

  return {
    owner,
    epochDuration: BigInt(epochDuration),
    genesisTimestamp: BigInt(genesisTimestamp),
    maxChunkCells: BigInt(maxChunkCells),
    maxChunksPerMessage: BigInt(maxChunksPerMessage)
  };
}

export async function getPendingRewards(
  client: PrivateAgentMessagingClient,
  epoch: bigint | number | string,
  agent: string
): Promise<bigint> {
  return BigInt(await client.contract.pendingRewards(epoch, agent));
}

export async function getEpochUsage(
  client: PrivateAgentMessagingClient,
  epoch: bigint | number | string,
  agent: string
): Promise<EpochUsage> {
  const [usageUnits, totalUsageUnits, hasClaimed, pendingRewards] = await Promise.all([
    client.contract.epochUsageUnits(epoch, agent),
    client.contract.epochTotalUsageUnits(epoch),
    client.contract.epochHasClaimed(epoch, agent),
    client.contract.pendingRewards(epoch, agent)
  ]);

  return {
    epoch: BigInt(epoch),
    agent,
    usageUnits: BigInt(usageUnits),
    totalUsageUnits: BigInt(totalUsageUnits),
    pendingRewards: BigInt(pendingRewards),
    hasClaimed
  };
}

export async function getEpochSummary(
  client: PrivateAgentMessagingClient,
  epoch: bigint | number | string
): Promise<EpochSummary> {
  const [totalUsageUnits, rewardPool, claimedAmount, claimedUsageUnits] =
    await client.contract.getEpochSummary(epoch);

  return {
    totalUsageUnits: BigInt(totalUsageUnits),
    rewardPool: BigInt(rewardPool),
    claimedAmount: BigInt(claimedAmount),
    claimedUsageUnits: BigInt(claimedUsageUnits)
  };
}

export async function claimRewards(
  client: PrivateAgentMessagingClient,
  request: ClaimRewardsRequest
): Promise<ClaimRewardsResult> {
  const callResult = await client.contract.claimRewards.staticCall(request.epoch);
  const tx = await client.contract.claimRewards(request.epoch);
  const receipt = await tx.wait();

  return {
    transactionHash: receipt.hash ?? tx.hash,
    amount: BigInt(callResult)
  };
}

export async function fundEpoch(
  client: PrivateAgentMessagingClient,
  request: FundEpochRequest
): Promise<string> {
  const tx = await client.contract.fundEpoch(request.epoch, {
    value: request.amountWei
  });
  const receipt = await tx.wait();

  return receipt.hash ?? tx.hash;
}
