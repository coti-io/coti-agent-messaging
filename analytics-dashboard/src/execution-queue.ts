import { readQueuedActionJobsFromSqlite } from "./storage.js";
import type { AgentExecutionQueue, AgentExecutionQueueItem, AgentExecutionQueueSummary } from "./types.js";
import { asOptionalString, isRecord } from "./agent-registry.js";

const ACTIVE_STATUSES = new Set(["queued", "running", "failed", "cancelled"]);
const STATUS_SORT_ORDER: Record<string, number> = {
  running: 0,
  queued: 1,
  failed: 2,
  cancelled: 3
};

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.length > 0 && Number.isFinite(Number(value))
      ? Number(value)
      : undefined;
}

function parseJobStatus(value: unknown): AgentExecutionQueueItem["status"] | undefined {
  const status = asOptionalString(value);
  if (
    status === "queued" ||
    status === "running" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    return status;
  }
  return undefined;
}

function normalizeQueueItem(raw: unknown): AgentExecutionQueueItem | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const id = asOptionalString(raw.id);
  const type = asOptionalString(raw.type);
  const status = parseJobStatus(raw.status);
  const candidateId = asOptionalString(raw.candidateId) ?? "unknown";
  const notBefore = asOptionalString(raw.notBefore) ?? asOptionalString(raw.createdAt) ?? new Date(0).toISOString();
  if (!id || !type || !status) {
    return undefined;
  }
  return {
    id,
    venue: asOptionalString(raw.venue),
    type,
    status,
    candidateId,
    actionId: asOptionalString(raw.actionId),
    createdAt: asOptionalString(raw.createdAt),
    notBefore,
    attempts: asOptionalNumber(raw.attempts) ?? 0,
    runningAt: asOptionalString(raw.runningAt),
    lastAttemptAt: asOptionalString(raw.lastAttemptAt),
    lastError: asOptionalString(raw.lastError),
    correlationId: asOptionalString(raw.correlationId)
  };
}

function parseQueuedActionJobs(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function summarizeQueue(items: readonly AgentExecutionQueueItem[]): AgentExecutionQueueSummary {
  const summary: AgentExecutionQueueSummary = {
    queued: 0,
    running: 0,
    failed: 0,
    cancelled: 0,
    total: items.length
  };
  for (const item of items) {
    if (item.status === "queued") {
      summary.queued += 1;
    } else if (item.status === "running") {
      summary.running += 1;
    } else if (item.status === "failed") {
      summary.failed += 1;
    } else if (item.status === "cancelled") {
      summary.cancelled += 1;
    }
  }
  return summary;
}

function compareQueueItems(left: AgentExecutionQueueItem, right: AgentExecutionQueueItem): number {
  const statusDelta = STATUS_SORT_ORDER[left.status] - STATUS_SORT_ORDER[right.status];
  if (statusDelta !== 0) {
    return statusDelta;
  }
  if (left.status === "failed") {
    return parseTime(right.lastAttemptAt ?? right.notBefore) - parseTime(left.lastAttemptAt ?? left.notBefore);
  }
  return parseTime(left.notBefore) - parseTime(right.notBefore) || parseTime(left.createdAt) - parseTime(right.createdAt);
}

function parseTime(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function buildExecutionQueue(rawJobs: readonly unknown[]): AgentExecutionQueue {
  const items = rawJobs
    .map(normalizeQueueItem)
    .filter((item): item is AgentExecutionQueueItem => Boolean(item))
    .filter((item) => ACTIVE_STATUSES.has(item.status))
    .sort(compareQueueItems);
  return {
    items,
    summary: summarizeQueue(items)
  };
}

export async function loadExecutionQueue(input: {
  state?: Record<string, unknown>;
  storagePath: string;
}): Promise<AgentExecutionQueue> {
  const stateJobs = parseQueuedActionJobs(input.state?.queuedActionJobs);
  if (stateJobs.length > 0) {
    return buildExecutionQueue(stateJobs);
  }
  const sqliteJobs = await readQueuedActionJobsFromSqlite(input.storagePath);
  return buildExecutionQueue(sqliteJobs);
}
