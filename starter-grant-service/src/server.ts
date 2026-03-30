import "dotenv/config";

import http from "node:http";

import { formatEther } from "@coti-io/coti-ethers";

import {
  claimStarterGrant,
  consumeStarterGrantRateLimit,
  getStarterGrantFundingSnapshot,
  getStarterGrantStatus,
  issueStarterGrantChallenge,
  requestKeyFromIp
} from "./claims.js";
import { resolveStarterGrantServiceConfig } from "./config.js";
import { CotiStarterGrantFunder } from "./funder.js";
import { SerialStarterGrantPayoutQueue } from "./payout-queue.js";
import { StarterGrantFileStore } from "./storage.js";
import type {
  StarterGrantFunder,
  StarterGrantFundingAvailability,
  StarterGrantFundingSnapshot,
  StarterGrantPayoutQueue,
  StarterGrantServiceConfig,
  StarterGrantStore
} from "./types.js";

interface JsonResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function jsonResponse(status: number, body: unknown): JsonResponse {
  return { status, body };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers?: Record<string, string>
  ) {
    super(message);
  }
}

export interface StartStarterGrantServiceDependencies {
  store?: StarterGrantStore;
  funder?: StarterGrantFunder;
  payoutQueue?: StarterGrantPayoutQueue;
  logger?: Pick<typeof console, "log" | "error">;
}

async function readJsonBody(
  request: http.IncomingMessage,
  maxBodyBytes: number
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBodyBytes) {
      throw new HttpError(413, "Starter grant request body is too large.");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Starter grant request body must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Expected a JSON object request body.");
  }

  return parsed as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, `Expected non-empty string for "${field}".`);
  }

  return value;
}

function resolveRequesterIp(
  request: http.IncomingMessage,
  config: StarterGrantServiceConfig
): string | undefined {
  if (!config.trustProxy) {
    return request.socket.remoteAddress ?? undefined;
  }

  const forwardedFor = request.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0]?.trim();
  }

  return request.socket.remoteAddress ?? undefined;
}

function requireJsonRequest(request: http.IncomingMessage): void {
  const contentType = request.headers["content-type"];
  if (!contentType || !contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Starter grant routes require application/json.");
  }
}

function authorize(request: http.IncomingMessage, config: StarterGrantServiceConfig): boolean {
  if (!config.authToken) {
    return true;
  }

  return request.headers.authorization === `Bearer ${config.authToken}`;
}

function mapUnhandledError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/already claimed|pending funding|too many outstanding|no longer claimable|has expired|does not match|incorrect/i.test(message)) {
    return new HttpError(409, message);
  }

  if (/temporarily locked/i.test(message)) {
    return new HttpError(429, message);
  }

  if (/insufficient native balance|gas price is unavailable|provider is not configured/i.test(message)) {
    return new HttpError(503, message);
  }

  if (/Expected|JSON|application\/json/i.test(message)) {
    return new HttpError(400, message);
  }

  console.error("starter grant service error", error);
  return new HttpError(500, "Internal starter grant service error.");
}

function estimateClaimsRemaining(availability: StarterGrantFundingAvailability): number {
  const availableBalanceWei = BigInt(availability.availableBalanceWei);
  const requiredBalanceWei = BigInt(availability.requiredBalanceWei);
  if (requiredBalanceWei <= 0n || availableBalanceWei <= 0n) {
    return 0;
  }

  return Number(availableBalanceWei / requiredBalanceWei);
}

function toNativeAmount(wei: string): string {
  return formatEther(BigInt(wei));
}

function buildFundingHealthBody(snapshot: StarterGrantFundingSnapshot) {
  const { availability, pendingFundingClaimsCount } = snapshot;
  return {
    status: availability.hasSufficientBalance ? "ok" : "degraded",
    funderAvailable: availability.hasSufficientBalance,
    reason: availability.hasSufficientBalance ? undefined : "insufficient_funder_balance",
    funding: {
      ...availability,
      pendingFundingClaimsCount,
      estimatedClaimsRemaining: estimateClaimsRemaining(availability),
      onChainBalanceNative: toNativeAmount(availability.onChainBalanceWei),
      reservedPendingAmountNative: toNativeAmount(availability.reservedPendingAmountWei),
      availableBalanceNative: toNativeAmount(availability.availableBalanceWei),
      estimatedGasCostNative: toNativeAmount(availability.estimatedGasCostWei),
      requiredBalanceNative: toNativeAmount(availability.requiredBalanceWei)
    }
  };
}

