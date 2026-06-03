import type { ActionJob } from "../action-planning.js";
import type { RedditIngestionDiagnostics } from "../reddit-ingestion.js";
import type { RedditDecisionMemoryEntry } from "../reddit-memory.js";
import type { planRedditAction, RedditPlannerFilterSummary } from "../reddit-policy.js";
import type { RedditDuplicateCheckPolicy } from "../reddit-outreach.js";
import type { VenueOutcome } from "../venue.js";

export interface RedditSessionReport {
  generatedAt: string;
  dryRun: boolean;
  duplicateCheckPolicy: RedditDuplicateCheckPolicy;
  readSource: "browser" | "api" | "auto" | "reddapi" | "unofficial";
  memoryPath: string;
  ingestion: {
    snapshotCount: number;
    sourceItemCount: number;
    ownThreadTargets: number;
    ownThreadSnapshots: number;
    discoveryThreadSnapshots: number;
    skipped: string[];
    diagnostics: RedditIngestionDiagnostics;
  };
  planner: {
    skipped: string[];
    blockedGateSample: Array<{ id: string; gates: string[] }>;
    filterSummary?: RedditPlannerFilterSummary;
    sessionLimits?: string[];
    pipeline?: {
      llmDraft: "not_reached" | "failed" | "succeeded";
      selectionSource?: "llm" | "deterministic_fallback";
      upvoteAttempted?: boolean;
      upvoteSucceeded?: boolean;
    };
  };
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
    strategy?: "llm" | "deterministic_fallback";
  };
  queuedActionJobs: Array<{
    id: string;
    type: string;
    candidateId: string;
    status: ActionJob["status"];
    notBefore: string;
  }>;
  decision: ReturnType<typeof planRedditAction>;
  draft?: {
    content: string;
    rationale: string;
  };
  outcome?: VenueOutcome;
  recorded?: RedditDecisionMemoryEntry;
  accountHealth?: {
    status: string;
    username?: string;
    reason: string;
    controller: string;
  };
}

export interface RedditRuntimeReport {
  runId: string;
  correlationId: string;
  phase: "heartbeat" | "executor";
  startedAt: string;
  finishedAt: string;
  status: "ok" | "failed";
  summary: string;
  dryRun: boolean;
  skipped: string[];
  errors: Array<{ phase: string; message: string }>;
  actionCandidates: RedditSessionReport["actionCandidates"];
  selectedActionBundle?: RedditSessionReport["selectedActionBundle"];
  queuedActionJobs: RedditSessionReport["queuedActionJobs"];
  ingestion: RedditSessionReport["ingestion"];
  planner: RedditSessionReport["planner"];
  outcome?: VenueOutcome;
  recorded?: RedditDecisionMemoryEntry;
  accountHealth?: RedditSessionReport["accountHealth"];
}
