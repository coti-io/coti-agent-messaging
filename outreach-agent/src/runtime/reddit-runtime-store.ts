import type { MoltbookRuntimeConfig } from "../config.js";
import { getRedditOperatingAgentConfig } from "../config.js";
import { loadRedditMemory, type RedditMemoryStore } from "../reddit-memory.js";
import {
  loadRedditMemoryWithSharedJobs,
  migrateRedditJsonJobsToState,
  syncRedditQueuedJobsToState
} from "./reddit-job-sync.js";
import { saveRedditMemorySynced } from "./reddit-memory-persist.js";
import {
  buildRedditRuntimeReport,
  persistRedditHeartbeatReport,
  persistRedditRuntimeSnapshot
} from "./reddit-runtime-persist.js";
import type { RedditRuntimeReport } from "./reddit-types.js";

/**
 * Single seam for Reddit runtime persistence: JSON venue memory + SQLite queued jobs.
 * Callers should not invoke job-sync or saveRedditMemoryWithoutJsonJobs directly.
 */
export class RedditRuntimeStore {
  constructor(private readonly config: MoltbookRuntimeConfig) {}

  get memoryPath(): string {
    return getRedditOperatingAgentConfig(this.config).memoryPath;
  }

  async prepare(): Promise<void> {
    await migrateRedditJsonJobsToState(this.config);
  }

  async load(): Promise<RedditMemoryStore> {
    await this.prepare();
    return loadRedditMemoryWithSharedJobs(this.config);
  }

  async loadJsonOnly(): Promise<RedditMemoryStore> {
    return loadRedditMemory(this.memoryPath);
  }

  async save(store: RedditMemoryStore): Promise<void> {
    await saveRedditMemorySynced(this.config, store);
  }

  async syncQueuedJobs(store: RedditMemoryStore): Promise<void> {
    await syncRedditQueuedJobsToState(this.config, store);
  }

  async persistRuntimeSnapshot(input: {
    phase: "heartbeat" | "executor";
    finishedAt: string;
    status: "ok" | "failed";
  }): Promise<void> {
    await persistRedditRuntimeSnapshot(this.config, input);
  }

  async persistHeartbeatReport(report: RedditRuntimeReport): Promise<void> {
    await persistRedditHeartbeatReport(this.config, report);
  }

  buildRuntimeReport(
    input: Parameters<typeof buildRedditRuntimeReport>[0]
  ): RedditRuntimeReport {
    return buildRedditRuntimeReport(input);
  }
}

export function createRedditRuntimeStore(config: MoltbookRuntimeConfig): RedditRuntimeStore {
  return new RedditRuntimeStore(config);
}
