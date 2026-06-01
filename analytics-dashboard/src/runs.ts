import { readFile } from "node:fs/promises";
import path from "node:path";

import { readRecentHeartbeatRunsFromSqlite } from "./storage";
import type { AgentHeartbeatRun, AgentRuntimePaths, EngagementCounts } from "./types";

const DEFAULT_RUN_LIMIT = 5;

function emptyCounts(): EngagementCounts {
  return { posts: 0, comments: 0, replies: 0, upvotes: 0, follows: 0, total: 0 };
}

function normalizeCounts(value: Partial<EngagementCounts> | undefined): EngagementCounts {
  const counts = { ...emptyCounts(), ...value };
  counts.total =
    counts.posts + counts.comments + counts.replies + counts.upvotes + counts.follows;
  return counts;
}

function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

function countPerformedActions(performed: readonly string[]): EngagementCounts {
  const counts = emptyCounts();
  for (const entry of performed) {
    const normalized = entry.toLowerCase();
    if (normalized.includes("post")) {
      counts.posts += 1;
    } else if (normalized.includes("comment")) {
      counts.comments += 1;
    } else if (normalized.includes("reply")) {
      counts.replies += 1;
    } else if (normalized.includes("upvote")) {
      counts.upvotes += 1;
    } else if (normalized.includes("follow")) {
      counts.follows += 1;
    }
  }
  return normalizeCounts(counts);
}

function normalizeErrors(value: unknown): Array<{ phase?: string; message: string }> {
  const entries = parseJsonArray<unknown>(value);
  return entries
    .map((entry) => {
      if (typeof entry === "string") {
        return { message: entry };
      }
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        const message = asOptionalString(record.message) ?? JSON.stringify(record);
        return {
          phase: asOptionalString(record.phase),
          message
        };
      }
      return undefined;
    })
    .filter((entry): entry is { phase?: string; message: string } => Boolean(entry));
}

function buildRunHeadline(performed: readonly string[], skipped: readonly string[], fallback?: string): string {
  if (performed.length === 0 && skipped.length === 0) {
    return fallback ?? "No activity recorded.";
  }
  const parts: string[] = [];
  if (performed.length > 0) {
    parts.push(performed.join(" "));
  }
  if (skipped.length > 0) {
    parts.push(`Skipped: ${skipped.join("; ")}`);
  }
  return parts.join(" ");
}

function isRedditRuntimeReport(report: Record<string, unknown>): boolean {
  return (
    report.phase === "heartbeat" ||
    report.phase === "executor" ||
    parseJsonRecord(report.ingestion) !== undefined
  );
}

function describeRedditCandidate(candidate: Record<string, unknown>): string {
  const type = asOptionalString(candidate.type) ?? "action";
  const id = asOptionalString(candidate.id) ?? "";
  const source = parseJsonRecord(candidate.source);
  const subreddit = asOptionalString(source?.subreddit);
  const title = asOptionalString(source?.title);
  const target = subreddit ? `r/${subreddit}` : id;
  const blockedBy = parseJsonArray<string>(candidate.blockedBy).map(String);
  const headline = title ? `${type} on ${target} — "${title}"` : `${type} on ${target}`;
  if (blockedBy.length > 0) {
    return `${headline} (blocked: ${blockedBy.join(", ")})`;
  }
  return headline;
}

function describeQueuedRedditJob(job: Record<string, unknown>): string {
  const type = asOptionalString(job.type) ?? "write";
  const candidateId = asOptionalString(job.candidateId) ?? asOptionalString(job.id);
  const status = asOptionalString(job.status);
  const notBefore = asOptionalString(job.notBefore);
  const parts = [`Queued ${type}`];
  if (candidateId) {
    parts.push(`for ${candidateId}`);
  }
  if (status) {
    parts.push(`(${status})`);
  }
  if (notBefore) {
    parts.push(`after ${notBefore}`);
  }
  return parts.join(" ");
}

