import type { EngagementSummary } from "../policy.js";
import type { StoredHeartbeatRun } from "../storage.js";

export interface HeartbeatReportLike {
  runId: string;
  correlationId?: string;
  agentId?: string;
  startedAt: string;
  finishedAt?: string;
  status: StoredHeartbeatRun["status"];
  summary?: string;
  dryRun: boolean;
  plannedActions?: string[];
  performed?: string[];
  skipped?: string[];
  errors?: unknown[];
  reconciledPendingWrites?: unknown[];
  writeCandidates?: unknown[];
  selectedWriteDecision?: unknown;
  engagementSummary?: EngagementSummary;
}

export function heartbeatReportToStoredRun(report: HeartbeatReportLike): StoredHeartbeatRun {
  return {
    runId: report.runId,
    correlationId: report.correlationId,
    agentId: report.agentId,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    status: report.status,
    summary: report.summary,
    dryRun: report.dryRun,
    plannedActions: report.plannedActions ?? [],
    performed: report.performed ?? [],
    skipped: report.skipped ?? [],
    errors: report.errors ?? [],
    reconciledPendingWrites: report.reconciledPendingWrites ?? [],
    writeCandidates: report.writeCandidates ?? [],
    selectedWriteDecision: report.selectedWriteDecision,
    engagementSummary: report.engagementSummary
  };
}
