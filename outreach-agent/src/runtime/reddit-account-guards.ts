import { getRedditControllerConfig, type MoltbookRuntimeConfig } from "../config.js";
import { appendRedditMemory, saveRedditMemory, type RedditMemoryStore } from "../reddit-memory.js";
import {
  checkRedditAccountHealth,
  isRedditAccountUsable,
  redditAccountHealthSkipReason,
  type RedditAccountHealth
} from "../reddit-account-health.js";
import { createRedditRuntimeStore } from "./reddit-runtime-store.js";

export async function verifyRedditAccountHealth(input: {
  config: MoltbookRuntimeConfig;
  memory: RedditMemoryStore;
  memoryPath: string;
  now: Date;
  fetchImpl?: typeof fetch;
}): Promise<{ memory: RedditMemoryStore; blockedReason?: string; health?: RedditAccountHealth }> {
  const health = await checkRedditAccountHealth(input.config, input.fetchImpl ?? fetch);
  if (isRedditAccountUsable(health)) {
    return { memory: input.memory, health };
  }

  const blockedReason = redditAccountHealthSkipReason(health);
  const hasRecentBan = input.memory.history.some((entry) => entry.status === "banned");
  let memory = input.memory;
  if (!hasRecentBan) {
    memory = await appendRedditMemory(input.memoryPath, {
      id: `account-health:${input.now.getTime()}`,
      subreddit: "account",
      kind: "comment",
      action: "skipped",
      content: health.reason,
      createdAt: input.now.toISOString(),
      status: "banned",
      controller: getRedditControllerConfig(input.config).controller,
      decisionReason: health.reason
    });
  }

  if ((memory.queuedJobs?.length ?? 0) > 0) {
    memory = {
      ...memory,
      queuedJobs: []
    };
    await saveRedditMemory(input.memoryPath, memory);
    await createRedditRuntimeStore(input.config).syncQueuedJobs(memory);
  }

  return { memory, blockedReason, health };
}
