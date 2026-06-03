import type { ActionJob } from "../action-planning.js";
import type { MoltbookRuntimeConfig } from "../config.js";
import { loadRedditMemory, saveRedditMemory, type RedditMemoryStore } from "../reddit-memory.js";
import { hydrateStateQueuedJobsFromPaths } from "./sqlite-action-job-store.js";
import { SqliteActionJobStore, SqliteAgentStateStore } from "./sqlite-action-job-store.js";

/** Remove stale queued jobs from reddit JSON so they cannot repopulate SQLite on the next load. */
export async function stripRedditJsonQueuedJobs(config: MoltbookRuntimeConfig): Promise<void> {
  const operating = config.redditOperating;
  if (!operating) {
    return;
  }
  const disk = await loadRedditMemory(operating.memoryPath);
  if (!(disk.queuedJobs?.length ?? 0)) {
    return;
  }
  const { queuedJobs: _removed, ...venueMemory } = disk;
  await saveRedditMemory(operating.memoryPath, venueMemory);
}

/** Load reddit memory; queued jobs come from SQLite. JSON jobs migrate once, then JSON queue is stripped. */
export async function loadRedditMemoryWithSharedJobs(config: MoltbookRuntimeConfig): Promise<RedditMemoryStore> {
  const operating = config.redditOperating;
  if (!operating) {
    throw new Error("Reddit operating config is required.");
  }
  const store = await loadRedditMemory(operating.memoryPath);
  const jobStore = new SqliteActionJobStore(
    new SqliteAgentStateStore(config.statePath, config.heartbeatReportPath)
  );
  const sharedJobs = await jobStore.loadJobs();
  if (sharedJobs.length > 0) {
    await stripRedditJsonQueuedJobs(config);
    return { ...store, queuedJobs: sharedJobs };
  }

  const jsonJobs = store.queuedJobs ?? [];
  if (jsonJobs.length > 0) {
    await syncRedditQueuedJobsToState(config, { ...store, queuedJobs: jsonJobs });
    await stripRedditJsonQueuedJobs(config);
    return { ...store, queuedJobs: jsonJobs };
  }

  await stripRedditJsonQueuedJobs(config);
  return { ...store, queuedJobs: [] };
}

/** Persist reddit queued jobs into SQLite (source of truth for scheduler). */
export async function syncRedditQueuedJobsToState(config: MoltbookRuntimeConfig, store: RedditMemoryStore): Promise<void> {
  const jobs = store.queuedJobs ?? [];
  const stateStore = new SqliteAgentStateStore(config.statePath, config.heartbeatReportPath);
  const state = await stateStore.loadState();
  await stateStore.saveState({
    ...state,
    queuedActionJobs: [...jobs]
  });
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
