import {
  CotiNetwork,
  JsonRpcProvider,
  Wallet,
  getDefaultProvider
} from "@coti-io/coti-ethers";

import type { StarterGrantFunder } from "./types.js";

export class CotiStarterGrantFunder implements StarterGrantFunder {
  private readonly wallet: Wallet;

  constructor(input: {
    funderPrivateKey: string;
    network: "testnet" | "mainnet";
    rpcUrl?: string;
  }) {
    const provider = input.rpcUrl
      ? new JsonRpcProvider(input.rpcUrl)
      : getDefaultProvider(
          input.network === "mainnet" ? CotiNetwork.Mainnet : CotiNetwork.Testnet
        );
    this.wallet = new Wallet(input.funderPrivateKey, provider);
  }

  async fundStarterGrant(walletAddress: string, amountWei: bigint): Promise<{ transactionHash: string }> {
    const tx = await this.wallet.sendTransaction({
      to: walletAddress,
      value: amountWei
    });

    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      throw new Error("starter grant transfer was not confirmed");
    }

    return {
      transactionHash: tx.hash
    };
  }
}
