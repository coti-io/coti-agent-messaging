import {
  CotiNetwork,
  JsonRpcProvider,
  Wallet,
  getDefaultProvider
} from "@coti-io/coti-ethers";

import type {
  StarterGrantFunder,
  StarterGrantFundingAvailability,
  StarterGrantPendingTransfer
} from "./types.js";

const NATIVE_TRANSFER_GAS_LIMIT = 21_000n;
const GAS_PRICE_BUFFER_NUMERATOR = 12n;
const GAS_PRICE_BUFFER_DENOMINATOR = 10n;

function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

export class CotiStarterGrantFunder implements StarterGrantFunder {
  private readonly wallet: Wallet;
  private readonly confirmTimeoutMs: number;

  constructor(input: {
    funderPrivateKey: string;
    network: "testnet" | "mainnet";
    rpcUrl?: string;
    confirmTimeoutMs: number;
  }) {
    const provider = input.rpcUrl
      ? new JsonRpcProvider(input.rpcUrl)
      : getDefaultProvider(
          input.network === "mainnet" ? CotiNetwork.Mainnet : CotiNetwork.Testnet
        );
    this.wallet = new Wallet(input.funderPrivateKey, provider);
    this.confirmTimeoutMs = input.confirmTimeoutMs;
  }

  async getFundingAvailability(
    amountWei: bigint,
    reservedPendingAmountWei: bigint
  ): Promise<StarterGrantFundingAvailability> {
    const provider = this.wallet.provider;
    if (!provider) {
      throw new Error("starter grant funder provider is not configured");
    }

    const [balance, feeData] = await Promise.all([
      provider.getBalance(this.wallet.address),
      provider.getFeeData()
    ]);
    const rawGasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (rawGasPrice === null || rawGasPrice === undefined || rawGasPrice <= 0n) {
      throw new Error("starter grant gas price is unavailable");
    }

    const bufferedGasPrice =
      (rawGasPrice * GAS_PRICE_BUFFER_NUMERATOR + (GAS_PRICE_BUFFER_DENOMINATOR - 1n)) /
      GAS_PRICE_BUFFER_DENOMINATOR;
    const estimatedGasCostWei = NATIVE_TRANSFER_GAS_LIMIT * bufferedGasPrice;
    const requiredBalanceWei = amountWei + estimatedGasCostWei;
    const availableBalanceWei = balance - reservedPendingAmountWei;

    return {
      funderAddress: this.wallet.address,
      onChainBalanceWei: balance.toString(),
      reservedPendingAmountWei: reservedPendingAmountWei.toString(),
      availableBalanceWei: availableBalanceWei.toString(),
      estimatedGasCostWei: estimatedGasCostWei.toString(),
      requiredBalanceWei: requiredBalanceWei.toString(),
      hasSufficientBalance: availableBalanceWei >= requiredBalanceWei
    };
  }

  async createStarterGrantTransfer(
    walletAddress: string,
    amountWei: bigint
  ): Promise<StarterGrantPendingTransfer> {
    const tx = await this.wallet.sendTransaction({
      to: walletAddress,
      value: amountWei
    });

    return {
      transactionHash: tx.hash,
      waitForConfirmation: async () => {
        const receipt = await promiseWithTimeout(
          tx.wait(1),
          this.confirmTimeoutMs,
          "starter grant transfer confirmation timed out"
        );
        if (!receipt || receipt.status !== 1) {
          throw new Error("starter grant transfer was not confirmed");
        }
      }
    };
  }
}
