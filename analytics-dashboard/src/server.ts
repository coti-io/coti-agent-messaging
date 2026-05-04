import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { collectMessageStats, type MessageStatsReport } from "../../contracts/src/message-stats";
import { loadAnalyticsConfig } from "./config";
import { discoverAgents, readDeployMetadata } from "./discovery";
import { aggregateEngagementSummaries } from "./engagements";
import type { AnalyticsConfig } from "./types";

type CachedCotiStats = {
  createdAt: number;
  value?: MessageStatsReport;
  error?: string;
};

const config = loadAnalyticsConfig();
let cotiCache: CachedCotiStats | undefined;

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
    walletAddress: agent.metadata.walletAddress,
    statePresent: agent.statePresent,
    reportPresent: agent.reportPresent,
    stateError: agent.stateError,
    reportError: agent.reportError,
    engagementSummary: agent.engagementSummary,
    lastHeartbeatAt: agent.lastHeartbeatAt,
    lastPostAt: agent.lastPostAt,
    lastCommentAt: agent.lastCommentAt,
    pendingWrites: agent.pendingWrites,
    latestStatus: agent.latestStatus,
    latestErrors: agent.latestErrors,
    latestSkipped: agent.latestSkipped
  };
}

async function getCotiStats(configInput: AnalyticsConfig): Promise<CachedCotiStats> {
  const now = Date.now();
  if (cotiCache && now - cotiCache.createdAt < configInput.cotiCacheTtlMs) {
    return cotiCache;
  }

  if (!configInput.contractAddress) {
    cotiCache = {
      createdAt: now,
      error: "CONTRACT_ADDRESS is not configured."
    };
    return cotiCache;
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

  return cotiCache;
}

async function summaryPayload() {
  const agents = await discoverAgents(config.agentRoot);
  const publicAgents = agents.map(publicAgent);
  const engagementSummary = aggregateEngagementSummaries(
    publicAgents.map((agent) => agent.engagementSummary)
  );
  const coti = await getCotiStats(config);

  return {
    generatedAt: new Date().toISOString(),
    config: {
      agentRoot: config.agentRoot,
      cotiNetwork: config.cotiNetwork,
      contractAddress: config.contractAddress,
      cotiCacheTtlMs: config.cotiCacheTtlMs
    },
    agents: publicAgents,
    aggregateEngagements: engagementSummary,
    coti: {
      cachedAt: new Date(coti.createdAt).toISOString(),
      error: coti.error,
      stats: coti.value
    }
  };
}

async function handleApi(pathname: string, response: http.ServerResponse) {
  if (pathname === "/api/summary") {
    jsonResponse(response, 200, await summaryPayload());
    return;
  }

  if (pathname === "/api/agents") {
    const agents = await discoverAgents(config.agentRoot);
    jsonResponse(response, 200, { agents: agents.map(publicAgent) });
    return;
  }

  if (pathname === "/api/engagements") {
    const agents = await discoverAgents(config.agentRoot);
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

  if (pathname === "/api/coti/messages") {
    jsonResponse(response, 200, await getCotiStats(config));
    return;
  }

  if (pathname === "/api/deploy") {
    jsonResponse(response, 200, {
      ...(await readDeployMetadata(config.agentRoot)),
      host: config.host,
      port: config.port
    });
    return;
  }

  jsonResponse(response, 404, { error: "Unknown API endpoint." });
}

export function createServer() {
  return http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(url.pathname, response);
        return;
      }

      await staticResponse(response, url.pathname);
    })().catch((error) => {
      jsonResponse(response, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`Moltbook analytics dashboard listening on http://${config.host}:${config.port}`);
  });
}
