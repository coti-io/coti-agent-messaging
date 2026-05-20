import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { summarizeEngagements } from "./engagements";
import { readSqliteAgentSnapshot } from "./storage";
import type { AgentMetadata, AgentRuntimePaths, DiscoveredAgent } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readJson(filePath: string): Promise<{
  value?: Record<string, unknown>;
  present: boolean;
  error?: string;
}> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return { present: true, error: "JSON root is not an object." };
    }
    return { value: parsed, present: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { present: false };
    }
    return {
      present: true,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizeServiceName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}

function normalizeMetadata(agentDir: string, parsed: Record<string, unknown> | undefined): AgentMetadata {
  const fallbackId = path.basename(agentDir);
  const agentId = asOptionalString(parsed?.agentId) ?? fallbackId;
  return {
    agentId,
    displayName: asOptionalString(parsed?.displayName) ?? agentId,
    description: asOptionalString(parsed?.description),
    serviceName:
      asOptionalString(parsed?.serviceName) ?? `moltbook-outreach-${sanitizeServiceName(agentId)}`,
    profileUrl: asOptionalString(parsed?.profileUrl),
    walletAddress: asOptionalString(parsed?.walletAddress)
  };
}

function buildPaths(agentRoot: string, agentId: string): AgentRuntimePaths {
  const agentDir = path.join(agentRoot, agentId);
  const runtimeDir = path.join(agentDir, ".runtime");
  return {
    agentDir,
    runtimeDir,
    envPath: path.join(agentDir, ".env"),
    metadataPath: path.join(agentDir, "agent.json"),
    statePath: path.join(runtimeDir, "state.json"),
    storagePath: path.join(runtimeDir, "state.sqlite"),
    reportPath: path.join(runtimeDir, "last-heartbeat.json")
  };
}

export async function discoverAgents(agentRoot: string, now = new Date()): Promise<DiscoveredAgent[]> {
  let entries: string[];
  try {
    entries = await readdir(agentRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const agents: DiscoveredAgent[] = [];
  for (const entry of entries.sort()) {
    const agentDir = path.join(agentRoot, entry);
    const entryStats = await stat(agentDir);
    if (!entryStats.isDirectory()) {
      continue;
    }

    const paths = buildPaths(agentRoot, entry);
    const [metadataJson, stateJson, reportJson] = await Promise.all([
      readJson(paths.metadataPath),
      readJson(paths.statePath),
      readJson(paths.reportPath)
    ]);
    const metadata = normalizeMetadata(agentDir, metadataJson.value);
    const normalizedPaths =
      metadata.agentId === entry ? paths : buildPaths(agentRoot, metadata.agentId);
    const state = stateJson.value;
    const report = reportJson.value;
    let sqliteSnapshot;
    try {
      sqliteSnapshot = await readSqliteAgentSnapshot(normalizedPaths.storagePath, now);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const engagementSummary = sqliteSnapshot?.engagementSummary ?? summarizeEngagements(state, now);
    const jsonPendingWrites =
      (Array.isArray(state?.pendingWrites) ? state.pendingWrites.length : 0) +
      (Array.isArray(state?.queuedActionJobs) ? state.queuedActionJobs.length : 0);
    const pendingWrites =
      sqliteSnapshot?.pendingWrites === undefined
        ? jsonPendingWrites
        : Math.max(sqliteSnapshot.pendingWrites, jsonPendingWrites);
    const errors =
      sqliteSnapshot?.latestErrors ?? (Array.isArray(report?.errors) ? report.errors.length : 0);
    const skipped =
      sqliteSnapshot?.latestSkipped ?? (Array.isArray(report?.skipped) ? report.skipped.length : 0);

    agents.push({
      metadata,
      paths: normalizedPaths,
      statePresent: stateJson.present,
      reportPresent: reportJson.present,
      stateError: stateJson.error,
      reportError: reportJson.error,
      state,
      report,
      engagementSummary,
      lastHeartbeatAt:
        sqliteSnapshot?.lastHeartbeatAt ??
        asOptionalString(state?.lastHeartbeatAt) ??
        asOptionalString(report?.finishedAt),
      lastPostAt: asOptionalString(state?.lastPostAt),
      lastCommentAt: asOptionalString(state?.lastCommentAt),
      pendingWrites,
      schedulerHealth: sqliteSnapshot?.schedulerHealth ?? "unknown",
      lastSuccessfulHeartbeatAt:
        sqliteSnapshot?.lastSuccessfulHeartbeatAt ??
        (asOptionalString(report?.status) === "ok" ? asOptionalString(report?.finishedAt) : undefined),
      latestStartedAt: sqliteSnapshot?.latestStartedAt ?? asOptionalString(report?.startedAt),
      latestFinishedAt: sqliteSnapshot?.latestFinishedAt ?? asOptionalString(report?.finishedAt),
      latestStatus: sqliteSnapshot?.latestStatus ?? asOptionalString(report?.status),
      latestErrors: errors,
      latestSkipped: skipped
    });
  }

  return agents;
}

export async function readDeployMetadata(agentRoot: string) {
  return {
    agentRoot,
    agentRootPresent: await pathExists(agentRoot)
  };
}
