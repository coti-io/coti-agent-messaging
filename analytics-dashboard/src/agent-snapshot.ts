import { readFile } from "node:fs/promises";

import { readAnalyticsReadModel, type AnalyticsReadModelSnapshot } from "./read-analytics-read-model";
import { readSqliteAgentSnapshot } from "./storage";
import type { SqliteAgentSnapshot } from "./storage";
import type { AgentRuntimePaths, DiscoveredAgent } from "./types";
import {
  asOptionalString,
  parseEnvFile,
  pathExists,
  resolveTildePath
} from "./agent-registry";
import path from "node:path";

function redditProfileUrlFromAccountId(accountId: string): string {
  return `https://www.reddit.com/user/${encodeURIComponent(accountId)}`;
}

export async function resolveProfileUrl(
  paths: AgentRuntimePaths,
  profileUrl: string | undefined,
  state: Record<string, unknown> | undefined
): Promise<string | undefined> {
  if (profileUrl) {
    return profileUrl;
  }

  const stateAccountId = asOptionalString(state?.venueAccountId);
  if (stateAccountId) {
    return redditProfileUrlFromAccountId(stateAccountId);
  }

  try {
    const envRaw = await readFile(paths.envPath, "utf8");
    const accountId = parseEnvFile(envRaw).OUTREACH_VENUE_ACCOUNT_ID?.trim();
    if (accountId) {
      return redditProfileUrlFromAccountId(accountId);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return undefined;
}

export interface AgentSchedulerSnapshot {
  readModelPresent: boolean;
  lastHeartbeatAt?: string;
  schedulerHealth: DiscoveredAgent["schedulerHealth"];
  lastSuccessfulHeartbeatAt?: string;
  latestStartedAt?: string;
  latestFinishedAt?: string;
  latestStatus?: string;
  pendingWrites: number;
}

export async function loadAgentSchedulerSnapshot(
  paths: AgentRuntimePaths,
  now: Date
): Promise<{
  readModel?: AnalyticsReadModelSnapshot;
  sqliteSnapshot?: SqliteAgentSnapshot;
  scheduler: AgentSchedulerSnapshot;
}> {
  const readModel = await readAnalyticsReadModel(paths.statePath);
  let sqliteSnapshot: SqliteAgentSnapshot | undefined;
  try {
    sqliteSnapshot = await readSqliteAgentSnapshot(paths.storagePath, now);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const readModelPresent = readModel !== undefined;
  const scheduler: AgentSchedulerSnapshot = {
    readModelPresent,
    lastHeartbeatAt: readModelPresent ? readModel.scheduler.lastHeartbeatAt : undefined,
    schedulerHealth: readModelPresent ? readModel.scheduler.health : "unknown",
    lastSuccessfulHeartbeatAt: readModelPresent
      ? readModel.scheduler.lastSuccessfulRunAt
      : undefined,
    latestStartedAt: readModelPresent ? readModel.latestRun?.startedAt : undefined,
    latestFinishedAt: readModelPresent ? readModel.latestRun?.finishedAt : undefined,
    latestStatus: readModelPresent
      ? (readModel.latestRun?.status ?? readModel.scheduler.latestStatus)
      : undefined,
    pendingWrites: readModelPresent
      ? readModel.pendingWork.pendingWrites + readModel.pendingWork.queuedJobs
      : 0
  };

  return { readModel, sqliteSnapshot, scheduler };
}

export async function resolvePromptRotationStatePath(
  paths: AgentRuntimePaths,
  agentRoot: string
): Promise<string | undefined> {
  const candidatePaths = new Set<string>();

  try {
    const envRaw = await readFile(paths.envPath, "utf8");
    const configuredPath = parseEnvFile(envRaw).OUTREACH_PROMPT_ROTATION_STATE_PATH;
    if (configuredPath) {
      const resolved = resolveTildePath(configuredPath);
      candidatePaths.add(path.isAbsolute(resolved) ? resolved : path.resolve(path.dirname(paths.envPath), resolved));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  candidatePaths.add(path.join(paths.runtimeDir, "prompt-rotation.json"));
  candidatePaths.add(path.join(paths.agentDir, ".data", "prompt-rotation.json"));
  candidatePaths.add(path.join(path.dirname(paths.runtimeDir), "outreach-agent", ".data", "prompt-rotation.json"));
  candidatePaths.add(path.join(path.dirname(agentRoot), "repo", "outreach-agent", ".data", "prompt-rotation.json"));

  for (const candidatePath of candidatePaths) {
    if (await pathExists(candidatePath)) {
      return candidatePath;
    }
  }
  return undefined;
}
