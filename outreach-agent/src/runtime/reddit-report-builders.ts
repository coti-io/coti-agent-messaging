import { getRedditOperatingAgentConfig } from "../config.js";
import { buildRedditActionCandidates, chooseRedditActionBundle } from "../reddit-action-planning.js";
import { summarizeActionJobs } from "../job-queue.js";
import type { RedditMemoryStore } from "../reddit-memory.js";
import { parseRedditThreadUrl, type RedditIngestionResult } from "../reddit-ingestion.js";
import { planRedditAction, type RedditPlannerFilterSummary } from "../reddit-policy.js";
import type { RedditDuplicateCheckPolicy } from "../reddit-outreach.js";
import type { RedditAccountHealth } from "../reddit-account-health.js";
import type { VenueAction } from "../venue.js";
import type { RedditSessionReport } from "./reddit-types.js";

export function resolveRedditSessionDuplicateCheckPolicy(dryRun: boolean): RedditDuplicateCheckPolicy {
  if (!dryRun) {
    return "block_posted_only";
  }
  const configured = process.env.OUTREACH_REDDIT_DRY_RUN_DUPLICATE_POLICY?.trim();
  if (configured === "block_all_outbound" || configured === "block_posted_only") {
    return configured;
  }
  return "block_posted_only";
}

export function summarizeIngestion(ingestion: RedditIngestionResult): RedditSessionReport["ingestion"] {
  return {
    snapshotCount: ingestion.snapshots.length,
    sourceItemCount: ingestion.sourceItems.length,
    ownThreadTargets: ingestion.ownThreadTargets,
    ownThreadSnapshots: ingestion.ownThreadSnapshots,
    discoveryThreadSnapshots: ingestion.discoveryThreadSnapshots,
    skipped: ingestion.skipped,
    diagnostics: ingestion.diagnostics
  };
}

export function emptyIngestionSummary(): RedditSessionReport["ingestion"] {
  return {
    snapshotCount: 0,
    sourceItemCount: 0,
    ownThreadTargets: 0,
    ownThreadSnapshots: 0,
    discoveryThreadSnapshots: 0,
    skipped: [],
    diagnostics: {
      discoverySubredditPool: [],
      sampledSubreddits: [],
      subreddits: [],
      discoverySearchQueries: [],
      discoveryListingSorts: [],
      discoveryListingPages: [],
      discoverySearchPages: [],
      excludedThreadPostIds: [],
      scanLedgerSkippedScrapes: 0,
      discoveryPickStrategy: "stochastic",
      browserHeadless: false,
      readViaBrowser: false,
      readViaReddapi: false,
      readViaUnofficial: false
    }
  };
}

export function summarizePlanner(input: {
  skipped: string[];
  candidates?: Array<{ id: string }>;
  filterSummary?: RedditPlannerFilterSummary;
  sessionLimits?: string[];
  pipeline?: RedditSessionReport["planner"]["pipeline"];
}): RedditSessionReport["planner"] {
  const blockedGateSample = input.skipped
    .filter((entry) => entry.includes("blocked by"))
    .slice(0, 12)
    .map((entry) => {
      const separator = ": blocked by ";
      const separatorIndex = entry.indexOf(separator);
      if (separatorIndex === -1) {
        return { id: entry, gates: [] as string[] };
      }
      const id = entry.slice(0, separatorIndex);
      const gates = entry
        .slice(separatorIndex + separator.length)
        .split(",")
        .map((gate) => gate.trim())
        .filter(Boolean);
      return { id, gates };
    });
  return {
    skipped: input.skipped,
    blockedGateSample,
    filterSummary: input.filterSummary,
    sessionLimits: input.sessionLimits?.length ? input.sessionLimits : undefined,
    pipeline: input.pipeline
  };
}

export function resolveThreadPostId(
  planned: NonNullable<ReturnType<typeof planRedditAction>["action"]>,
  remoteContentUrl?: string
): string | undefined {
  const fromUrl = remoteContentUrl ? parseRedditThreadUrl(remoteContentUrl)?.postId : undefined;
  if (fromUrl) {
    return fromUrl;
  }
  if (planned.item.source.threadPostId) {
    return planned.item.source.threadPostId;
  }
  if (planned.item.source.kind === "post") {
    return planned.item.source.id;
  }
  const fromPermalink = planned.item.source.permalink
    ? parseRedditThreadUrl(planned.item.source.permalink)?.postId
    : undefined;
  return fromPermalink;
}

export function summarizeActionCandidates(
  candidates: ReturnType<typeof buildRedditActionCandidates>
): RedditSessionReport["actionCandidates"] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    type: candidate.type,
    source: candidate.source,
    score: candidate.score,
    allowed: candidate.allowed,
    needsContent: candidate.needsContent,
    blockedBy: candidate.constraints.filter((constraint) => !constraint.passed).map((constraint) => constraint.id)
  }));
}

export function summarizeQueuedRedditJobs(store: Pick<RedditMemoryStore, "queuedJobs">): RedditSessionReport["queuedActionJobs"] {
  return summarizeActionJobs(store.queuedJobs ?? []);
}

export function toVenueAction(
  planned: NonNullable<ReturnType<typeof planRedditAction>["action"]>,
  content: string
): VenueAction {
  const source = planned.item.source;
  return {
    id: planned.item.id,
    venue: "reddit",
    type: planned.type,
    candidateId: planned.type === "reply_to_comment" ? source.id : undefined,
    parentId: planned.type === "comment_on_post" ? source.id : undefined,
    surface: source.subreddit,
    content,
    raw: {
      permalink: source.permalink,
      url: source.url,
      reason: planned.reason
    }
  };
}

export function buildRedditBlockedSessionReport(input: {
  now: Date;
  dryRun: boolean;
  duplicateCheckPolicy: RedditDuplicateCheckPolicy;
  operating: ReturnType<typeof getRedditOperatingAgentConfig>;
  memory: RedditMemoryStore;
  decision: ReturnType<typeof planRedditAction>;
  maxActions: number;
  sessionLimits?: string[];
  pipeline: { llmDraft: "not_reached" | "failed" | "succeeded" };
  accountHealth?: RedditAccountHealth;
}): RedditSessionReport {
  return {
    generatedAt: input.now.toISOString(),
    dryRun: input.dryRun,
    duplicateCheckPolicy: input.duplicateCheckPolicy,
    readSource: input.operating.readController,
    memoryPath: input.operating.memoryPath,
    ingestion: emptyIngestionSummary(),
    actionCandidates: [],
    selectedActionBundle: chooseRedditActionBundle([], input.maxActions),
    queuedActionJobs: summarizeQueuedRedditJobs(input.memory),
    planner: summarizePlanner({
      skipped: input.decision.skipped,
      filterSummary: input.decision.filterSummary,
      sessionLimits: input.sessionLimits,
      pipeline: input.pipeline
    }),
    decision: input.decision,
    accountHealth: input.accountHealth
      ? {
          status: input.accountHealth.status,
          username: input.accountHealth.username,
          reason: input.accountHealth.reason,
          controller: input.accountHealth.controller
        }
      : undefined
  };
}

export function structuralFingerprint(content: string): string {
  return (content.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).slice(0, 20).join("-");
}

export function shouldPublishQueuedActionImmediately(): boolean {
  return process.env.OUTREACH_REDDIT_PUBLISH_IMMEDIATELY?.trim() === "true";
}

export function parseDiscoverySeedFromEnv(): number | undefined {
  const raw = process.env.OUTREACH_REDDIT_DISCOVERY_SEED?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
