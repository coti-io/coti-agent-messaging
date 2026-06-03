import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { readStorageAnalytics } from "../storage.js";
import type { AnalyticsReadModel, AnalyticsReadModelWriter } from "./contracts.js";
import { analyticsReadModelPath } from "./paths.js";

const HEARTBEAT_FRESHNESS_MS = 15 * 60 * 1_000;

export class FileAnalyticsReadModelWriter implements AnalyticsReadModelWriter {
  constructor(private readonly statePath: string) {}

  readModelPath(): string {
    return analyticsReadModelPath(this.statePath);
  }

  async write(model: AnalyticsReadModel): Promise<void> {
    const filePath = this.readModelPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(model, null, 2), "utf8");
  }
}

export async function buildAnalyticsReadModelFromStorage(input: {
  statePath: string;
  heartbeatReportPath: string;
  venue: AnalyticsReadModel["venue"];
  venueAccountId?: string;
  agentId?: string;
  runtimeKind: AnalyticsReadModel["runtimeKind"];
  redditMemoryPath?: string;
  attributionDbPath?: string;
  promptRotationStatePath?: string;
  latestRun?: AnalyticsReadModel["latestRun"];
  now?: Date;
}): Promise<AnalyticsReadModel> {
  const now = input.now ?? new Date();
  const analytics = await readStorageAnalytics(input.statePath, now);
  const heartbeatAt =
    analytics?.latestFinishedAt ??
    analytics?.latestStartedAt ??
    input.latestRun?.finishedAt ??
    input.latestRun?.startedAt;
  const schedulerHealth =
    analytics?.schedulerHealth ??
    resolveSchedulerHealth(heartbeatAt, now);

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    agentId: input.agentId,
    venue: input.venue,
    venueAccountId: input.venueAccountId,
    runtimeKind: input.runtimeKind,
    paths: {
      statePath: input.statePath,
      storagePath: path.join(path.dirname(input.statePath), `${path.parse(input.statePath).name}.sqlite`),
      heartbeatReportPath: input.heartbeatReportPath,
      attributionDbPath: input.attributionDbPath,
      promptRotationStatePath: input.promptRotationStatePath,
      redditMemoryPath: input.redditMemoryPath
    },
    scheduler: {
      lastHeartbeatAt: heartbeatAt,
      lastSuccessfulRunAt: analytics?.lastSuccessfulHeartbeatAt,
      latestStatus: analytics?.latestStatus ?? input.latestRun?.status,
      health: schedulerHealth
    },
    engagementSummary: analytics?.engagementSummary,
    pendingWork: {
      pendingWrites: analytics?.pendingWrites ?? 0,
      queuedJobs: analytics?.pendingJobs ?? 0
    },
    latestRun: input.latestRun
  };
}

function resolveSchedulerHealth(
  heartbeatAt: string | undefined,
  now: Date
): AnalyticsReadModel["scheduler"]["health"] {
  if (!heartbeatAt) {
    return "unknown";
  }
  const timestamp = Date.parse(heartbeatAt);
  if (Number.isNaN(timestamp)) {
    return "unknown";
  }
  return now.getTime() - timestamp <= HEARTBEAT_FRESHNESS_MS ? "fresh" : "stale";
}
