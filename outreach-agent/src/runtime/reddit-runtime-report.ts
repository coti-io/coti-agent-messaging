import type { EngagementSummary } from "../policy.js";
import type { StoredHeartbeatRun } from "../storage.js";

export interface RedditRuntimeReportLike {
  runId: string;
  correlationId?: string;
  phase: "heartbeat" | "executor";
  startedAt: string;
  finishedAt: string;
  status: "ok" | "failed";
  summary: string;
  dryRun: boolean;
  skipped?: string[];
  errors?: Array<{ phase: string; message: string }>;
  engagementSummary?: EngagementSummary;
}

export function redditRuntimeReportToStoredRun(report: RedditRuntimeReportLike): StoredHeartbeatRun {
  return {
    runId: report.runId,
    correlationId: report.correlationId,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    status: report.status === "ok" ? "ok" : "failed",
    summary: report.summary,
    dryRun: report.dryRun,
    plannedActions: [report.phase],
    performed: [],
    skipped: report.skipped ?? [],
    errors: report.errors ?? [],
    reconciledPendingWrites: [],
    writeCandidates: [],
    engagementSummary: report.engagementSummary
  };
}
