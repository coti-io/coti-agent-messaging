import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RedditOutboundMemoryEntry } from "./reddit-outreach.js";

export interface RedditDecisionMemoryEntry extends RedditOutboundMemoryEntry {
  decisionId?: string;
  action?: "skipped" | "commented" | "replied" | "posted";
  controller?: "manual" | "api" | "browser";
  decisionReason?: string;
  relevanceScore?: number;
  riskScore?: number;
  remoteContentUrl?: string;
  promptVariantId?: string;
  promptVariantRationale?: string;
}

export interface RedditMemoryStore {
  generatedAt: string;
  history: RedditDecisionMemoryEntry[];
}

export async function loadRedditMemory(filePath: string): Promise<RedditMemoryStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<RedditMemoryStore> | RedditDecisionMemoryEntry[];
    if (Array.isArray(parsed)) {
      return {
        generatedAt: new Date().toISOString(),
        history: parsed
      };
    }
    return {
      generatedAt: parsed.generatedAt ?? new Date().toISOString(),
      history: Array.isArray(parsed.history) ? parsed.history : []
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        generatedAt: new Date().toISOString(),
        history: []
      };
    }
    throw error;
  }
}

export async function saveRedditMemory(filePath: string, store: RedditMemoryStore): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tempPath, JSON.stringify({
    ...store,
    generatedAt: new Date().toISOString()
  }, null, 2), "utf8");
  await rename(tempPath, filePath);
}

export async function appendRedditMemory(
  filePath: string,
  entry: RedditDecisionMemoryEntry
): Promise<RedditMemoryStore> {
  const store = await loadRedditMemory(filePath);
  const next = {
    generatedAt: new Date().toISOString(),
    history: [
      ...store.history.filter((existing) => existing.id !== entry.id),
      entry
    ].slice(-500)
  };
  await saveRedditMemory(filePath, next);
  return next;
}

export function defaultRedditMemoryPath(packageRoot: string): string {
  return path.join(packageRoot, ".data", "reddit-memory.json");
}
