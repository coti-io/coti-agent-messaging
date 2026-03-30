import "dotenv/config";

import path from "node:path";
import { fileURLToPath } from "node:url";

import type { StarterGrantServiceConfig } from "./types.js";

function getPackageRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "..", "..");
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function parseNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveStarterGrantServiceConfig(): StarterGrantServiceConfig {
  const packageRoot = getPackageRoot();
  return {
    host: process.env.STARTER_GRANT_SERVICE_HOST ?? "127.0.0.1",
    port: parseNumber(process.env.STARTER_GRANT_SERVICE_PORT, 8787),
    challengeRoute: process.env.STARTER_GRANT_SERVICE_CHALLENGE_ROUTE ?? "/challenge",
    claimRoute: process.env.STARTER_GRANT_SERVICE_CLAIM_ROUTE ?? "/claim",
    statusRoute: process.env.STARTER_GRANT_SERVICE_STATUS_ROUTE ?? "/status",
    healthRoute: process.env.STARTER_GRANT_SERVICE_HEALTH_ROUTE ?? "/health",
    statePath:
      process.env.STARTER_GRANT_SERVICE_STATE_PATH ??
      path.join(packageRoot, ".data", "starter-grants.json"),
    authToken: getOptionalEnv("STARTER_GRANT_SERVICE_AUTH_TOKEN"),
    trustProxy: parseBoolean(process.env.STARTER_GRANT_SERVICE_TRUST_PROXY, false),
    maxBodyBytes: parseNumber(process.env.STARTER_GRANT_SERVICE_MAX_BODY_BYTES, 16 * 1024),
    requestTimeoutMs: parseNumber(process.env.STARTER_GRANT_SERVICE_REQUEST_TIMEOUT_MS, 15_000),
    headersTimeoutMs: parseNumber(process.env.STARTER_GRANT_SERVICE_HEADERS_TIMEOUT_MS, 10_000),
    keepAliveTimeoutMs: parseNumber(process.env.STARTER_GRANT_SERVICE_KEEP_ALIVE_TIMEOUT_MS, 5_000),
    challengeTtlMs: parseNumber(process.env.STARTER_GRANT_CHALLENGE_TTL_MS, 5 * 60 * 1000),
    starterAmountWei: BigInt(process.env.STARTER_GRANT_AMOUNT_WEI ?? "1000000000000000"),
    challengeMaxRequestsPerWindow: parseNumber(
      process.env.STARTER_GRANT_CHALLENGE_MAX_REQUESTS_PER_WINDOW,
      parseNumber(process.env.STARTER_GRANT_MAX_REQUESTS_PER_WINDOW, 8)
    ),
    statusMaxRequestsPerWindow: parseNumber(
      process.env.STARTER_GRANT_STATUS_MAX_REQUESTS_PER_WINDOW,
      parseNumber(process.env.STARTER_GRANT_MAX_REQUESTS_PER_WINDOW, 8)
    ),
    claimMaxRequestsPerWindow: parseNumber(
      process.env.STARTER_GRANT_CLAIM_MAX_REQUESTS_PER_WINDOW,
      Math.max(1, Math.floor(parseNumber(process.env.STARTER_GRANT_MAX_REQUESTS_PER_WINDOW, 8) / 2))
    ),
    rateLimitWindowMs: parseNumber(process.env.STARTER_GRANT_RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000),
    maxOutstandingChallengesPerIdentity: parseNumber(
      process.env.STARTER_GRANT_MAX_OUTSTANDING_CHALLENGES_PER_IDENTITY,
      3
    ),
    rejectedClaimsPerWindow: parseNumber(process.env.STARTER_GRANT_REJECTED_CLAIMS_PER_WINDOW, 3),
    rejectedClaimWindowMs: parseNumber(process.env.STARTER_GRANT_REJECTED_CLAIM_WINDOW_MS, 15 * 60 * 1000),
    fundingConfirmTimeoutMs: parseNumber(
      process.env.STARTER_GRANT_FUNDING_CONFIRM_TIMEOUT_MS,
      45_000
    ),
    network:
      (process.env.COTI_NETWORK ?? "testnet").toLowerCase() === "mainnet" ? "mainnet" : "testnet",
    rpcUrl: getOptionalEnv("STARTER_GRANT_RPC_URL") ?? getOptionalEnv("COTI_RPC_URL"),
    funderPrivateKey: getRequiredEnv("STARTER_GRANT_FUNDER_PRIVATE_KEY")
  };
}
