import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  getContractConfig,
  getCurrentEpoch,
  getPendingRewards,
  type ContractConfig
} from "@coti-agent-messaging/sdk";

import { buildPrivateMessagingClient, type MoltbookRuntimeConfig } from "./config.js";

export interface ProductClaim {
  id: string;
  headline: string;
  detail: string;
  sourcePaths: string[];
  evidence: string[];
  emphasis: "primary" | "secondary" | "bonus";
}

export interface ProductLiveSnapshot {
  walletAddress?: string;
  currentEpoch?: string;
  contractConfig?: {
    owner: string;
    epochDuration: string;
    genesisTimestamp: string;
    maxChunkCells: string;
    maxChunksPerMessage: string;
  };
  pendingRewards?: string;
}

export interface ProductFactSheet {
  claims: ProductClaim[];
  liveSnapshot: ProductLiveSnapshot;
}

interface DocSourceDefinition {
  relativePath: string;
  phrases: string[];
}

const DOC_SOURCES: readonly DocSourceDefinition[] = [
  {
    relativePath: "docs/overview.md",
    phrases: [
      "The message body is encrypted",
      "Rewards are funded in native COTI",
      "Time is divided into 14-day epochs"
    ]
  },
  {
    relativePath: "docs/mcp.md",
    phrases: [
      "sending encrypted messages",
      "reading inbox and sent items",
      "tracking epoch usage and rewards"
    ]
  },
  {
    relativePath: "docs/rewards.md",
    phrases: [
      "Reward usage is counted by encrypted cell count",
      "claimable = rewardPool * senderUsage / totalUsage",
      "This is intentionally pull-based"
    ]
  }
];

function snippetAround(source: string, phrase: string): string {
  const index = source.indexOf(phrase);
  if (index === -1) {
    throw new Error(`Expected phrase not found in docs: "${phrase}"`);
  }

  const start = Math.max(0, index - 60);
  const end = Math.min(source.length, index + phrase.length + 60);
  return source.slice(start, end).replace(/\s+/g, " ").trim();
}

async function loadDocEvidence(projectRoot: string): Promise<Map<string, string[]>> {
  const evidence = new Map<string, string[]>();

  await Promise.all(
    DOC_SOURCES.map(async (docSource) => {
      const fullPath = path.join(projectRoot, docSource.relativePath);
      const content = await readFile(fullPath, "utf8");
      evidence.set(
        fullPath,
        docSource.phrases.map((phrase) => snippetAround(content, phrase))
      );
    })
  );

  return evidence;
}

function serializeContractConfig(contractConfig: ContractConfig): ProductLiveSnapshot["contractConfig"] {
  return {
    owner: contractConfig.owner,
    epochDuration: contractConfig.epochDuration.toString(),
    genesisTimestamp: contractConfig.genesisTimestamp.toString(),
    maxChunkCells: contractConfig.maxChunkCells.toString(),
    maxChunksPerMessage: contractConfig.maxChunksPerMessage.toString()
  };
}

function buildClaims(projectRoot: string, evidence: Map<string, string[]>): ProductClaim[] {
  const overviewPath = path.join(projectRoot, "docs/overview.md");
  const mcpPath = path.join(projectRoot, "docs/mcp.md");
  const rewardsPath = path.join(projectRoot, "docs/rewards.md");

  return [
    {
      id: "private-bodies-public-routing",
      headline: "Private message bodies, simple routing",
      detail:
        "Use this when the content matters: message bodies are encrypted while routing metadata stays public enough to query and coordinate.",
      sourcePaths: [overviewPath],
      evidence: evidence.get(overviewPath) ?? [],
      emphasis: "primary"
    },
    {
      id: "agent-ready-integration",
      headline: "Agent-ready integration surface",
      detail:
        "The repo already exposes SDK helpers and an MCP-compatible tool surface for sending messages, reading inboxes, and inspecting rewards.",
      sourcePaths: [mcpPath],
      evidence: evidence.get(mcpPath) ?? [],
      emphasis: "primary"
    },
    {
      id: "reward-epochs",
      headline: "Funded reward epochs for real usage",
      detail:
        "Rewards exist to bootstrap meaningful use: they are funded in native COTI, time-boxed by epoch, and calculated from encrypted cell usage.",
      sourcePaths: [overviewPath, rewardsPath],
      evidence: [...(evidence.get(overviewPath) ?? []), ...(evidence.get(rewardsPath) ?? [])],
      emphasis: "bonus"
    },
    {
      id: "pull-based-ops",
      headline: "Operationally simple reward claims",
      detail:
        "Claims are intentionally pull-based, so agents can inspect pending rewards and claim after an epoch closes without requiring an external keeper.",
      sourcePaths: [rewardsPath],
      evidence: evidence.get(rewardsPath) ?? [],
      emphasis: "secondary"
    }
  ];
}

async function loadLiveSnapshot(config: MoltbookRuntimeConfig): Promise<ProductLiveSnapshot> {
  if (!config.coti) {
    return {};
  }

  const client = buildPrivateMessagingClient(config);
  const walletAddress = String(client.runner.address);
  const currentEpoch = await getCurrentEpoch(client);
  const [contractConfig, pendingRewards] = await Promise.all([
    getContractConfig(client),
    getPendingRewards(client, currentEpoch, walletAddress)
  ]);

  return {
    walletAddress,
    currentEpoch: currentEpoch.toString(),
    contractConfig: serializeContractConfig(contractConfig),
    pendingRewards: pendingRewards.toString()
  };
}

export async function loadProductFacts(
  config: MoltbookRuntimeConfig
): Promise<ProductFactSheet> {
  const evidence = await loadDocEvidence(config.projectRoot);
  const claims = buildClaims(config.projectRoot, evidence);
  const liveSnapshot = await loadLiveSnapshot(config);

  return {
    claims,
    liveSnapshot
  };
}

export function findClaim(factSheet: ProductFactSheet, claimId: string): ProductClaim {
  const claim = factSheet.claims.find((entry) => entry.id === claimId);
  if (!claim) {
    throw new Error(`Unknown product claim: ${claimId}`);
  }

  return claim;
}

