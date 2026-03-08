import "dotenv/config";

import {
  CotiNetwork,
  JsonRpcProvider,
  Wallet,
  getDefaultProvider
} from "@coti-io/coti-ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createPrivateAgentMessagingClient } from "./client.js";
import { invokePrivateAgentMessagingTool } from "./mcp.js";
import { PRIVATE_AGENT_MESSAGING_MCP_TOOLS } from "./mcp.js";

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function resolveNetwork(): CotiNetwork {
  const raw = (process.env.COTI_NETWORK ?? "testnet").toLowerCase();

  if (raw === "mainnet") {
    return CotiNetwork.Mainnet;
  }

  return CotiNetwork.Testnet;
}

function resolveRpcUrl(): string | undefined {
  if (process.env.COTI_RPC_URL) {
    return process.env.COTI_RPC_URL;
  }

  const network = resolveNetwork();
  if (network === CotiNetwork.Mainnet) {
    return process.env.COTI_MAINNET_RPC_URL;
  }

  return process.env.COTI_TESTNET_RPC_URL;
}

function buildClient() {
  const network = resolveNetwork();
  const rpcUrl = resolveRpcUrl();
  const provider = rpcUrl ? new JsonRpcProvider(rpcUrl) : getDefaultProvider(network);
  const wallet = new Wallet(getRequiredEnv("PRIVATE_KEY"), provider);
  wallet.setAesKey(getRequiredEnv("AES_KEY"));

  return createPrivateAgentMessagingClient({
    contractAddress: getRequiredEnv("CONTRACT_ADDRESS"),
    runner: wallet
  });
}

function formatToolContent(result: unknown) {
  return [
    {
      type: "text" as const,
      text: JSON.stringify(result, null, 2)
    }
  ];
}

