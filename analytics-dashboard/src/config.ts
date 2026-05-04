import dotenv from "dotenv";
import path from "node:path";

import { resolveMessageStatsRpcUrl, type CotiNetworkName } from "../../contracts/src/message-stats";
import type { AnalyticsConfig } from "./types";

dotenv.config({
  path: path.resolve(__dirname, "..", "..", ".env")
});

dotenv.config({
  path: path.resolve(__dirname, "..", ".env"),
  override: true
});

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : fallback;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parsePositiveMs(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadAnalyticsConfig(env: NodeJS.ProcessEnv = process.env): AnalyticsConfig {
  const cotiNetwork: CotiNetworkName =
    (env.COTI_NETWORK ?? "testnet").toLowerCase() === "mainnet" ? "mainnet" : "testnet";

  return {
    agentRoot:
      env.MOLTBOOK_ANALYTICS_AGENT_ROOT ??
      path.resolve(process.cwd(), "moltbook-outreach-agent", ".data", "agents"),
    host: env.MOLTBOOK_ANALYTICS_HOST ?? "127.0.0.1",
    port: parsePort(env.MOLTBOOK_ANALYTICS_PORT, 8788),
    cotiNetwork,
    cotiRpcUrl: resolveMessageStatsRpcUrl(cotiNetwork, env),
    contractAddress: env.CONTRACT_ADDRESS,
    contractDeployBlock: parsePositiveInt(env.CONTRACT_DEPLOY_BLOCK),
    cotiBlockscoutApiUrl: env.COTI_BLOCKSCOUT_API_URL,
    cotiCacheTtlMs: parsePositiveMs(env.MOLTBOOK_ANALYTICS_COTI_CACHE_TTL_MS, 60_000)
  };
}
