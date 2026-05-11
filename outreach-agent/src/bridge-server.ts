#!/usr/bin/env node

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { rmSync } from "node:fs";
import { mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ChatMessage } from "./llm-client.js";

export interface ManualBridgeServerConfig {
  host: string;
  port: number;
  routePath: string;
  bridgeDir: string;
  authToken?: string;
  responseTimeoutMs: number;
  pollIntervalMs: number;
}

export interface ManualBridgeRequestPayload {
  requestId: string;
  createdAt: string;
  messages: readonly ChatMessage[];
}

export interface ManualBridgeServerHandle {
  server: Server;
  config: ManualBridgeServerConfig;
  requestsDir: string;
  responsesDir: string;
  statusPath: string;
  close(): Promise<void>;
}

interface BridgeStatusPayload {
  phase: string;
  pid: number;
  host?: string;
  port?: number;
  routePath?: string;
  bridgeDir: string;
  requestCount?: number;
  requestId?: string;
  requestPath?: string;
  responsePath?: string;
  error?: {
    name?: string;
    message?: string;
  };
}

function defaultBridgeDir(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const packageRoot = path.resolve(path.dirname(currentFile), "..", "..");
  return path.join(packageRoot, ".bridge", "llm-bridge");
}

function removeBridgeDirSync(bridgeDir: string): void {
  try {
    rmSync(bridgeDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures during shutdown.
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(targetPath: string, value: unknown): Promise<void> {
  await writeFile(targetPath, JSON.stringify(value, null, 2), "utf8");
}

async function readJson<T>(targetPath: string): Promise<T> {
  return JSON.parse(await readFile(targetPath, "utf8")) as T;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function jsonResponse(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(payload));
}

export function resolveBridgeServerConfig(): ManualBridgeServerConfig {
  const rawPort = Number(process.env.MOLTBOOK_LLM_BRIDGE_SERVER_PORT ?? "4318");
  return {
    host: process.env.MOLTBOOK_LLM_BRIDGE_SERVER_HOST ?? "127.0.0.1",
    port: Number.isFinite(rawPort) && rawPort >= 0 ? rawPort : 4318,
    routePath: process.env.MOLTBOOK_LLM_BRIDGE_SERVER_PATH ?? "/json-completion",
    bridgeDir: process.env.MOLTBOOK_LLM_BRIDGE_SERVER_DIR ?? defaultBridgeDir(),
    authToken: process.env.MOLTBOOK_LLM_BRIDGE_SERVER_AUTH_TOKEN,
    responseTimeoutMs: Number(process.env.MOLTBOOK_LLM_BRIDGE_SERVER_RESPONSE_TIMEOUT_MS ?? "300000"),
    pollIntervalMs: Number(process.env.MOLTBOOK_LLM_BRIDGE_SERVER_POLL_INTERVAL_MS ?? "500")
  };
}

async function waitForResponseFile(
  responsePath: string,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<unknown> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await pathExists(responsePath)) {
      return readJson<unknown>(responsePath);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Timed out waiting for bridge response at ${responsePath}`);
}

function authorize(request: IncomingMessage, authToken: string | undefined): boolean {
  if (!authToken) {
    return true;
  }

  return request.headers.authorization === `Bearer ${authToken}`;
}

export async function startManualBridgeServer(
  configInput: Partial<ManualBridgeServerConfig> = {}
): Promise<ManualBridgeServerHandle> {
  const config = { ...resolveBridgeServerConfig(), ...configInput };
  const requestsDir = path.join(config.bridgeDir, "requests");
  const responsesDir = path.join(config.bridgeDir, "responses");
  const statusPath = path.join(config.bridgeDir, "status.json");
  let requestCount = 0;
  let closed = false;

  await rm(config.bridgeDir, { recursive: true, force: true });
  await mkdir(requestsDir, { recursive: true });
  await mkdir(responsesDir, { recursive: true });

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        jsonResponse(response, 200, {
          ok: true,
          pid: process.pid,
          routePath: config.routePath,
          bridgeDir: config.bridgeDir,
          requestCount
        });
        return;
      }

      if (request.method !== "POST" || request.url !== config.routePath) {
        jsonResponse(response, 404, { error: "Not found." });
        return;
      }

      if (!authorize(request, config.authToken)) {
        jsonResponse(response, 401, { error: "Unauthorized." });
        return;
      }

      const rawBody = await readRequestBody(request);
      const body = JSON.parse(rawBody || "{}") as { messages?: ChatMessage[] };
      if (!Array.isArray(body.messages)) {
        jsonResponse(response, 400, { error: "Expected JSON body with a messages array." });
        return;
      }

      requestCount += 1;
      const requestId = `bridge-${Date.now()}-${requestCount}`;
      const requestPayload: ManualBridgeRequestPayload = {
        requestId,
        createdAt: new Date().toISOString(),
        messages: body.messages
      };
      const requestPath = path.join(requestsDir, `${requestId}.json`);
      const responsePath = path.join(responsesDir, `${requestId}.json`);

      await writeJson(requestPath, requestPayload);
      await writeJson(statusPath, {
        phase: "waiting_for_response",
        pid: process.pid,
        requestId,
        requestCount,
        requestPath,
        responsePath,
        routePath: config.routePath,
        bridgeDir: config.bridgeDir
      });

      const result = await waitForResponseFile(
        responsePath,
        config.responseTimeoutMs,
        config.pollIntervalMs
      );

      await writeJson(statusPath, {
        phase: "response_returned",
        pid: process.pid,
        requestId,
        requestCount,
        requestPath,
        responsePath,
        routePath: config.routePath,
        bridgeDir: config.bridgeDir
      });
      jsonResponse(response, 200, { result });
      await Promise.all([
        unlink(requestPath).catch(() => undefined),
        unlink(responsePath).catch(() => undefined)
      ]);
    } catch (error) {
      await writeJson(statusPath, {
        phase: "failed",
        pid: process.pid,
        requestCount,
        routePath: config.routePath,
        bridgeDir: config.bridgeDir,
        error: {
          name: (error as Error).name,
          message: (error as Error).message
        }
      });
      jsonResponse(response, 500, {
        error: (error as Error).message
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const resolvedPort =
    typeof address === "object" && address?.port ? address.port : config.port;
  const resolvedConfig = {
    ...config,
    port: resolvedPort
  };

  await writeJson(statusPath, {
    phase: "listening",
    pid: process.pid,
    host: resolvedConfig.host,
    port: resolvedConfig.port,
    routePath: resolvedConfig.routePath,
    bridgeDir: resolvedConfig.bridgeDir
  });

  return {
    server,
    config: resolvedConfig,
    requestsDir,
    responsesDir,
    statusPath,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      removeBridgeDirSync(resolvedConfig.bridgeDir);
    }
  };
}

export async function runBridgeServerCli(): Promise<void> {
  const handle = await startManualBridgeServer();
  let shuttingDown = false;
  const shutdown = async (signal?: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await handle.close();
    } finally {
      removeBridgeDirSync(handle.config.bridgeDir);
      if (signal) {
        process.exit(0);
      }
    }
  };
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGHUP", () => {
    void shutdown("SIGHUP");
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        host: handle.config.host,
        port: handle.config.port,
        routePath: handle.config.routePath,
        bridgeDir: handle.config.bridgeDir,
        requestsDir: handle.requestsDir,
        responsesDir: handle.responsesDir,
        statusPath: handle.statusPath
      },
      null,
      2
    )
  );
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  runBridgeServerCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