function extractRedditRunDetails(report: Record<string, unknown>): {
  performed: string[];
  skipped: string[];
  summary: string;
  runCounts: EngagementCounts;
  countsScope: "lifetime" | "run";
  activityThisRun?: string;
} {
  const planner = parseJsonRecord(report.planner);
  const ingestion = parseJsonRecord(report.ingestion);
  const bundle = parseJsonRecord(report.selectedActionBundle);
  const candidates = parseJsonArray<Record<string, unknown>>(report.actionCandidates);
  const queuedJobs = parseJsonArray<Record<string, unknown>>(report.queuedActionJobs);

  let skipped = uniqueStrings([
    ...parseJsonArray<string>(report.skipped).map(String),
    ...parseJsonArray<string>(planner?.skipped).map(String),
    ...parseJsonArray<string>(ingestion?.skipped).map(String)
  ]);

  const performed: string[] = [];
  for (const job of queuedJobs) {
    performed.push(describeQueuedRedditJob(job));
  }

  const selectedIds = new Set([
    ...parseJsonArray<string>(bundle?.selectedCandidateIds).map(String),
    ...parseJsonArray<string>(bundle?.selectedNoContentCandidateIds).map(String)
  ]);
  const writeId = asOptionalString(bundle?.selectedWriteCandidateId);
  if (writeId) {
    selectedIds.add(writeId);
  }
  for (const candidateId of selectedIds) {
    const candidate = candidates.find((entry) => asOptionalString(entry.id) === candidateId);
    if (candidate) {
      performed.push(`Selected ${describeRedditCandidate(candidate)}`);
    }
  }

  const recorded = parseJsonRecord(report.recorded);
  if (recorded) {
    const kind = asOptionalString(recorded.kind) ?? "action";
    const subreddit = asOptionalString(recorded.subreddit);
    const title = asOptionalString(recorded.targetTitle);
    const status = asOptionalString(recorded.status);
    performed.push(
      `${status === "posted" ? "Posted" : "Recorded"} ${kind}${subreddit ? ` on r/${subreddit}` : ""}${title ? `: "${title}"` : ""}`
    );
  }

  const rationale = asOptionalString(bundle?.rationale);
  const deferredIds = parseJsonArray<string>(bundle?.deferredCandidateIds).map(String);
  const allowedCount = candidates.filter((candidate) => candidate.allowed === true).length;
  const blockedCount = candidates.filter((candidate) => candidate.allowed === false).length;

  if (rationale) {
    skipped.push(rationale);
  }
  if (deferredIds.length > 0) {
    skipped.push(`Deferred ${deferredIds.length} candidate(s) to a later run.`);
  }

  const gateSample = parseJsonArray<Record<string, unknown>>(planner?.blockedGateSample);
  for (const sample of gateSample.slice(0, 6)) {
    const id = asOptionalString(sample.id);
    const gates = parseJsonArray<string>(sample.gates).map(String).join(", ");
    if (id && gates) {
      skipped.push(`${id}: blocked by ${gates}`);
    }
  }

  if (performed.length === 0 && skipped.length === 0) {
    if (blockedCount > 0) {
      const examples = candidates
        .filter((candidate) => candidate.allowed === false)
        .slice(0, 2)
        .map((candidate) => describeRedditCandidate(candidate));
      skipped.push(
        `Reviewed ${candidates.length} candidate(s); all blocked${examples.length ? ` (e.g. ${examples.join("; ")})` : ""}.`
      );
    } else if (candidates.length === 0) {
      skipped.push("No action candidates were generated this run.");
    } else if (allowedCount > 0) {
      skipped.push(
        `${allowedCount} allowed candidate(s) but nothing was queued (check daily caps, cooldowns, or jitter).`
      );
    }
  }

  const engagementSummary = parseJsonRecord(report.engagementSummary);
  const engagementTotals = parseJsonRecord(engagementSummary?.total);
  const runCounts =
    engagementTotals && Object.keys(engagementTotals).length > 0
      ? normalizeCounts(engagementTotals as Partial<EngagementCounts>)
      : countPerformedActions(performed);

  const activityParts: string[] = [];
  if (performed.length > 0) {
    activityParts.push(`${performed.length} action(s) this run`);
  }
  if (queuedJobs.length > 0) {
    activityParts.push(`${queuedJobs.length} job(s) in queue`);
  }
  if (candidates.length > 0) {
    activityParts.push(`${candidates.length} candidate(s) reviewed`);
  }

  return {
    performed,
    skipped,
    summary: buildRunHeadline(performed, skipped, asOptionalString(report.summary)),
    runCounts,
    countsScope: engagementTotals && Object.keys(engagementTotals).length > 0 ? "lifetime" : "run",
    activityThisRun: activityParts.length > 0 ? activityParts.join(" · ") : undefined
  };
}