export async function startStarterGrantService(
  config = resolveStarterGrantServiceConfig(),
  dependencies: StartStarterGrantServiceDependencies = {}
) {
  const logger = dependencies.logger ?? console;
  const store = dependencies.store ?? new StarterGrantFileStore(config.statePath);
  const funder =
    dependencies.funder ??
    new CotiStarterGrantFunder({
      funderPrivateKey: config.funderPrivateKey,
      network: config.network,
      rpcUrl: config.rpcUrl,
      confirmTimeoutMs: config.fundingConfirmTimeoutMs
    });
  const payoutQueue =
    dependencies.payoutQueue ?? new SerialStarterGrantPayoutQueue(store, funder);

  const server = http.createServer(async (request, response) => {
    try {
      if (!request.url || !request.method) {
        throw new HttpError(400, "Request was missing a URL or method.");
      }

      const url = new URL(request.url, `http://${config.host}:${config.port}`);

      if (request.method === "GET" && url.pathname === config.healthRoute) {
        const fundingSnapshot = await getStarterGrantFundingSnapshot(
          store,
          payoutQueue,
          config.starterAmountWei
        );
        writeJsonResponse(response, {
          status: fundingSnapshot.availability.hasSufficientBalance ? 200 : 503,
          body: buildFundingHealthBody(fundingSnapshot)
        });
        return;
      }

      const requesterKey = requestKeyFromIp(resolveRequesterIp(request, config));

      if (!authorize(request, config)) {
        writeJsonResponse(response, jsonResponse(401, { error: "Unauthorized starter grant request." }));
        return;
      }

      if (request.method === "POST" && url.pathname === config.challengeRoute) {
        requireJsonRequest(request);
        const rateLimit = await consumeStarterGrantRateLimit(store, {
          bucket: "challenge",
          requesterKey,
          maxRequests: config.challengeMaxRequestsPerWindow,
          windowMs: config.rateLimitWindowMs
        });
        if (!rateLimit.allowed) {
          writeJsonResponse(
            response,
            {
              status: 429,
              body: { error: "Starter grant challenge rate limit exceeded." },
              headers: { "Retry-After": String(Math.ceil(rateLimit.retryAfterMs / 1000)) }
            }
          );
          return;
        }
        const body = await readJsonBody(request, config.maxBodyBytes);
        const challenge = await issueStarterGrantChallenge(store, {
          walletAddress: asString(body.walletAddress, "walletAddress"),
          installId: asString(body.installId, "installId"),
          requesterKey,
          ttlMs: config.challengeTtlMs,
          maxOutstandingChallengesPerIdentity: config.maxOutstandingChallengesPerIdentity
        });
        writeJsonResponse(response, jsonResponse(200, challenge));
        return;
      }

      if (request.method === "POST" && url.pathname === config.statusRoute) {
        requireJsonRequest(request);
        const rateLimit = await consumeStarterGrantRateLimit(store, {
          bucket: "status",
          requesterKey,
          maxRequests: config.statusMaxRequestsPerWindow,
          windowMs: config.rateLimitWindowMs
        });
        if (!rateLimit.allowed) {
          writeJsonResponse(
            response,
            {
              status: 429,
              body: { error: "Starter grant status rate limit exceeded." },
              headers: { "Retry-After": String(Math.ceil(rateLimit.retryAfterMs / 1000)) }
            }
          );
          return;
        }
        const body = await readJsonBody(request, config.maxBodyBytes);
        const status = await getStarterGrantStatus(store, {
          walletAddress: asString(body.walletAddress, "walletAddress"),
          installId: asString(body.installId, "installId")
        });
        writeJsonResponse(response, jsonResponse(200, status));
        return;
      }

      if (request.method === "POST" && url.pathname === config.claimRoute) {
        requireJsonRequest(request);
        const rateLimit = await consumeStarterGrantRateLimit(store, {
          bucket: "claim",
          requesterKey,
          maxRequests: config.claimMaxRequestsPerWindow,
          windowMs: config.rateLimitWindowMs
        });
        if (!rateLimit.allowed) {
          writeJsonResponse(
            response,
            {
              status: 429,
              body: { error: "Starter grant claim rate limit exceeded." },
              headers: { "Retry-After": String(Math.ceil(rateLimit.retryAfterMs / 1000)) }
            }
          );
          return;
        }
        const body = await readJsonBody(request, config.maxBodyBytes);
        const claim = await claimStarterGrant(store, payoutQueue, {
          challengeId: asString(body.challengeId, "challengeId"),
          walletAddress: asString(body.walletAddress, "walletAddress"),
          installId: asString(body.installId, "installId"),
          challengeAnswer: asString(body.challengeAnswer, "challengeAnswer"),
          claimPayload: asString(body.claimPayload, "claimPayload"),
          signature: asString(body.signature, "signature"),
          amountWei: config.starterAmountWei,
          requesterKey,
          rejectedClaimsPerWindow: config.rejectedClaimsPerWindow,
          rejectedClaimWindowMs: config.rejectedClaimWindowMs
        });
        writeJsonResponse(
          response,
          jsonResponse(claim.status === "claimed" ? 200 : 202, claim)
        );
        return;
      }

      writeJsonResponse(response, jsonResponse(404, { error: "Starter grant route not found." }));
    } catch (error) {
      const httpError = mapUnhandledError(error);
      writeJsonResponse(response, {
        status: httpError.status,
        body: { error: httpError.message },
        headers: httpError.headers
      });
    }
  });
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = config.headersTimeoutMs;
  server.keepAliveTimeout = config.keepAliveTimeoutMs;
  server.timeout = config.requestTimeoutMs;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    config,
    getFundingSnapshot: () =>
      getStarterGrantFundingSnapshot(store, payoutQueue, config.starterAmountWei),
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
}

function writeJsonResponse(response: http.ServerResponse, result: JsonResponse): void {
  response.statusCode = result.status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(result.headers ?? {})) {
    response.setHeader(name, value);
  }
  response.end(JSON.stringify(result.body));
}

const isDirectExecution = process.argv[1]?.endsWith("/server.js");

if (isDirectExecution) {
  startStarterGrantService()
    .then(async ({ config, getFundingSnapshot }) => {
      console.log(
        `Starter grant service listening on http://${config.host}:${config.port}${config.challengeRoute}`
      );
      try {
        const snapshot = await getFundingSnapshot();
        const availability = snapshot.availability;
        console.log(
          `Starter grant funder ${availability.funderAddress} has ${toNativeAmount(
            availability.onChainBalanceWei
          )} COTI on-chain, ${toNativeAmount(
            availability.availableBalanceWei
          )} COTI available after reserving ${toNativeAmount(
            availability.reservedPendingAmountWei
          )} COTI across ${snapshot.pendingFundingClaimsCount} pending claims, and can cover approximately ${estimateClaimsRemaining(
            availability
          )} more claims at ${toNativeAmount(availability.requiredBalanceWei)} COTI each`
        );
      } catch (error) {
        console.error("Failed to compute starter grant funding availability", error);
      }
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
