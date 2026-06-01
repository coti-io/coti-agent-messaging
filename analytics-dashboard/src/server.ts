import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { collectMessageStats, type MessageStatsReport } from "../../contracts/src/message-stats";
import { loadAnalyticsConfig } from "./config";
import { discoverAgents, readDeployMetadata } from "./discovery";
import { aggregateEngagementSummaries } from "./engagements";
import { buildManualOutreachRef, buildTrackedCtaUrl, type ManualRefBuilderInput } from "./manual-cta";
import { readAttributionSummary } from "./storage";
import type { AnalyticsConfig } from "./types";

type CachedCotiStats = {
  createdAt: number;
  value?: MessageStatsReport;
  error?: string;
};

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const config = loadAnalyticsConfig();
let cotiCache: CachedCotiStats | undefined;
let cotiRefreshPromise: Promise<void> | undefined;

function packageRoot(): string {
  return path.resolve(__dirname, "..");
}

function publicDir(): string {
  return path.join(packageRoot(), "public");
}

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body, null, 2));
}

function textResponse(response: http.ServerResponse, statusCode: number, body: string) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8"
  });
  response.end(body);
}

function badRequest(message: string): never {
  throw new RequestError(400, message);
}

async function readJsonBody(request: http.IncomingMessage, maxBodyBytes = 32 * 1024) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBodyBytes) {
      badRequest("Request body is too large.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {} as Record<string, unknown>;
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    badRequest("Request body must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    badRequest("Expected a JSON object request body.");
  }
  return body as Record<string, unknown>;
}

function requireJsonRequest(request: http.IncomingMessage): void {
  const contentType = request.headers["content-type"];
  if (!contentType || !contentType.toLowerCase().startsWith("application/json")) {
    badRequest("Manual CTA routes require application/json.");
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    badRequest(`Expected non-empty string for "${field}".`);
  }
  return value.trim();
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    badRequest(`Expected string for "${field}".`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    badRequest(`Expected boolean for "${field}".`);
  }
  return value;
}

function parseManualRefBuilderInput(body: Record<string, unknown>): ManualRefBuilderInput {
  return {
    venue: requireString(body, "venue"),
    surface: optionalString(body, "surface"),
    contentType: requireString(body, "contentType"),
    campaignId: requireString(body, "campaignId"),
    promptProfileId: requireString(body, "promptProfileId"),
    messageStyle: requireString(body, "messageStyle"),
    layout: requireString(body, "layout"),
    ctaStyle: optionalString(body, "ctaStyle"),
    promotionLevel: optionalString(body, "promotionLevel"),
    productSpecificity: optionalString(body, "productSpecificity"),
    rewardEmphasis: optionalString(body, "rewardEmphasis"),
    audience: optionalString(body, "audience"),
    label: optionalString(body, "label"),
    utmMedium: optionalString(body, "utmMedium"),
    attributionMode: optionalString(body, "attributionMode") as ManualRefBuilderInput["attributionMode"],
    publicValueDeliveredFirst: optionalBoolean(body, "publicValueDeliveredFirst"),
    privateMessageEscalationReason: optionalString(body, "privateMessageEscalationReason")
  };
}

function joinServiceUrl(baseUrl: string, relativePath: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(relativePath.replace(/^\/+/, ""), normalizedBase).toString();
}

async function createManualAttributionRef(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  configInput: AnalyticsConfig
) {
  if (!configInput.starterGrantServiceUrl) {
    jsonResponse(response, 503, { error: "STARTER_GRANT_SERVICE_URL is not configured." });
    return;
  }
  if (!configInput.trackingBaseUrl) {
    jsonResponse(response, 503, { error: "OUTREACH_TRACKING_BASE_URL is not configured." });
    return;
  }
  if (!configInput.starterGrantServiceAuthToken) {
    jsonResponse(response, 503, { error: "STARTER_GRANT_SERVICE_AUTH_TOKEN is required for CTA creation." });
    return;
  }

  requireJsonRequest(request);
  const body = await readJsonBody(request);
  const outreachRef = buildManualOutreachRef(parseManualRefBuilderInput(body));
  const upstreamUrl = joinServiceUrl(configInput.starterGrantServiceUrl, "/attribution/ref");
  const upstreamResponse = await fetch(upstreamUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${configInput.starterGrantServiceAuthToken}`
    },
    body: JSON.stringify({ outreachRef })
  });
  const upstreamText = await upstreamResponse.text();
  let upstreamBody: unknown;
  if (upstreamText) {
    try {
      upstreamBody = JSON.parse(upstreamText);
    } catch {
      upstreamBody = undefined;
    }
  }

  if (!upstreamResponse.ok) {
    jsonResponse(response, upstreamResponse.status, {
      error:
        (upstreamBody &&
          typeof upstreamBody === "object" &&
          upstreamBody &&
          "error" in upstreamBody &&
          typeof upstreamBody.error === "string" &&
          upstreamBody.error) ||
        "Failed to persist manual attribution ref."
    });
    return;
  }

  jsonResponse(response, 201, {
    ok: true,
    ref: outreachRef.id,
    trackedUrl: buildTrackedCtaUrl(configInput.trackingBaseUrl, outreachRef),
    outreachRef
  });
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".svg")) {
    return "image/svg+xml";
  }
  return "application/octet-stream";
}

async function staticResponse(response: http.ServerResponse, requestPath: string) {
  const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const resolvedPath = path.resolve(publicDir(), relativePath);
  if (!resolvedPath.startsWith(publicDir())) {
    textResponse(response, 403, "Forbidden");
    return;
  }

  try {
    const body = await readFile(resolvedPath);
    response.writeHead(200, {
      "content-type": contentType(resolvedPath),
      "cache-control": "public, max-age=60"
    });
    response.end(body);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      textResponse(response, 404, "Not found");
      return;
    }
    throw error;
  }
}

function publicAgent(agent: Awaited<ReturnType<typeof discoverAgents>>[number]) {
  return {
    agentId: agent.metadata.agentId,
    displayName: agent.metadata.displayName,
    description: agent.metadata.description,
    serviceName: agent.metadata.serviceName,
    profileUrl: agent.metadata.profileUrl,
    walletAddress: agent.metadata.walletAddress,
    statePresent: agent.statePresent,
    reportPresent: agent.reportPresent,
    stateError: agent.stateError,
    reportError: agent.reportError,
    engagementSummary: agent.engagementSummary,
    lastHeartbeatAt: agent.lastHeartbeatAt,
    lastSuccessfulHeartbeatAt: agent.lastSuccessfulHeartbeatAt,
    lastPostAt: agent.lastPostAt,
    lastCommentAt: agent.lastCommentAt,
    pendingWrites: agent.pendingWrites,
    schedulerHealth: agent.schedulerHealth,
    latestStartedAt: agent.latestStartedAt,
    latestFinishedAt: agent.latestFinishedAt,
    latestStatus: agent.latestStatus,
    latestErrors: agent.latestErrors,
    latestSkipped: agent.latestSkipped,
    currentPrompt: agent.currentPrompt,
    recentPublished: agent.recentPublished ?? [],
    recentRuns: agent.recentRuns ?? []
  };
}

async function refreshCotiStats(configInput: AnalyticsConfig): Promise<void> {
  const now = Date.now();
  if (!configInput.contractAddress) {
    cotiCache = {
      createdAt: now,
      error: "CONTRACT_ADDRESS is not configured."
    };
    return;
  }

  try {
    const value = await collectMessageStats({
      networkName: configInput.cotiNetwork,
      contractAddress: configInput.contractAddress,
      rpcUrl: configInput.cotiRpcUrl,
      contractDeployBlock: configInput.contractDeployBlock,
      blockscoutApiUrl: configInput.cotiBlockscoutApiUrl,
      batchSize: 10_000,
      top: 10
    });
    cotiCache = { createdAt: now, value };
  } catch (error) {
    cotiCache = {
      createdAt: now,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function ensureCotiRefresh(configInput: AnalyticsConfig): void {
  if (cotiRefreshPromise) {
    return;
  }

  cotiRefreshPromise = refreshCotiStats(configInput).finally(() => {
    cotiRefreshPromise = undefined;
  });
}

async function getCotiStats(configInput: AnalyticsConfig): Promise<CachedCotiStats> {
  const now = Date.now();
  if (cotiCache && now - cotiCache.createdAt < configInput.cotiCacheTtlMs) {
    return cotiCache;
  }

  ensureCotiRefresh(configInput);

  if (cotiCache) {
    return cotiCache;
  }

  return {
    createdAt: now,
    error: "COTI stats are still loading."
  };
}

async function summaryPayload(configInput: AnalyticsConfig) {
  const agents = await discoverAgents(configInput.agentRoot);
  const publicAgents = agents.map(publicAgent);
  const engagementSummary = aggregateEngagementSummaries(
    publicAgents.map((agent) => agent.engagementSummary)
  );
  const coti = await getCotiStats(configInput);
  const attribution = await readAttributionSummary(configInput.attributionDbPath);

  return {
    generatedAt: new Date().toISOString(),
    config: {
      agentRoot: configInput.agentRoot,
      attributionConfigured: Boolean(configInput.attributionDbPath),
      trackingBaseUrl: configInput.trackingBaseUrl,
      manualRefBuilderEnabled: Boolean(
        configInput.trackingBaseUrl &&
        configInput.starterGrantServiceUrl &&
        configInput.starterGrantServiceAuthToken
      ),
      cotiNetwork: configInput.cotiNetwork,
      contractAddress: configInput.contractAddress,
      cotiCacheTtlMs: configInput.cotiCacheTtlMs
    },
    agents: publicAgents,
    aggregateEngagements: engagementSummary,
    attribution,
    coti: {
      cachedAt: new Date(coti.createdAt).toISOString(),
      error: coti.error,
      stats: coti.value
    }
  };
}

async function handleApi(
  request: http.IncomingMessage,
  pathname: string,
  response: http.ServerResponse,
  configInput: AnalyticsConfig
) {
  if (request.method === "GET" && pathname === "/api/summary") {
    jsonResponse(response, 200, await summaryPayload(configInput));
    return;
  }

  if (request.method === "GET" && pathname === "/api/agents") {
    const agents = await discoverAgents(configInput.agentRoot);
    jsonResponse(response, 200, { agents: agents.map(publicAgent) });
    return;
  }

  if (request.method === "GET" && pathname === "/api/engagements") {
    const agents = await discoverAgents(configInput.agentRoot);
    const publicAgents = agents.map(publicAgent);
    jsonResponse(response, 200, {
      aggregate: aggregateEngagementSummaries(publicAgents.map((agent) => agent.engagementSummary)),
      agents: publicAgents.map((agent) => ({
        agentId: agent.agentId,
        displayName: agent.displayName,
        engagementSummary: agent.engagementSummary
      }))
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/attribution") {
    jsonResponse(response, 200, await readAttributionSummary(configInput.attributionDbPath));
    return;
  }

  if (request.method === "POST" && pathname === "/api/attribution/ref") {
    await createManualAttributionRef(request, response, configInput);
    return;
  }

  if (request.method === "GET" && pathname === "/api/coti/messages") {
    jsonResponse(response, 200, await getCotiStats(configInput));
    return;
  }

  if (request.method === "GET" && pathname === "/api/deploy") {
    jsonResponse(response, 200, {
      ...(await readDeployMetadata(configInput.agentRoot)),
      host: configInput.host,
      port: configInput.port
    });
    return;
  }

  jsonResponse(response, 404, { error: "Unknown API endpoint." });
}

export function createServer(configInput: AnalyticsConfig = config) {
  return http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, url.pathname, response, configInput);
        return;
      }

      await staticResponse(response, url.pathname);
    })().catch((error) => {
      jsonResponse(response, error instanceof RequestError ? error.status : 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`Outreach analytics dashboard listening on http://${config.host}:${config.port}`);
  });
}
