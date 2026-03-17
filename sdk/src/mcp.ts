import { PrivateAgentMessagingClient } from "./client.js";
import {
  getAccountStats,
  getMessageMetadata,
  listInbox,
  listSent,
  readMessage,
  sendMessage
} from "./messages.js";
import {
  claimRewards,
  fundEpoch,
  getContractConfig,
  getCurrentEpoch,
  getEpochForTimestamp,
  getEpochSummary,
  getEpochUsage,
  getPendingRewards
} from "./rewards.js";
import {
  claimStarterGrant,
  getStarterGrantChallenge,
  getStarterGrantStatus,
  requestStarterGrant
} from "./starter-grants.js";
import { toJsonValue, type JsonValue } from "./serialize.js";
import type { StarterGrantServiceConfig } from "./types.js";
import type { McpToolDefinition, McpToolName } from "./types.js";

const paginationSchema = {
  type: "object",
  properties: {
    account: { type: "string", description: "Wallet address to query" },
    offset: { type: "integer", minimum: 0, default: 0 },
    limit: { type: "integer", minimum: 1, default: 20 },
    decrypt: { type: "boolean", default: true }
  },
  required: ["account"]
} as const;

export const PRIVATE_AGENT_MESSAGING_MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "send_message",
    description: "Encrypt and send a private message body to a public recipient address, chunking long plaintext automatically.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient wallet address" },
        plaintext: { type: "string", description: "Message body to encrypt" },
        maxChunkBytes: {
          type: "integer",
          minimum: 1,
          description: "Optional chunk size in bytes. Defaults to 24 bytes."
        },
        gasLimit: {
          oneOf: [{ type: "string" }, { type: "integer" }],
          description: "Optional manual gas limit override for the send transaction."
        },
        gasBufferBps: {
          type: "integer",
          minimum: 0,
          description: "Optional multipart gas buffer in basis points. Defaults to 2000."
        }
      },
      required: ["to", "plaintext"]
    }
  },
  {
    name: "read_message",
    description: "Read one message and optionally decrypt it for the current viewer.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: {
          oneOf: [{ type: "string" }, { type: "integer" }],
          description: "Message identifier"
        },
        decrypt: { type: "boolean", default: true }
      },
      required: ["messageId"]
    }
  },
  {
    name: "list_inbox",
    description: "List inbox message IDs or fully resolved inbox messages for an account.",
    inputSchema: paginationSchema
  },
  {
    name: "list_sent",
    description: "List sent-message IDs or fully resolved sent messages for an account.",
    inputSchema: paginationSchema
  },
  {
    name: "get_contract_config",
    description: "Read contract ownership, epoch timing, and chunk-limit configuration.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "get_account_stats",
    description: "Read inbox and sent-message counts for an account.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Wallet address to inspect" }
      },
      required: ["account"]
    }
  },
  {
    name: "get_message_metadata",
    description: "Read public routing and timestamp metadata for a message without decrypting it.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: {
          oneOf: [{ type: "string" }, { type: "integer" }],
          description: "Message identifier"
        }
      },
      required: ["messageId"]
    }
  },
  {
    name: "get_current_epoch",
    description: "Read the current 14-day reward epoch.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "get_epoch_for_timestamp",
    description: "Resolve which reward epoch contains a given Unix timestamp.",
    inputSchema: {
      type: "object",
      properties: {
        timestamp: {
          oneOf: [{ type: "string" }, { type: "integer" }],
          description: "Unix timestamp in seconds"
        }
      },
      required: ["timestamp"]
    }
  },
  {
    name: "get_epoch_usage",
    description: "Read an agent's encrypted-cell usage, claim status, and pending rewards for an epoch.",
    inputSchema: {
      type: "object",
      properties: {
        epoch: {
          oneOf: [{ type: "string" }, { type: "integer" }],
          description: "Epoch identifier"
        },
        agent: { type: "string", description: "Agent wallet address" }
      },
      required: ["epoch", "agent"]
    }
  },
  {
    name: "get_pending_rewards",
    description: "Read how much native-token reward an agent can claim for an epoch.",
    inputSchema: {
      type: "object",
      properties: {
        epoch: {
          oneOf: [{ type: "string" }, { type: "integer" }],
          description: "Closed epoch to inspect"
        },
        agent: { type: "string", description: "Agent wallet address" }
      },
      required: ["epoch", "agent"]
    }
  },
  {
    name: "get_epoch_summary",
    description: "Read usage-unit and reward-pool totals for an epoch.",
    inputSchema: {
      type: "object",
      properties: {
        epoch: {
          oneOf: [{ type: "string" }, { type: "integer" }],
          description: "Epoch identifier"
        }
      },
      required: ["epoch"]
    }
  },
  {
    name: "claim_rewards",
    description: "Claim the caller's native-token rewards for a closed epoch.",
    inputSchema: {
      type: "object",
      properties: {
        epoch: {
          oneOf: [{ type: "string" }, { type: "integer" }],
          description: "Closed epoch to claim"
        }
      },
      required: ["epoch"]
    }
  },
  {
    name: "fund_epoch",
    description: "Fund an epoch reward pool with native token.",
    inputSchema: {
      type: "object",
      properties: {
        epoch: {
          oneOf: [{ type: "string" }, { type: "integer" }],
          description: "Epoch identifier"
        },
        amountWei: {
          oneOf: [{ type: "string" }, { type: "integer" }],
          description: "Funding amount in wei"
        }
      },
      required: ["epoch", "amountWei"]
    }
  },
  {
    name: "get_starter_grant_challenge",
    description:
      "Request a one-time starter COTI challenge for the configured wallet and local MCP install.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "get_starter_grant_status",
    description:
      "Check whether the configured wallet/install is eligible, has a pending challenge, or already claimed a starter grant.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "claim_starter_grant",
    description:
      "Submit the solved starter COTI challenge and sign the backend-issued claim payload with the configured wallet.",
    inputSchema: {
      type: "object",
      properties: {
        challengeId: { type: "string", description: "Starter grant challenge identifier" },
        challengeAnswer: {
          type: "string",
          description: "Answer to the starter-grant prompt"
        },
        claimPayload: {
          type: "string",
          description: "Opaque backend-issued payload that will be signed by the configured wallet"
        }
      },
      required: ["challengeId", "challengeAnswer", "claimPayload"]
    }
  },
  {
    name: "request_starter_grant",
    description:
      "Request and immediately submit the current trivial starter-grant challenge in one MCP call.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
] as const;

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for "${field}".`);
  }

  return value;
}

function asIdLike(value: unknown, field: string): string | number | bigint {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return value;
  }

  throw new Error(`Expected string, number, or bigint for "${field}".`);
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

export async function invokePrivateAgentMessagingTool(
  client: PrivateAgentMessagingClient,
  toolName: McpToolName,
  rawInput: unknown,
  options?: {
    starterGrantConfig?: StarterGrantServiceConfig;
    fetchImpl?: typeof fetch;
  }
): Promise<JsonValue> {
  const input = asObject(rawInput);

  switch (toolName) {
    case "send_message":
      return toJsonValue(
        await sendMessage(client, {
          to: asString(input.to, "to"),
          plaintext: asString(input.plaintext, "plaintext"),
          maxChunkBytes:
            input.maxChunkBytes === undefined
              ? undefined
              : asNumber(input.maxChunkBytes, 24),
          gasLimit:
            input.gasLimit === undefined ? undefined : asIdLike(input.gasLimit, "gasLimit"),
          gasBufferBps:
            input.gasBufferBps === undefined
              ? undefined
              : asNumber(input.gasBufferBps, 2000)
        })
      );
    case "read_message":
      return toJsonValue(
        await readMessage(client, {
          messageId: asIdLike(input.messageId, "messageId"),
          decrypt: asBoolean(input.decrypt, true)
        })
      );
    case "list_inbox":
      return toJsonValue(
        await listInbox(client, {
          account: asString(input.account, "account"),
          offset: asNumber(input.offset, 0),
          limit: asNumber(input.limit, 20),
          decrypt: asBoolean(input.decrypt, true)
        })
      );
    case "list_sent":
      return toJsonValue(
        await listSent(client, {
          account: asString(input.account, "account"),
          offset: asNumber(input.offset, 0),
          limit: asNumber(input.limit, 20),
          decrypt: asBoolean(input.decrypt, true)
        })
      );
    case "get_contract_config":
      return toJsonValue(await getContractConfig(client));
    case "get_account_stats":
      return toJsonValue(await getAccountStats(client, asString(input.account, "account")));
    case "get_message_metadata":
      return toJsonValue(
        await getMessageMetadata(client, asIdLike(input.messageId, "messageId"))
      );
    case "get_current_epoch":
      return toJsonValue({
        epoch: await getCurrentEpoch(client)
      });
    case "get_epoch_for_timestamp":
      return toJsonValue({
        timestamp: asIdLike(input.timestamp, "timestamp"),
        epoch: await getEpochForTimestamp(client, asIdLike(input.timestamp, "timestamp"))
      });
    case "get_epoch_usage":
      return toJsonValue(
        await getEpochUsage(
          client,
          asIdLike(input.epoch, "epoch"),
          asString(input.agent, "agent")
        )
      );
    case "get_pending_rewards":
      return toJsonValue({
        epoch: asIdLike(input.epoch, "epoch"),
        agent: asString(input.agent, "agent"),
        amount: await getPendingRewards(
          client,
          asIdLike(input.epoch, "epoch"),
          asString(input.agent, "agent")
        )
      });
    case "get_epoch_summary":
      return toJsonValue(
        await getEpochSummary(client, asIdLike(input.epoch, "epoch"))
      );
    case "claim_rewards":
      return toJsonValue(
        await claimRewards(client, {
          epoch: asIdLike(input.epoch, "epoch")
        })
      );
    case "fund_epoch":
      return toJsonValue({
        transactionHash: await fundEpoch(client, {
          epoch: asIdLike(input.epoch, "epoch"),
          amountWei: BigInt(asIdLike(input.amountWei, "amountWei"))
        })
      });
    case "get_starter_grant_challenge":
      return toJsonValue(
        await getStarterGrantChallenge(client, options?.starterGrantConfig, options?.fetchImpl)
      );
    case "get_starter_grant_status":
      return toJsonValue(
        await getStarterGrantStatus(client, options?.starterGrantConfig, options?.fetchImpl)
      );
    case "claim_starter_grant":
      return toJsonValue(
        await claimStarterGrant(
          client,
          options?.starterGrantConfig,
          {
            challengeId: asString(input.challengeId, "challengeId"),
            challengeAnswer: asString(input.challengeAnswer, "challengeAnswer"),
            claimPayload: asString(input.claimPayload, "claimPayload")
          },
          options?.fetchImpl
        )
      );
    case "request_starter_grant":
      return toJsonValue(
        await requestStarterGrant(client, options?.starterGrantConfig, options?.fetchImpl)
      );
  }

  const exhaustiveCheck: never = toolName;
  throw new Error(`Unsupported tool: ${exhaustiveCheck}`);
}
