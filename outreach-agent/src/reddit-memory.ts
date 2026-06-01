import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ActionJob } from "./action-planning.js";
import type { RedditOutboundMemoryEntry } from "./reddit-outreach.js";
import type { RedditScanLedgerEntry } from "./reddit-scan-ledger.js";

export interface RedditDecisionMemoryEntry extends RedditOutboundMemoryEntry {
  decisionId?: string;
  action?: "skipped" | "commented" | "replied" | "posted";
  controller?: "manual" | "api" | "browser" | "reddapi" | "unofficial";
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
  queuedJobs?: ActionJob[];
  scanLedger?: RedditScanLedgerEntry[];
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await rename(tempPath, filePath);
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
      history: Array.isArray(parsed.history) ? parsed.history : [],
      queuedJobs: Array.isArray(parsed.queuedJobs) ? parsed.queuedJobs : [],
      scanLedger: Array.isArray(parsed.scanLedger) ? parsed.scanLedger : []
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        generatedAt: new Date().toISOString(),
        history: [],
        queuedJobs: [],
        scanLedger: []
      };
    }
    throw error;
  }
}

export async function saveRedditMemory(filePath: string, store: RedditMemoryStore): Promise<void> {
  await writeJsonAtomic(filePath, {
    ...store,
    generatedAt: new Date().toISOString()
  });
}

/** Drop ephemeral dry-run rows; posted/removed/etc. history is kept. */
export function withoutDraftedMemoryEntries(
  history: readonly RedditDecisionMemoryEntry[]
): RedditDecisionMemoryEntry[] {
  return history.filter((entry) => entry.status !== "drafted");
}

export async function pruneDraftedRedditMemory(filePath: string): Promise<RedditMemoryStore> {
  const store = await loadRedditMemory(filePath);
  const history = withoutDraftedMemoryEntries(store.history);
  if (history.length === store.history.length) {
    return store;
  }
  const next = { ...store, history };
  await saveRedditMemory(filePath, next);
  return next;
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
