import "dotenv/config";

import http from "node:http";

import { formatEther } from "@coti-io/coti-ethers";

import {
  StarterGrantAttributionStore,
  parseAttributionEventType,
  validateAttributionRefId,
  type StarterGrantAttributionEventInput,
  type StarterGrantOutreachRef
} from "./attribution-store.js";
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
  attributionStore?: StarterGrantAttributionStore;
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

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, `Expected string for "${field}".`);
  }

  return value;
}

function asOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new HttpError(400, `Expected boolean for "${field}".`);
  }
  return value;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `Expected object for "${field}".`);
  }

  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return asRecord(value, field);
}

function parseOptionalMetadata(value: unknown): Record<string, unknown> | undefined {
  const metadata = optionalRecord(value, "metadata");
  if (!metadata) {
    return undefined;
  }

  const entries = Object.entries(metadata).filter(([, entryValue]) => {
    return (
      typeof entryValue === "string" ||
      typeof entryValue === "number" ||
      typeof entryValue === "boolean"
    );
  });
  return Object.fromEntries(entries);
}

function parseOptionalOutreachRef(value: unknown): StarterGrantOutreachRef | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const ref = asRecord(value, "outreachRef");
  const promptParameters = asRecord(ref.promptParameters, "outreachRef.promptParameters");

  return {
    id: validateAttributionRefId(asString(ref.id, "outreachRef.id")),
    venue: asString(ref.venue, "outreachRef.venue"),
    venueAccountId: asOptionalString(ref.venueAccountId, "outreachRef.venueAccountId"),
    surface: asOptionalString(ref.surface, "outreachRef.surface"),
    contentType: asString(ref.contentType, "outreachRef.contentType"),
    campaignId: asString(ref.campaignId, "outreachRef.campaignId"),
    promptProfileId: asString(ref.promptProfileId, "outreachRef.promptProfileId"),
    promptParameters,
    messageStyle: asString(ref.messageStyle, "outreachRef.messageStyle"),
    layout: asString(ref.layout, "outreachRef.layout"),
    ctaStyle: asOptionalString(ref.ctaStyle, "outreachRef.ctaStyle"),
    promotionLevel: asOptionalString(ref.promotionLevel, "outreachRef.promotionLevel"),
    productSpecificity: asOptionalString(ref.productSpecificity, "outreachRef.productSpecificity"),
    rewardEmphasis: asOptionalString(ref.rewardEmphasis, "outreachRef.rewardEmphasis"),
    audience: asOptionalString(ref.audience, "outreachRef.audience"),
    candidateId: asString(ref.candidateId, "outreachRef.candidateId"),
    generatedContentId: asString(ref.generatedContentId, "outreachRef.generatedContentId"),
    remoteContentId: asOptionalString(ref.remoteContentId, "outreachRef.remoteContentId"),
    remoteContentUrl: asOptionalString(ref.remoteContentUrl, "outreachRef.remoteContentUrl"),
    attributionMode: asOptionalString(ref.attributionMode, "outreachRef.attributionMode"),
    publicValueDeliveredFirst: asOptionalBoolean(
      ref.publicValueDeliveredFirst,
      "outreachRef.publicValueDeliveredFirst"
    ),
    privateMessageEscalationReason: asOptionalString(
      ref.privateMessageEscalationReason,
      "outreachRef.privateMessageEscalationReason"
    ),
    utm: optionalRecord(ref.utm, "outreachRef.utm"),
    createdAt: asOptionalString(ref.createdAt, "outreachRef.createdAt")
  };
}

function parseAttributionInput(body: Record<string, unknown>): {
  refId?: string;
  outreachRef?: StarterGrantOutreachRef;
} {
  const explicitRef = asOptionalString(body.ref, "ref");
  const outreachRef = parseOptionalOutreachRef(body.outreachRef);
  const refId = explicitRef ?? outreachRef?.id;

  if (!refId) {
    return { outreachRef };
  }

  const normalizedRefId = validateAttributionRefId(refId);
  if (outreachRef && outreachRef.id !== normalizedRefId) {
    throw new HttpError(400, "ref and outreachRef.id must match.");
  }

  return {
    refId: normalizedRefId,
    outreachRef
  };
}

