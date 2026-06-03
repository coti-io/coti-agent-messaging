import { readFile } from "node:fs/promises";
import path from "node:path";

export interface AnalyticsReadModelPaths {
  statePath: string;
  storagePath: string;
  heartbeatReportPath: string;
  attributionDbPath?: string;
  promptRotationStatePath?: string;
  redditMemoryPath?: string;
}

export interface AnalyticsReadModelSnapshot {
  schemaVersion: number;
  generatedAt: string;
  agentId?: string;
  venue: string;
  venueAccountId?: string;
  runtimeKind: string;
  paths: AnalyticsReadModelPaths;
  scheduler: {
    lastHeartbeatAt?: string;
    lastSuccessfulRunAt?: string;
    latestStatus?: string;
    health: "fresh" | "stale" | "unknown";
  };
  engagementSummary?: {
    generatedAt: string;
    windows: Record<string, unknown>;
    total: Record<string, number>;
  };
  pendingWork: {
    pendingWrites: number;
    queuedJobs: number;
  };
  latestRun?: {
    runId: string;
    phase?: string;
    status: string;
    startedAt: string;
    finishedAt?: string;
    summary?: string;
  };
}

export function analyticsReadModelPathForState(statePath: string): string {
  return path.join(path.dirname(statePath), "analytics-read-model.json");
}

export async function readAnalyticsReadModel(
  statePath: string
): Promise<AnalyticsReadModelSnapshot | undefined> {
  const filePath = analyticsReadModelPathForState(statePath);
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as AnalyticsReadModelSnapshot;
    if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== 1) {
      return undefined;
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
