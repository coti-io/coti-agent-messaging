import dotenv from "dotenv";
import { ethers } from "ethers";
import path from "node:path";

import {
  collectMessageStats,
  formatNumber,
  formatTimestamp,
  resolveMessageStatsRpcUrl,
  type CotiNetworkName
} from "../src/message-stats";

dotenv.config({
  path: path.resolve(__dirname, "..", "..", ".env")
});

dotenv.config({
  path: path.resolve(__dirname, "..", ".env"),
  override: true
});

type CliOptions = {
  networkName: CotiNetworkName;
  contractAddress: string;
  fromBlock?: number;
  toBlock?: number;
  batchSize: number;
  top: number;
  epoch?: bigint;
  json: boolean;
  skipUsage: boolean;
  contractDeployBlock?: number;
};

const DEFAULT_BATCH_SIZE = 10_000;
const DEFAULT_TOP = 10;

function usage() {
  console.log(`Usage:
  npx ts-node --project tsconfig.json scripts/message-stats.ts [options]

Options:
  --network <mainnet|testnet>  Network to query. Defaults from COTI_NETWORK or testnet.
  --contract <address>   Contract address. Defaults to CONTRACT_ADDRESS.
  --from-block <number>  Start block, inclusive. Defaults to CONTRACT_DEPLOY_BLOCK,
                         archive-detected deployment block, or earliest contract log.
  --to-block <number>    End block, inclusive. Defaults to latest.
  --batch-size <number>  Log scan batch size. Defaults to ${DEFAULT_BATCH_SIZE}.
  --epoch <number>       Limit results to one epoch.
  --top <number>         Show top N agents/routes. Defaults to ${DEFAULT_TOP}.
  --json                 Emit JSON instead of the text report.
  --skip-usage           Skip ciphertext-cell lookups for a faster count-only run.
  --help                 Show this help.

Notes:
  - Plaintext byte length is not observable on-chain because bodies are encrypted.
  - The script reports chunk counts and usage units as the closest size proxies.
  - Messages per agent are reported as sent, received, and total participation.`);
}

function parsePositiveInt(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return value;
}

function parseOptionalPositiveInt(raw: string | undefined, name: string): number | undefined {
  if (!raw) {
    return undefined;
  }

  return parsePositiveInt(raw, name);
}