function buildAttributionEvent(
  body: Record<string, unknown>,
  refId: string
): StarterGrantAttributionEventInput {
  return {
    refId,
    type: parseAttributionEventType(asString(body.type, "type")),
    venue: asOptionalString(body.venue, "venue"),
    walletAddress: asOptionalString(body.walletAddress, "walletAddress"),
    installId: asOptionalString(body.installId, "installId"),
    sessionId: asOptionalString(body.sessionId, "sessionId"),
    skillId: asOptionalString(body.skillId, "skillId"),
    metadata: parseOptionalMetadata(body.metadata)
  };
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

  if (/Expected|JSON|application\/json|Invalid attribution|Unsupported attribution/i.test(message)) {
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
  const attributionStore =
    dependencies.attributionStore ??
    (config.attributionDbPath ? new StarterGrantAttributionStore(config.attributionDbPath) : undefined);
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
      const isAuthorized = authorize(request, config);

      if (request.method === "POST" && url.pathname === "/attribution/event") {
        requireJsonRequest(request);
        const body = await readJsonBody(request, config.maxBodyBytes);
        const attribution = parseAttributionInput(body);
        const refId = attribution.refId ?? validateAttributionRefId(asString(body.ref, "ref"));
        const event = buildAttributionEvent(body, refId);

        if (!attributionStore) {
          writeJsonResponse(response, jsonResponse(503, { error: "Attribution store is not configured." }));
          return;
        }

        const publicAttributionEventTypes = new Set([
          "click",
          "private_message_received",
          "skill_usage"
        ]);

        if (!isAuthorized) {
          if (!publicAttributionEventTypes.has(event.type)) {
            writeJsonResponse(response, jsonResponse(401, { error: "Unauthorized starter grant request." }));
            return;
          }
          if (attribution.outreachRef) {
            writeJsonResponse(response, jsonResponse(401, { error: "Public click events cannot register refs." }));
            return;
          }
          if (!(await attributionStore.hasOutreachRef(refId))) {
            writeJsonResponse(response, jsonResponse(404, { error: "Unknown attribution ref." }));
            return;
          }
          try {
            await assertPublicFunnelWalletAttribution(attributionStore, refId, event);
          } catch (error) {
            if (error instanceof HttpError) {
              writeJsonResponse(response, jsonResponse(error.status, { error: error.message }));
              return;
            }
            throw error;
          }
        } else {
          await persistOutreachRef(attributionStore, attribution.outreachRef, logger);
        }

        await attributionStore.recordEvent(event);
        writeJsonResponse(response, jsonResponse(202, { ok: true, ref: refId, type: event.type }));
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
        const attribution = parseAttributionInput(body);
        const challenge = await issueStarterGrantChallenge(store, {
          walletAddress: asString(body.walletAddress, "walletAddress"),
          installId: asString(body.installId, "installId"),
          requesterKey,
          ttlMs: config.challengeTtlMs,
          maxOutstandingChallengesPerIdentity: config.maxOutstandingChallengesPerIdentity,
          attributionRefId: attribution.refId
        });
        await persistOutreachRef(attributionStore, attribution.outreachRef, logger);
        await recordAttributionEvent(
          attributionStore,
          challenge.attributionRefId
            ? {
                refId: challenge.attributionRefId,
                type: "grant_challenge",
                walletAddress: challenge.walletAddress,
                installId: challenge.installId
              }
            : undefined,
          logger
        );
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
        const attribution = parseAttributionInput(body);
        await persistOutreachRef(attributionStore, attribution.outreachRef, logger);
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
        const claimRefId = claim.attributionRefId ?? attribution.refId;
        if (claimRefId) {
          await recordAttributionEvent(
            attributionStore,
            {
              refId: claimRefId,
              type: "grant_claim_attempted",
              walletAddress: claim.walletAddress,
              installId: claim.installId
            },
            logger
          );
          await recordAttributionEvent(
            attributionStore,
            {
              refId: claimRefId,
              type: claim.status === "claimed" ? "grant_claim_succeeded" : "grant_claim_queued",
              walletAddress: claim.walletAddress,
              installId: claim.installId,
              metadata: claim.transactionHash ? { transactionHash: claim.transactionHash } : undefined
            },
            logger
          );
          if (claim.status === "claimed" && attributionStore) {
            await attributionStore
              .upsertWalletAttribution({
                walletAddress: claim.walletAddress,
                refId: claimRefId
              })
              .catch((error) => {
                logger?.error?.("wallet attribution index update failed", error);
              });
          }
        }
        writeJsonResponse(
          response,
          jsonResponse(claim.status === "claimed" ? 200 : 202, claim)
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/attribution/ref") {
        if (!isAuthorized) {
          writeJsonResponse(response, jsonResponse(401, { error: "Unauthorized starter grant request." }));
          return;
        }
        requireJsonRequest(request);
        const body = await readJsonBody(request, config.maxBodyBytes);
        const outreachRef = parseOptionalOutreachRef(body.outreachRef);
        if (!attributionStore) {
          writeJsonResponse(response, jsonResponse(503, { error: "Attribution store is not configured." }));
          return;
        }
        if (!outreachRef) {
          writeJsonResponse(response, jsonResponse(400, { error: 'Expected "outreachRef" object.' }));
          return;
        }
        await attributionStore.upsertOutreachRef(outreachRef);
        writeJsonResponse(response, jsonResponse(201, { ok: true, ref: outreachRef.id }));
        return;
      }

      if (request.method === "GET" && url.pathname === "/attribution/summary") {
        if (!isAuthorized) {
          writeJsonResponse(response, jsonResponse(401, { error: "Unauthorized starter grant request." }));
          return;
        }
        if (!attributionStore) {
          writeJsonResponse(
            response,
            jsonResponse(200, { generatedAt: new Date().toISOString(), groups: [] })
          );
          return;
        }
        const campaignId = url.searchParams.get("campaignId") ?? undefined;
        writeJsonResponse(response, jsonResponse(200, await attributionStore.summarize({ campaignId })));
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

async function assertPublicFunnelWalletAttribution(
  attributionStore: StarterGrantAttributionStore,
  refId: string,
  event: StarterGrantAttributionEventInput
): Promise<void> {
  if (event.type !== "private_message_received" && event.type !== "skill_usage") {
    return;
  }

  const walletAddress = event.walletAddress?.trim();
  if (!walletAddress) {
    throw new HttpError(400, "walletAddress is required for SDK attribution events.");
  }

  const mappedRef = await attributionStore.lookupRefForWallet(walletAddress);
  if (!mappedRef) {
    throw new HttpError(
      403,
      "Wallet is not attributed to this outreach ref. Claim the starter grant with --ref first."
    );
  }

  if (mappedRef !== refId) {
    throw new HttpError(403, "Wallet is attributed to a different outreach ref.");
  }
}

async function persistOutreachRef(
  attributionStore: StarterGrantAttributionStore | undefined,
  outreachRef: StarterGrantOutreachRef | undefined,
  logger: Pick<typeof console, "error">
): Promise<void> {
  if (!attributionStore || !outreachRef) {
    return;
  }
  try {
    await attributionStore.upsertOutreachRef(outreachRef);
  } catch (error) {
    logger.error("Failed to persist outreach attribution ref", error);
  }
}

async function recordAttributionEvent(
  attributionStore: StarterGrantAttributionStore | undefined,
  event: StarterGrantAttributionEventInput | undefined,
  logger: Pick<typeof console, "error">
): Promise<void> {
  if (!attributionStore || !event) {
    return;
  }
  try {
    await attributionStore.recordEvent(event);
  } catch (error) {
    logger.error("Failed to persist attribution event", error);
  }
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