export async function startMcpServer() {
  const client = buildClient();

  const server = new McpServer(
    {
      name: "coti-agent-messaging",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      },
      instructions:
        "Private agent messaging on COTI with encrypted message bodies, inbox/sent queries, epoch summaries, and reward claims."
    }
  );

  server.registerTool(
    "send_message",
    {
      title: "Send Message",
      description: PRIVATE_AGENT_MESSAGING_MCP_TOOLS.find((tool) => tool.name === "send_message")
        ?.description,
      inputSchema: {
        to: z.string().min(1),
        plaintext: z.string(),
        maxChunkBytes: z.number().int().positive().optional(),
        gasLimit: z.union([z.string(), z.number().int().nonnegative()]).optional(),
        gasBufferBps: z.number().int().nonnegative().optional()
      }
    },
    async (args) => {
      const result = await invokePrivateAgentMessagingTool(client, "send_message", args);
      return { content: formatToolContent(result) };
    }
  );

  server.registerTool(
    "read_message",
    {
      title: "Read Message",
      description: PRIVATE_AGENT_MESSAGING_MCP_TOOLS.find((tool) => tool.name === "read_message")
        ?.description,
      inputSchema: {
        messageId: z.union([z.string(), z.number().int().nonnegative()]),
        decrypt: z.boolean().optional()
      }
    },
    async (args) => {
      const result = await invokePrivateAgentMessagingTool(client, "read_message", args);
      return { content: formatToolContent(result) };
    }
  );

  const listSchema = {
    account: z.string().min(1),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
    decrypt: z.boolean().optional()
  };

  server.registerTool(
    "list_inbox",
    {
      title: "List Inbox",
      description: PRIVATE_AGENT_MESSAGING_MCP_TOOLS.find((tool) => tool.name === "list_inbox")
        ?.description,
      inputSchema: listSchema
    },
    async (args) => {
      const result = await invokePrivateAgentMessagingTool(client, "list_inbox", args);
      return { content: formatToolContent(result) };
    }
  );

  server.registerTool(
    "list_sent",
    {
      title: "List Sent",
      description: PRIVATE_AGENT_MESSAGING_MCP_TOOLS.find((tool) => tool.name === "list_sent")
        ?.description,
      inputSchema: listSchema
    },
    async (args) => {
      const result = await invokePrivateAgentMessagingTool(client, "list_sent", args);
      return { content: formatToolContent(result) };
    }
  );

  server.registerTool(
    "get_contract_config",
    {
      title: "Get Contract Config",
      description: PRIVATE_AGENT_MESSAGING_MCP_TOOLS.find(
        (tool) => tool.name === "get_contract_config"
      )?.description
    },
    async () => {
      const result = await invokePrivateAgentMessagingTool(client, "get_contract_config", {});
      return { content: formatToolContent(result) };
    }
  );

  server.registerTool(
    "get_account_stats",
    {
      title: "Get Account Stats",
      description: PRIVATE_AGENT_MESSAGING_MCP_TOOLS.find(
        (tool) => tool.name === "get_account_stats"
      )?.description,
      inputSchema: {
        account: z.string().min(1)
      }
    },
    async (args) => {
      const result = await invokePrivateAgentMessagingTool(client, "get_account_stats", args);
      return { content: formatToolContent(result) };
    }
  );

  server.registerTool(
    "get_message_metadata",
    {
      title: "Get Message Metadata",
      description: PRIVATE_AGENT_MESSAGING_MCP_TOOLS.find(
        (tool) => tool.name === "get_message_metadata"
      )?.description,
      inputSchema: {
        messageId: z.union([z.string(), z.number().int().nonnegative()])
      }
    },
    async (args) => {
      const result = await invokePrivateAgentMessagingTool(client, "get_message_metadata", args);
      return { content: formatToolContent(result) };
    }
  );

  server.registerTool(
    "get_current_epoch",
    {
      title: "Get Current Epoch",
      description: PRIVATE_AGENT_MESSAGING_MCP_TOOLS.find(
        (tool) => tool.name === "get_current_epoch"
      )?.description
    },
    async () => {
      const result = await invokePrivateAgentMessagingTool(client, "get_current_epoch", {});
      return { content: formatToolContent(result) };
    }
  );

  const epochSchema = {
    epoch: z.union([z.string(), z.number().int().nonnegative()])
  };

  server.registerTool(
    "get_epoch_for_timestamp",
    {
      title: "Get Epoch For Timestamp",
      description: PRIVATE_AGENT_MESSAGING_MCP_TOOLS.find(
        (tool) => tool.name === "get_epoch_for_timestamp"
      )?.description,
      inputSchema: {
        timestamp: z.union([z.string(), z.number().int().nonnegative()])
      }
    },
    async (args) => {
      const result = await invokePrivateAgentMessagingTool(
        client,
        "get_epoch_for_timestamp",
        args
      );
      return { content: formatToolContent(result) };
    }
  );

  server.registerTool(
    "get_epoch_usage",
    {
      title: "Get Epoch Usage",
      description: PRIVATE_AGENT_MESSAGING_MCP_TOOLS.find(
        (tool) => tool.name === "get_epoch_usage"
      )?.description,
      inputSchema: {
        epoch: z.union([z.string(), z.number().int().nonnegative()]),
        agent: z.string().min(1)
      }
    },
    async (args) => {
      const result = await invokePrivateAgentMessagingTool(client, "get_epoch_usage", args);
      return { content: formatToolContent(result) };
    }
  );

  server.registerTool(
    "get_epoch_summary",
    {
      title: "Get Epoch Summary",
      description: PRIVATE_AGENT_MESSAGING_MCP_TOOLS.find(
        (tool) => tool.name === "get_epoch_summary"
      )?.description,
      inputSchema: epochSchema
    },
    async (args) => {
      const result = await invokePrivateAgentMessagingTool(client, "get_epoch_summary", args);
      return { content: formatToolContent(result) };
    }
  );

  server.registerTool(
    "get_pending_rewards",
    {
      title: "Get Pending Rewards",
      description: PRIVATE_AGENT_MESSAGING_MCP_TOOLS.find(
        (tool) => tool.name === "get_pending_rewards"
      )?.description,
      inputSchema: {
        epoch: z.union([z.string(), z.number().int().nonnegative()]),
        agent: z.string().min(1)
      }
    },
    async (args) => {
      const result = await invokePrivateAgentMessagingTool(client, "get_pending_rewards", args);
      return { content: formatToolContent(result) };
    }
  );

  server.registerTool(
    "claim_rewards",
    {
      title: "Claim Rewards",
      description: PRIVATE_AGENT_MESSAGING_MCP_TOOLS.find(
        (tool) => tool.name === "claim_rewards"
      )?.description,
      inputSchema: epochSchema
    },
    async (args) => {
      const result = await invokePrivateAgentMessagingTool(client, "claim_rewards", args);
      return { content: formatToolContent(result) };
    }
  );

  server.registerTool(
    "fund_epoch",
    {
      title: "Fund Epoch",
      description: PRIVATE_AGENT_MESSAGING_MCP_TOOLS.find((tool) => tool.name === "fund_epoch")
        ?.description,
      inputSchema: {
        epoch: z.union([z.string(), z.number().int().nonnegative()]),
        amountWei: z.union([z.string(), z.number().int().nonnegative()])
      }
    },
    async (args) => {
      const result = await invokePrivateAgentMessagingTool(client, "fund_epoch", args);
      return { content: formatToolContent(result) };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isDirectExecution = process.argv[1]?.endsWith("/server.js");

if (isDirectExecution) {
  startMcpServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