function runSortKey(run: AgentHeartbeatRun): number {
  const timestamp = Date.parse(run.finishedAt ?? run.startedAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function mergeRuns(runs: AgentHeartbeatRun[], limit: number): AgentHeartbeatRun[] {
  const byId = new Map<string, AgentHeartbeatRun>();
  for (const run of runs) {
    const existing = byId.get(run.runId);
    if (!existing || runSortKey(run) >= runSortKey(existing)) {
      byId.set(run.runId, run);
    }
  }
  return [...byId.values()].sort((left, right) => runSortKey(right) - runSortKey(left)).slice(0, limit);
}

function normalizeReportRun(
  report: Record<string, unknown>,
  source: AgentHeartbeatRun["source"]
): AgentHeartbeatRun | undefined {
  const runId = asOptionalString(report.runId) ?? asOptionalString(report.run_id);
  const startedAt = asOptionalString(report.startedAt) ?? asOptionalString(report.started_at);
  if (!runId || !startedAt) {
    return undefined;
  }

  const errors = normalizeErrors(report.errors);
  const ingestion = parseJsonRecord(report.ingestion);
  const ingestionParts: string[] = [];
  if (ingestion) {
    if (typeof ingestion.snapshotCount === "number") {
      ingestionParts.push(`${ingestion.snapshotCount} thread snapshots`);
    }
    if (typeof ingestion.sourceItemCount === "number") {
      ingestionParts.push(`${ingestion.sourceItemCount} source items`);
    }
    if (typeof ingestion.discoveryThreadSnapshots === "number") {
      ingestionParts.push(`${ingestion.discoveryThreadSnapshots} discovery threads`);
    }
    if (typeof ingestion.ownThreadSnapshots === "number") {
      ingestionParts.push(`${ingestion.ownThreadSnapshots} own-thread reads`);
    }
  }

  const queuedActionJobs = parseJsonArray(report.queuedActionJobs);

  if (isRedditRuntimeReport(report)) {
    const reddit = extractRedditRunDetails(report);
    return {
      runId,
      phase:
        report.phase === "heartbeat" || report.phase === "executor" ? report.phase : undefined,
      startedAt,
      finishedAt: asOptionalString(report.finishedAt) ?? asOptionalString(report.finished_at),
      status: asOptionalString(report.status) ?? "unknown",
      summary: reddit.summary,
      dryRun: Boolean(report.dryRun ?? report.dry_run),
      errorCount: errors.length || Number(report.error_count) || 0,
      skipCount: reddit.skipped.length,
      runCounts: reddit.runCounts,
      countsScope: reddit.countsScope,
      activityThisRun: reddit.activityThisRun,
      errors,
      skipped: reddit.skipped,
      performed: reddit.performed,
      plannedActions: parseJsonArray<string>(report.plannedActions).map(String),
      queuedActionJobs: queuedActionJobs.length,
      ingestionSummary: ingestionParts.length > 0 ? ingestionParts.join(" · ") : undefined,
      source
    };
  }

  const performed = parseJsonArray<string>(report.performed).map(String);
  const skipped = parseJsonArray<string>(report.skipped).map(String);
  const engagementSummary = parseJsonRecord(report.engagementSummary);
  const engagementTotals = parseJsonRecord(engagementSummary?.total);
  const runCounts =
    engagementTotals && Object.keys(engagementTotals).length > 0
      ? normalizeCounts(engagementTotals as Partial<EngagementCounts>)
      : countPerformedActions(performed);

  return {
    runId,
    phase: report.phase === "heartbeat" || report.phase === "executor" ? report.phase : undefined,
    startedAt,
    finishedAt: asOptionalString(report.finishedAt) ?? asOptionalString(report.finished_at),
    status: asOptionalString(report.status) ?? "unknown",
    summary: buildRunHeadline(performed, skipped, asOptionalString(report.summary)),
    dryRun: Boolean(report.dryRun ?? report.dry_run),
    errorCount: errors.length || Number(report.error_count) || 0,
    skipCount: skipped.length || Number(report.skip_count) || 0,
    runCounts,
    countsScope: engagementTotals && Object.keys(engagementTotals).length > 0 ? "lifetime" : "run",
    errors,
    skipped,
    performed,
    plannedActions: parseJsonArray<string>(report.plannedActions).map(String),
    queuedActionJobs: queuedActionJobs.length,
    ingestionSummary: ingestionParts.length > 0 ? ingestionParts.join(" · ") : undefined,
    source
  };
}

async function readRunsFromJsonl(
  historyPath: string,
  limit: number
): Promise<AgentHeartbeatRun[]> {
  let raw = "";
  try {
    raw = await readFile(historyPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const lines = raw.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const runs: AgentHeartbeatRun[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      const run = normalizeReportRun(parsed as Record<string, unknown>, "jsonl");
      if (run) {
        runs.push(run);
      }
    } catch {
      continue;
    }
  }
  return runs;
}

export async function loadAgentRecentRuns(
  paths: AgentRuntimePaths,
  report: Record<string, unknown> | undefined,
  limit = DEFAULT_RUN_LIMIT
): Promise<AgentHeartbeatRun[]> {
  const historyPath = path.join(paths.runtimeDir, "heartbeat-runs.jsonl");
  const [sqliteRuns, jsonlRuns] = await Promise.all([
    readRecentHeartbeatRunsFromSqlite(paths.storagePath, limit),
    readRunsFromJsonl(historyPath, limit)
  ]);

  const reportRuns: AgentHeartbeatRun[] = [];
  if (report) {
    const normalized = normalizeReportRun(report, "report");
    if (normalized) {
      reportRuns.push(normalized);
    }
  }

  return mergeRuns([...sqliteRuns, ...jsonlRuns, ...reportRuns], limit);
}
