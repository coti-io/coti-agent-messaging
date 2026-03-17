import "dotenv/config";

import http from "node:http";

import {
  claimStarterGrant,
  consumeStarterGrantRateLimit,
  getStarterGrantStatus,
  issueStarterGrantChallenge,
  requestKeyFromIp
} from "./claims.js";
import { resolveStarterGrantServiceConfig } from "./config.js";
import { CotiStarterGrantFunder } from "./funder.js";
import { StarterGrantFileStore } from "./storage.js";
import type { StarterGrantServiceConfig } from "./types.js";

interface JsonResponse {
  status: number;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): JsonResponse {
  return { status, body };
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object request body.");
  }

  return parsed as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for "${field}".`);
  }

  return value;
}

function resolveRequesterIp(request: http.IncomingMessage): string | undefined {
  const forwardedFor = request.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0]?.trim();
  }

  return request.socket.remoteAddress ?? undefined;
}

function authorize(request: http.IncomingMessage, config: StarterGrantServiceConfig): boolean {
  if (!config.authToken) {
    return true;
  }

  return request.headers.authorization === `Bearer ${config.authToken}`;
}

export async function startStarterGrantService(config = resolveStarterGrantServiceConfig()) {
  const store = new StarterGrantFileStore(config.statePath);
  const funder = new CotiStarterGrantFunder({
    funderPrivateKey: config.funderPrivateKey,
    network: config.network,
    rpcUrl: config.rpcUrl
  });

  const server = http.createServer(async (request, response) => {
    try {
      if (!request.url || !request.method) {
        throw new Error("Request was missing a URL or method.");
      }

      const url = new URL(request.url, `http://${config.host}:${config.port}`);
      const requesterKey = requestKeyFromIp(resolveRequesterIp(request));

      if (!authorize(request, config)) {
        writeJsonResponse(response, jsonResponse(401, { error: "Unauthorized starter grant request." }));
        return;
      }

      if (request.method === "GET" && url.pathname === config.healthRoute) {
        writeJsonResponse(response, jsonResponse(200, { status: "ok" }));
        return;
      }

      const allowed = await consumeStarterGrantRateLimit(store, {
        requesterKey,
        maxRequests: config.maxRequestsPerWindow,
        windowMs: config.rateLimitWindowMs
      });
      if (!allowed) {
        writeJsonResponse(response, jsonResponse(429, { error: "Starter grant rate limit exceeded." }));
        return;
      }

      if (request.method === "POST" && url.pathname === config.challengeRoute) {
        const body = await readJsonBody(request);
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
        const body = await readJsonBody(request);
        const status = await getStarterGrantStatus(store, {
          walletAddress: asString(body.walletAddress, "walletAddress"),
          installId: asString(body.installId, "installId")
        });
        writeJsonResponse(response, jsonResponse(200, status));
        return;
      }

      if (request.method === "POST" && url.pathname === config.claimRoute) {
        const body = await readJsonBody(request);
        const claim = await claimStarterGrant(store, funder, {
          challengeId: asString(body.challengeId, "challengeId"),
          walletAddress: asString(body.walletAddress, "walletAddress"),
          installId: asString(body.installId, "installId"),
          challengeAnswer: asString(body.challengeAnswer, "challengeAnswer"),
          claimPayload: asString(body.claimPayload, "claimPayload"),
          signature: asString(body.signature, "signature"),
          amountWei: config.starterAmountWei,
          requesterKey
        });
        writeJsonResponse(response, jsonResponse(200, claim));
        return;
      }

      writeJsonResponse(response, jsonResponse(404, { error: "Starter grant route not found." }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status =
        /already claimed|challenge/.test(message) && !/Expected/.test(message)
          ? 409
          : /Expected|JSON/.test(message)
            ? 400
            : 500;
      writeJsonResponse(response, jsonResponse(status, { error: message }));
    }
  });

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
  response.end(JSON.stringify(result.body));
}

const isDirectExecution = process.argv[1]?.endsWith("/server.js");

if (isDirectExecution) {
  startStarterGrantService()
    .then(({ config }) => {
      console.log(
        `Starter grant service listening on http://${config.host}:${config.port}${config.challengeRoute}`
      );
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
