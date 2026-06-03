import { readFile } from "node:fs/promises";

import { getOutreachAgentConfig, getRedditControllerConfig, getRedditOperatingAgentConfig, type MoltbookRuntimeConfig } from "../config.js";
import { appendHeartbeatRunHistory } from "../heartbeat-run-history.js";
import { loadRedditMemory, writeJsonAtomic, type RedditDecisionMemoryEntry } from "../reddit-memory.js";
import { createRuntimePorts } from "./create-runtime-ports.js";
import { buildAnalyticsReadModelFromStorage } from "./analytics-read-model.js";
import { redditRuntimeReportToStoredRun } from "./reddit-runtime-report.js";
import { createRedditRuntimeStore } from "./reddit-runtime-store.js";
import type { RedditRuntimeReport, RedditSessionReport } from "./reddit-types.js";
import {
  emptyIngestionSummary,
  summarizePlanner
} from "./reddit-planner-support.js";

export type { RedditRuntimeReport } from "./reddit-types.js";

export function buildRedditRuntimeReport(input: {
  phase: "heartbeat" | "executor";
  correlationId: string;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  report?: RedditSessionReport;
  status: "ok" | "failed";
  skipped: string[];
  errors: Array<{ phase: string; message: string }>;
}): RedditRuntimeReport {
  const baseReport = input.report;
  const skipped = [
    ...(baseReport?.decision.skipped ?? []),
    ...input.skipped
  ];
  return {
    runId: `${input.phase}:${input.finishedAt}:${process.pid}`,
    correlationId: input.correlationId,
    phase: input.phase,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status: input.status,
    summary: summarizeRedditRuntimeReport(input.phase, input.status, skipped, input.errors),
    dryRun: input.dryRun,
    skipped,
    errors: input.errors,
    actionCandidates: baseReport?.actionCandidates ?? [],
    selectedActionBundle: baseReport?.selectedActionBundle,
    queuedActionJobs: baseReport?.queuedActionJobs ?? [],
    ingestion: baseReport?.ingestion ?? emptyIngestionSummary(),
    planner: baseReport?.planner ?? summarizePlanner({ skipped }),
    outcome: baseReport?.outcome,
    recorded: baseReport?.recorded,
    accountHealth: baseReport?.accountHealth
  };
}

function summarizeRedditRuntimeReport(
  phase: "heartbeat" | "executor",
  status: "ok" | "failed",
  skipped: readonly string[],
  errors: ReadonlyArray<{ phase: string; message: string }>
): string {
  if (status === "failed") {
    return `${phase.toUpperCase()}_FAILED - ${errors[0]?.message ?? "unknown error"}`;
  }
  if (skipped.length === 0) {
    return `${phase.toUpperCase()}_OK - Reddit runtime idle.`;
  }
  return `${phase.toUpperCase()}_OK - ${skipped.join(" ")}`;
}

export async function persistRedditHeartbeatReport(
  config: MoltbookRuntimeConfig,
  report: RedditRuntimeReport
): Promise<void> {
  const operating = getRedditOperatingAgentConfig(config);
  const store = await loadRedditMemory(operating.memoryPath);
  const engagementSummary = summarizeRedditHistory(store.history, new Date(report.finishedAt));
  const enrichedReport = {
    ...report,
    engagementSummary
  };
  const ports = createRuntimePorts(config);
  await ports.runs.persistRun(redditRuntimeReportToStoredRun(enrichedReport));
  await ports.runs.writeLatestReport(enrichedReport);
  await appendHeartbeatRunHistory(config.heartbeatReportPath, enrichedReport);
  const agent = getOutreachAgentConfig(config);
  await ports.analytics.write(
    await buildAnalyticsReadModelFromStorage({
      statePath: config.statePath,
      heartbeatReportPath: config.heartbeatReportPath,
      venue: "reddit",
      venueAccountId: agent.venueAccountId,
      agentId: config.agentId,
      runtimeKind: report.phase === "executor" ? "executor" : "heartbeat",
      redditMemoryPath: operating.memoryPath,
      attributionDbPath: config.attributionDbPath,
      latestRun: {
        runId: report.runId,
        correlationId: report.correlationId,
        phase: report.phase,
        status: report.status,
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        summary: report.summary
      }
    })
  );
}

