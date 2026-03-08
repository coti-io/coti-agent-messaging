import type {
  ClaimRewardsRequest,
  ClaimRewardsResult,
  EpochSummary,
  FundEpochRequest
} from "./types.js";
import { PrivateAgentMessagingClient } from "./client.js";

export async function getCurrentEpoch(client: PrivateAgentMessagingClient): Promise<bigint> {
  return BigInt(await client.contract.currentEpoch());
}

export async function getPendingRewards(
  client: PrivateAgentMessagingClient,
  epoch: bigint | number | string,
  agent: string
): Promise<bigint> {
  return BigInt(await client.contract.pendingRewards(epoch, agent));
}

export async function getEpochSummary(
  client: PrivateAgentMessagingClient,
  epoch: bigint | number | string
): Promise<EpochSummary> {
  const [totalMessages, rewardPool, claimedAmount, claimedUsage] =
    await client.contract.getEpochSummary(epoch);

  return {
    totalMessages: BigInt(totalMessages),
    rewardPool: BigInt(rewardPool),
    claimedAmount: BigInt(claimedAmount),
    claimedUsage: BigInt(claimedUsage)
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