function parseArgs(argv: readonly string[]): CliOptions {
  let networkName: CotiNetworkName =
    (process.env.COTI_NETWORK ?? "testnet").toLowerCase() === "mainnet"
      ? "mainnet"
      : "testnet";
  let contractAddress = process.env.CONTRACT_ADDRESS;
  let fromBlock: number | undefined;
  let toBlock: number | undefined;
  let batchSize = DEFAULT_BATCH_SIZE;
  let top = DEFAULT_TOP;
  let epoch: bigint | undefined;
  let json = false;
  let skipUsage = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--network": {
        const value = (argv[++i] ?? "").toLowerCase();
        if (value !== "mainnet" && value !== "testnet") {
          throw new Error("--network must be mainnet or testnet.");
        }
        networkName = value;
        break;
      }
      case "--contract":
        contractAddress = argv[++i];
        break;
      case "--from-block":
        fromBlock = parsePositiveInt(argv[++i] ?? "", "--from-block");
        break;
      case "--to-block":
        toBlock = parsePositiveInt(argv[++i] ?? "", "--to-block");
        break;
      case "--batch-size":
        batchSize = parsePositiveInt(argv[++i] ?? "", "--batch-size");
        break;
      case "--top":
        top = parsePositiveInt(argv[++i] ?? "", "--top");
        break;
      case "--epoch":
        epoch = BigInt(argv[++i] ?? "");
        break;
      case "--json":
        json = true;
        break;
      case "--skip-usage":
        skipUsage = true;
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!contractAddress) {
    throw new Error("Missing contract address. Pass --contract or set CONTRACT_ADDRESS.");
  }

  if (batchSize <= 0) {
    throw new Error("--batch-size must be greater than zero.");
  }

  if (top <= 0) {
    throw new Error("--top must be greater than zero.");
  }

  if (fromBlock !== undefined && toBlock !== undefined && fromBlock > toBlock) {
    throw new Error("--from-block cannot be greater than --to-block.");
  }

  return {
    networkName,
    contractAddress: ethers.getAddress(contractAddress),
    fromBlock,
    toBlock,
    batchSize,
    top,
    epoch,
    json,
    skipUsage,
    contractDeployBlock: parseOptionalPositiveInt(
      process.env.CONTRACT_DEPLOY_BLOCK,
      "CONTRACT_DEPLOY_BLOCK"
    )
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await collectMessageStats({
    ...options,
    rpcUrl: resolveMessageStatsRpcUrl(options.networkName),
    blockscoutApiUrl: process.env.COTI_BLOCKSCOUT_API_URL,
    log: (message) => console.error(message)
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ...report,
          coverage: {
            firstMessageAt: report.coverage.firstMessageAt,
            firstMessageAtIso: formatTimestamp(report.coverage.firstMessageAt),
            lastMessageAt: report.coverage.lastMessageAt,
            lastMessageAtIso: formatTimestamp(report.coverage.lastMessageAt)
          }
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Network: ${report.network}`);
  console.log(`Contract: ${report.contractAddress}`);
  console.log(
    `Scan range: ${report.scan.fromBlock} -> ${report.scan.toBlock} (latest ${report.scan.latestBlock}, from ${report.scan.fromBlockSource})`
  );
  console.log(`Epoch filter: ${report.scan.epochFilter ?? "all"}`);
  console.log(`Messages: ${report.totals.messages}`);
  console.log(`Unique agents: ${report.totals.uniqueAgents}`);
  console.log(`Unique senders: ${report.totals.uniqueSenders}`);
  console.log(`Unique recipients: ${report.totals.uniqueRecipients}`);
  console.log(`Unique routes: ${report.totals.uniqueRoutes}`);
  console.log(`Total chunks: ${report.totals.totalChunks}`);
  console.log(
    `Multipart messages: ${report.totals.multipartMessages} (${formatNumber(
      report.totals.multipartRate * 100
    )}%)`
  );
  console.log(`First message: ${formatTimestamp(report.coverage.firstMessageAt)}`);
  console.log(`Last message: ${formatTimestamp(report.coverage.lastMessageAt)}`);
  console.log("");
  console.log("Averages");
  console.log(`  messages per sender: ${formatNumber(report.averages.messagesPerSender)}`);
  console.log(`  messages per recipient: ${formatNumber(report.averages.messagesPerRecipient)}`);
  console.log(`  messages per active agent: ${formatNumber(report.averages.messagesPerActiveAgent)}`);
  console.log(`  chunks per message: ${formatNumber(report.averages.chunksPerMessage)}`);
  if (options.skipUsage) {
    console.log("  usage units per message: skipped");
    console.log("  usage units per chunk: skipped");
  } else {
    console.log(
      `  usage units per message: ${formatNumber(report.averages.usageUnitsPerMessage)}`
    );
    console.log(`  usage units per chunk: ${formatNumber(report.averages.usageUnitsPerChunk)}`);
  }
  console.log("");
  console.log("Distribution");
  console.log(
    `  chunk count: min ${report.distributions.chunkCount.min}, median ${report.distributions.chunkCount.median}, p95 ${report.distributions.chunkCount.p95}, max ${report.distributions.chunkCount.max}`
  );
  if (options.skipUsage) {
    console.log("  usage units: skipped");
  } else {
    console.log(
      `  usage units: min ${report.distributions.usageUnits.min}, median ${report.distributions.usageUnits.median}, p95 ${report.distributions.usageUnits.p95}, max ${report.distributions.usageUnits.max}`
    );
  }
  console.log("");
  console.log(`Top ${Math.min(options.top, report.topAgents.length)} agents`);
  for (const agent of report.topAgents) {
    console.log(
      `  ${agent.address} | sent ${agent.sent} | received ${agent.received} | total ${agent.total} | multipart sent ${agent.multipartSent}${
        options.skipUsage ? "" : ` | usage units sent ${agent.usageUnitsSent}`
      }`
    );
  }
  console.log("");
  console.log(`Top ${Math.min(options.top, report.topRoutes.length)} routes`);
  for (const route of report.topRoutes) {
    console.log(`  ${route.from} -> ${route.to} | messages ${route.messages}`);
  }
  console.log("");
  console.log("Per-epoch message counts");
  for (const epochRow of report.perEpoch) {
    console.log(`  epoch ${epochRow.epoch}: ${epochRow.messages}`);
  }
  console.log("");
  console.log(
    "Size note: exact plaintext bytes are not available on-chain. Chunk counts and usage units are the usable public size proxies."
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
