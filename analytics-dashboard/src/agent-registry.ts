import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { AgentMetadata, AgentRuntimePaths } from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function pathExists(filePath: string): Promise<boolean> {
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

export async function readJson(filePath: string): Promise<{
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

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseEnvFile(contents: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) {
      env[key] = value;
    }
  }
  return env;
}

export function resolveTildePath(filePath: string): string {
  if (!filePath.startsWith("~/")) {
    return filePath;
  }
  const homeDir = process.env.HOME;
  return homeDir ? path.join(homeDir, filePath.slice(2)) : filePath;
}

function sanitizeServiceName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}

export function normalizeMetadata(agentDir: string, parsed: Record<string, unknown> | undefined): AgentMetadata {
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

export function buildAgentPaths(agentRoot: string, agentId: string): AgentRuntimePaths {
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

export async function listAgentDirectories(agentRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(agentRoot);
    const directories: string[] = [];
    for (const entry of entries.sort()) {
      const agentDir = path.join(agentRoot, entry);
      const entryStats = await stat(agentDir);
      if (entryStats.isDirectory()) {
        directories.push(entry);
      }
    }
    return directories;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
