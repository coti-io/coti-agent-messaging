import type { ActionJob } from "./action-planning.js";
import type { GeneratedWriteDecision, WriteCandidate } from "./llm-content.js";
import type { EngagementSummary, PendingWrite, PlannedAction } from "./policy.js";

export interface HeartbeatErrorEntry {
  phase: string;
  message: string;
  name?: string;
}

export interface HeartbeatAlert {
  severity: "warning" | "critical";
  message: string;
}

export interface HeartbeatReport {
  runId: string;
  correlationId: string;
  agentId?: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "ok" | "degraded" | "failed";
  summary?: string;
  dryRun: boolean;
  failureStreak: number;
  alerts: HeartbeatAlert[];
  plannedActions: PlannedAction["type"][];
  performed: string[];
  skipped: string[];
  errors: HeartbeatErrorEntry[];
  reconciledPendingWrites: Array<{
    id: string;
    type: PendingWrite["type"];
    status: "recovered" | "still_pending" | "reconcile_failed" | "expired";
  }>;
  writeCandidates: Array<{
    id: string;
    type: WriteCandidate["type"];
    reason: string;
    targetSummary?: string;
  }>;
  actionCandidates: Array<{
    id: string;
    type: string;
    source: string;
    score: number;
    allowed: boolean;
    needsContent: boolean;
    blockedBy: string[];
  }>;
  selectedActionBundle?: {
    selectedCandidateIds: string[];
    selectedWriteCandidateId?: string;
    selectedNoContentCandidateIds: string[];
    deferredCandidateIds: string[];
    rationale: string;
    debugInputPath?: string;
  };
  queuedActionJobs: Array<{
    id: string;
    type: string;
    candidateId: string;
    status: ActionJob["status"];
    notBefore: string;
  }>;
  selectedWriteDecision?: GeneratedWriteDecision;
  engagementSummary?: EngagementSummary;
  promptRotation?: {
    statePath: string;
    auditPath: string;
    currentScopeKey?: string;
    currentScope?: {
      scopeKey: string;
      currentPromptVariant?: string;
      currentPromptLabel?: string;
      actionsSinceRotation: number;
      rotateAfterActions: number;
      lastRotationAt?: string;
      lastSelectionRationale?: string;
      lastSelectionSource?: string;
      lastSelectedAt?: string;
      lastActionAt?: string;
      lastPublishedAt?: string;
    };
    buckets: Array<{
      scopeKey: string;
      currentPromptVariant?: string;
      currentPromptLabel?: string;
      actionsSinceRotation: number;
      rotateAfterActions: number;
      lastRotationAt?: string;
      lastSelectionRationale?: string;
      lastSelectionSource?: string;
      lastSelectedAt?: string;
      lastActionAt?: string;
      lastPublishedAt?: string;
    }>;
    recentHistory: Array<{
      id: string;
      scopeKey?: string;
      status?: string;
      eventType?: string;
      promptVariantId?: string;
      promptVariantLabel?: string;
      selectionSource?: string;
      reusedExisting?: boolean;
      rotateAfterActions?: number;
      actionsSinceRotation?: number;
      selectionRationale?: string;
      createdAt: string;
      correlationId?: string;
      debugInputPath?: string;
    }>;
  };
}

export interface QueuedWriteJobMetadata {
  kind: "queued_write";
  candidate: WriteCandidate;
  decision: GeneratedWriteDecision;
  successMessage: string;
  failureLabel: string;
  markNotificationsPostId?: string;
}

export const PENDING_WRITE_MAX_RECONCILIATION_MISSES = 3;
