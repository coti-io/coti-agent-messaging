import { PrivateAgentMessagingClient } from "./client.js";
import { listInbox, listSent, readMessage, sendMessage } from "./messages.js";
import {
  claimRewards,
  fundEpoch,
  getCurrentEpoch,
  getEpochSummary,
  getPendingRewards
} from "./rewards.js";
import { toJsonValue, type JsonValue } from "./serialize.js";
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
    description: "Encrypt and send a private message body to a public recipient address.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient wallet address" },
        plaintext: { type: "string", description: "Message body to encrypt" }
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
    name: "get_current_epoch",
    description: "Read the current 14-day reward epoch.",
    inputSchema: {
      type: "object",
      properties: {}
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
    description: "Read message-count and reward-pool totals for an epoch.",
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
  rawInput: unknown
): Promise<JsonValue> {
  const input = asObject(rawInput);

  switch (toolName) {
    case "send_message":
      return toJsonValue(
        await sendMessage(client, {
          to: asString(input.to, "to"),
          plaintext: asString(input.plaintext, "plaintext")
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
    case "get_current_epoch":
      return toJsonValue({
        epoch: await getCurrentEpoch(client)
      });
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
  }

  const exhaustiveCheck: never = toolName;
  throw new Error(`Unsupported tool: ${exhaustiveCheck}`);
}
