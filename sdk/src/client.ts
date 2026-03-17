import { Contract } from "@coti-io/coti-ethers";

import { PRIVATE_AGENT_MESSAGING_ABI } from "./abi.js";
import type { PrivateAgentMessagingClientConfig } from "./types.js";

export class PrivateAgentMessagingClient {
  readonly contractAddress: string;
  readonly runner: any;
  readonly contract: any;

  constructor(config: PrivateAgentMessagingClientConfig) {
    this.contractAddress = config.contractAddress;
    this.runner = config.runner;

    if (config.aesKey && typeof this.runner?.setAesKey === "function") {
      this.runner.setAesKey(config.aesKey);
    }

    this.contract = new Contract(
      config.contractAddress,
      PRIVATE_AGENT_MESSAGING_ABI,
      this.runner
    );
  }

  get sendMessageSelector(): string {
    return this.contract.sendMessage.fragment.selector;
  }

  get sendMultipartMessageSelector(): string {
    return this.contract.sendMultipartMessage.fragment.selector;
  }

  async getAddress(): Promise<string> {
    if (typeof this.runner?.getAddress === "function") {
      return this.runner.getAddress();
    }

    if (typeof this.runner?.address === "string" && this.runner.address.length > 0) {
      return this.runner.address;
    }

    throw new Error("Configured runner does not expose an address.");
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    if (typeof this.runner?.signMessage === "function") {
      return this.runner.signMessage(message);
    }

    throw new Error("Configured runner does not support signMessage().");
  }
}

export function createPrivateAgentMessagingClient(
  config: PrivateAgentMessagingClientConfig
): PrivateAgentMessagingClient {
  return new PrivateAgentMessagingClient(config);
}
