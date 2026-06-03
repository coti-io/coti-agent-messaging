import type { ActionJob } from "../action-planning.js";
import type { MoltbookRuntimeConfig } from "../config.js";
import { loadRedditMemory, saveRedditMemory, type RedditMemoryStore } from "../reddit-memory.js";
import { hydrateStateQueuedJobsFromPaths } from "./sqlite-action-job-store.js";
import { SqliteActionJobStore, SqliteAgentStateStore } from "./sqlite-action-job-store.js";

/** Load reddit memory and merge queued jobs from SQLite when JSON memory has none. */
export async function loadRedditMemoryWithSharedJobs(config: MoltbookRuntimeConfig): Promise<RedditMemoryStore> {
  const operating = config.redditOperating;
  if (!operating) {
    throw new Error("Reddit operating config is required.");
  }
  const store = await loadRedditMemory(operating.memoryPath);
  if ((store.queuedJobs?.length ?? 0) > 0) {
    return store;
  }
  const jobStore = new SqliteActionJobStore(
    new SqliteAgentStateStore(config.statePath, config.heartbeatReportPath)
  );
  const sharedJobs = await jobStore.loadJobs();
  if (sharedJobs.length === 0) {
    return store;
  }
  return {
    ...store,
    queuedJobs: sharedJobs
  };
}

/** Persist reddit queued jobs into shared SQLite state (source of truth for scheduler). */
export async function syncRedditQueuedJobsToState(config: MoltbookRuntimeConfig, store: RedditMemoryStore): Promise<void> {
  const jobs = store.queuedJobs ?? [];
  const stateStore = new SqliteAgentStateStore(config.statePath, config.heartbeatReportPath);
  const state = await stateStore.loadState();
  await stateStore.saveState({
    ...state,
    queuedActionJobs: [...jobs]
  });
  if (jobs.length > 0) {
    await saveRedditMemory(config.redditOperating!.memoryPath, {
      ...store,
      queuedJobs: jobs
    });
  }
}

/** One-time migration: copy JSON queued jobs into SQLite when SQLite is empty. */
export async function migrateRedditJsonJobsToState(config: MoltbookRuntimeConfig): Promise<void> {
  const operating = config.redditOperating;
  if (!operating) {
    return;
  }
  const store = await loadRedditMemory(operating.memoryPath);
  await hydrateStateQueuedJobsFromPaths({
    statePath: config.statePath,
    heartbeatReportPath: config.heartbeatReportPath,
    jobs: store.queuedJobs ?? []
  });
}
