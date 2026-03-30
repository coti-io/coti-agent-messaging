import {
  CotiNetwork,
  JsonRpcProvider,
  Wallet,
  getDefaultProvider
} from "@coti-io/coti-ethers";

import type { StarterGrantFunder, StarterGrantPendingTransfer } from "./types.js";

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
