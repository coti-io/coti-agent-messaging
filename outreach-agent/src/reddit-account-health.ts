import { getOutreachAgentConfig, getRedditControllerConfig, type MoltbookRuntimeConfig } from "./config.js";
import type { RedditControllerKind } from "./config.js";
import {
  RedditUnofficialClient,
  type RedditUnofficialRuntimeConfig
} from "./reddit-unofficial.js";

export type RedditAccountHealthStatus =
  | "active"
  | "banned"
  | "suspended"
  | "session_invalid"
  | "misconfigured";

export interface RedditAccountHealth {
  status: RedditAccountHealthStatus;
  username?: string;
  reason: string;
  controller: RedditControllerKind | "unknown";
}

export function isRedditAccountUsable(health: RedditAccountHealth): boolean {
  return health.status === "active";
}

export function redditAccountHealthSkipReason(health: RedditAccountHealth): string {
  return `Account health check failed (${health.status}): ${health.reason}`;
}

export async function checkRedditAccountHealth(
  config: MoltbookRuntimeConfig,
  fetchImpl: typeof fetch = fetch
): Promise<RedditAccountHealth> {
  const controller = getRedditControllerConfig(config);
  const expectedUsername = getOutreachAgentConfig(config).venueAccountId?.trim();

  switch (controller.controller) {
    case "unofficial":
      return checkUnofficialAccountHealth(controller.unofficial, expectedUsername, fetchImpl, "unofficial");
    case "reddapi":
      return checkUnofficialAccountHealth(
        controller.reddapi
          ? {
              proxy: controller.reddapi.proxy,
              storageStatePath: controller.reddapi.storageStatePath,
              bearerOverride: controller.reddapi.bearerOverride
            }
          : undefined,
        expectedUsername,
        fetchImpl,
        "reddapi"
      );
    case "browser":
    case "api":
    case "manual":
      return {
        status: "active",
        controller: controller.controller,
        reason: `Skipping remote account health check for ${controller.controller} controller.`
      };
    default:
      return {
        status: "misconfigured",
        controller: "unknown",
        reason: "Reddit controller is not configured."
      };
  }
}

async function checkUnofficialAccountHealth(
  redditConfig: RedditUnofficialRuntimeConfig | undefined,
  expectedUsername: string | undefined,
  fetchImpl: typeof fetch,
  controller: RedditControllerKind
): Promise<RedditAccountHealth> {
  if (!redditConfig) {
    return {
      status: "misconfigured",
      controller,
      reason: `${controller} Reddit config is missing.`
    };
  }

  const client = new RedditUnofficialClient(redditConfig, fetchImpl);
  const health = await client.checkAccountHealth(expectedUsername);
  return {
    ...health,
    controller
  };
}
