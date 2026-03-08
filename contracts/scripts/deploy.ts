import { ethers } from "hardhat";

const DEFAULT_EPOCH_DURATION = 14 * 24 * 60 * 60;
const DEFAULT_REMOTE_GAS_LIMIT = 12_000_000n;

async function buildDeployOverrides(initialFundingWei: string) {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const isHardhatNetwork = network.name === "hardhat";

  const overrides: Record<string, bigint | number> = {
    value: BigInt(initialFundingWei)
  };

  if (!isHardhatNetwork) {
    // Some COTI RPCs do not support the pending block tag used by the default deploy flow.
    overrides.nonce = await ethers.provider.getTransactionCount(
      deployer.address,
      "latest"
    );
    overrides.gasLimit = BigInt(
      process.env.DEPLOY_GAS_LIMIT ?? DEFAULT_REMOTE_GAS_LIMIT
    );
  }

  if (process.env.DEPLOY_GAS_PRICE_WEI) {
    overrides.gasPrice = BigInt(process.env.DEPLOY_GAS_PRICE_WEI);
  }

  if (process.env.DEPLOY_MAX_FEE_PER_GAS_WEI) {
    overrides.maxFeePerGas = BigInt(process.env.DEPLOY_MAX_FEE_PER_GAS_WEI);
  }

  if (process.env.DEPLOY_MAX_PRIORITY_FEE_PER_GAS_WEI) {
    overrides.maxPriorityFeePerGas = BigInt(
      process.env.DEPLOY_MAX_PRIORITY_FEE_PER_GAS_WEI
    );
  }

  return overrides;
}

async function main() {
  const epochDurationSeconds = Number(
    process.env.EPOCH_DURATION_SECONDS ?? DEFAULT_EPOCH_DURATION
  );
  const initialFundingWei = process.env.INITIAL_REWARD_FUND_WEI ?? "0";

  if (!Number.isFinite(epochDurationSeconds) || epochDurationSeconds <= 0) {
    throw new Error("EPOCH_DURATION_SECONDS must be a positive integer.");
  }

  const deployOverrides = await buildDeployOverrides(initialFundingWei);
  const factory = await ethers.getContractFactory("PrivateAgentMessaging");
  const contract = await factory.deploy(epochDurationSeconds, deployOverrides);

  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const network = await ethers.provider.getNetwork();

  console.log("PrivateAgentMessaging deployed");
  console.log(`network: ${network.name} (${network.chainId})`);
  console.log(`address: ${address}`);
  console.log(`epochDurationSeconds: ${epochDurationSeconds}`);
  console.log(`initialRewardFundWei: ${initialFundingWei}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
