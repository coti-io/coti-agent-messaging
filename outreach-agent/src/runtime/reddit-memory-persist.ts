import type { MoltbookRuntimeConfig } from "../config.js";
import { getRedditOperatingAgentConfig } from "../config.js";
import { loadRedditMemory, saveRedditMemory, type RedditMemoryStore } from "../reddit-memory.js";
import { syncRedditQueuedJobsToState } from "./reddit-job-sync.js";
import { redditJsonJobsLegacyEnabled } from "./reddit-job-legacy.js";

/** Persist venue memory without mirroring queued jobs into JSON unless legacy mode is on. */
export async function saveRedditMemoryWithoutJsonJobs(
  config: MoltbookRuntimeConfig,
  store: RedditMemoryStore
): Promise<void> {
  const operating = getRedditOperatingAgentConfig(config);
  const { queuedJobs, ...venueMemory } = store;
  await saveRedditMemory(operating.memoryPath, {
    ...venueMemory,
    ...(redditJsonJobsLegacyEnabled() && queuedJobs?.length ? { queuedJobs } : {})
  });
}

export async function saveRedditMemorySynced(config: MoltbookRuntimeConfig, store: RedditMemoryStore): Promise<void> {
  await syncRedditQueuedJobsToState(config, store);
  await saveRedditMemoryWithoutJsonJobs(config, store);
}