export async function persistRedditRuntimeSnapshot(
  config: MoltbookRuntimeConfig,
  input: {
    phase: "heartbeat" | "executor";
    finishedAt: string;
    status: "ok" | "failed";
  }
): Promise<void> {
  const operating = getRedditOperatingAgentConfig(config);
  const controller = getRedditControllerConfig(config);
  const store = await createRedditRuntimeStore(config).load();
  const previousState = await readOptionalJsonRecord(config.statePath);
  const engagementSummary = summarizeRedditHistory(store.history, new Date(input.finishedAt));
  const recentGeneratedArtifacts = store.history
    .filter((entry) => entry.status === "posted" || entry.status === "spam_filtered")
    .slice(-20)
    .map((entry) => ({
      id: entry.id,
      type: entry.kind,
      createdAt: entry.createdAt,
      title: entry.kind === "post" ? entry.targetTitle : undefined,
      content: entry.content,
      targetSummary: entry.targetSummary ?? entry.targetTitle,
      promptProfileId: entry.promptProfileId,
      promptVariantId: entry.promptVariantId,
      promptVariantRationale: entry.promptVariantRationale,
      promptParameters: entry.promptParameters,
      layout: entry.layout,
      outreachRef: entry.remoteContentUrl
        ? {
            remoteContentUrl: entry.remoteContentUrl
          }
        : undefined
    }));
  const latestComment = [...store.history]
    .filter((entry) => isRedditPublishedHistoryEntry(entry) && (entry.kind === "comment" || entry.kind === "reply"))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  const latestPost = [...store.history]
    .filter((entry) => isRedditPublishedHistoryEntry(entry) && entry.kind === "post")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];

  await createRedditRuntimeStore(config).syncQueuedJobs(store);
  await writeJsonAtomic(config.statePath, {
    ...previousState,
    generatedAt: input.finishedAt,
    venue: "reddit",
    controller: controller.controller,
    readSource: operating.readController,
    memoryPath: operating.memoryPath,
    queuedActionJobs: store.queuedJobs ?? [],
    engagementEvents: buildRedditEngagementEvents(store.history),
    engagementTotals: engagementSummary.total,
    recentGeneratedArtifacts,
    lastCommentAt: latestComment?.createdAt,
    lastPostAt: latestPost?.createdAt,
    ...(input.phase === "heartbeat"
      ? {
          lastHeartbeatAt: input.finishedAt,
          latestStatus: input.status
        }
      : {
          lastExecutorAt: input.finishedAt,
          lastExecutorStatus: input.status
        })
  });
}

async function readOptionalJsonRecord(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function buildRedditEngagementEvents(history: readonly RedditDecisionMemoryEntry[]) {
  return history
    .filter((entry) => isRedditPublishedHistoryEntry(entry))
    .map((entry) => ({
      type: entry.kind,
      createdAt: entry.createdAt
    }));
}

export function summarizeRedditHistory(history: readonly RedditDecisionMemoryEntry[], now: Date) {
  const countsSince = (durationMs: number) => countRedditKinds(
    history.filter((entry) => {
      if (!isRedditPublishedHistoryEntry(entry)) {
        return false;
      }
      const createdAt = Date.parse(entry.createdAt);
      return !Number.isNaN(createdAt) && now.getTime() - createdAt <= durationMs;
    })
  );
  return {
    generatedAt: now.toISOString(),
    windows: {
      last2Hours: countsSince(2 * 60 * 60 * 1_000),
      lastDay: countsSince(24 * 60 * 60 * 1_000),
      lastWeek: countsSince(7 * 24 * 60 * 60 * 1_000)
    },
    total: countRedditKinds(history.filter((entry) => isRedditPublishedHistoryEntry(entry)))
  };
}

function countRedditKinds(history: readonly RedditDecisionMemoryEntry[]) {
  const counts = {
    posts: 0,
    comments: 0,
    replies: 0,
    upvotes: 0,
    follows: 0,
    total: 0
  };
  for (const entry of history) {
    if (entry.kind === "upvote" || entry.action === "upvoted") {
      counts.upvotes += 1;
    } else if (entry.kind === "post") {
      counts.posts += 1;
    } else if (entry.kind === "comment") {
      counts.comments += 1;
    } else if (entry.kind === "reply") {
      counts.replies += 1;
    }
  }
  counts.total = counts.posts + counts.comments + counts.replies + counts.upvotes;
  return counts;
}

function isRedditPublishedHistoryEntry(entry: RedditDecisionMemoryEntry): boolean {
  return entry.status !== "drafted" && entry.action !== "skipped";
}
