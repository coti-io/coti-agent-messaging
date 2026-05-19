import { getOutreachAgentConfig, getRedditControllerConfig, getRedditOperatingAgentConfig, loadRuntimeConfig } from "./config.js";
import { draftRedditResponse } from "./reddit-drafting.js";
import { ingestRedditState } from "./reddit-ingestion.js";
import { appendRedditMemory, loadRedditMemory } from "./reddit-memory.js";
import {
  DEFAULT_REDDIT_OPERATING_RULES,
  DEFAULT_REDDIT_OPERATING_TARGETING,
  planRedditAction
} from "./reddit-policy.js";
import type { RedditDecisionMemoryEntry } from "./reddit-memory.js";
import { createVenueProvider } from "./venue-factory.js";
import type { VenueAction, VenueOutcome } from "./venue.js";
import type { MoltbookRuntimeConfig } from "./config.js";
import type { RedditIngestionResult } from "./reddit-ingestion.js";

export interface RedditSessionReport {
  generatedAt: string;
  dryRun: boolean;
  readSource: "browser" | "api" | "auto";
  memoryPath: string;
  ingestion: {
    snapshotCount: number;
    sourceItemCount: number;
    skipped: string[];
  };
  decision: ReturnType<typeof planRedditAction>;
  draft?: {
    content: string;
    rationale: string;
  };
  outcome?: VenueOutcome;
  recorded?: RedditDecisionMemoryEntry;
}

export async function runRedditSession(input: {
  config?: MoltbookRuntimeConfig;
  dryRun?: boolean;
  maxActions?: number;
  subreddits?: readonly string[];
  once?: boolean;
  fetchImpl?: typeof fetch;
  ingestion?: RedditIngestionResult;
  publishAction?: (action: VenueAction) => Promise<VenueOutcome>;
} = {}): Promise<RedditSessionReport> {
  const config = input.config ?? await loadRuntimeConfig({ requireVenue: true });
  const agent = getOutreachAgentConfig(config);
  if (agent.venue !== "reddit") {
    throw new Error("reddit-session requires OUTREACH_AGENT_VENUE=reddit.");
  }
  const operating = getRedditOperatingAgentConfig(config);
  const dryRun = input.dryRun ?? operating.dryRunDefault;
  const maxActions = input.maxActions ?? operating.maxActionsPerSession;
  const memory = await loadRedditMemory(operating.memoryPath);
  const recentKillReason = findKillSwitch(memory.history);
  if (recentKillReason) {
    const decision = { skipped: [recentKillReason], candidates: [] };
    return {
      generatedAt: new Date().toISOString(),
      dryRun,
      readSource: operating.readController,
      memoryPath: operating.memoryPath,
      ingestion: { snapshotCount: 0, sourceItemCount: 0, skipped: [] },
      decision
    };
  }

  const ingestion = input.ingestion ?? await ingestRedditState({
    config,
    subreddits:
      input.subreddits?.length
        ? input.subreddits
        : operating.targetSubreddits.length > 0
          ? operating.targetSubreddits
          : undefined,
    queries: operating.searchQueries.length > 0 ? operating.searchQueries : undefined,
    history: memory.history,
    source: operating.readController
  });
  const decision = planRedditAction({
    items: ingestion.sourceItems,
    history: memory.history,
    targeting: DEFAULT_REDDIT_OPERATING_TARGETING,
    registry: DEFAULT_REDDIT_OPERATING_RULES,
    config: {
      maxActionsPerSession: maxActions,
      minDelayMinutes: operating.minJitterMinutes,
      maxDelayMinutes: operating.maxJitterMinutes
    }
  });

  if (!decision.action || maxActions < 1) {
    return {
      generatedAt: new Date().toISOString(),
      dryRun,
      readSource: operating.readController,
      memoryPath: operating.memoryPath,
      ingestion: {
        snapshotCount: ingestion.snapshots.length,
        sourceItemCount: ingestion.sourceItems.length,
        skipped: ingestion.skipped
      },
      decision
    };
  }

  const draft = await draftRedditResponse({
    config,
    item: decision.action.item,
    targeting: DEFAULT_REDDIT_OPERATING_TARGETING,
    recentContent: memory.history.slice(-20).map((entry) => entry.content),
    fetchImpl: input.fetchImpl
  });
  const action = toVenueAction(decision.action, draft.content);
  let outcome: VenueOutcome | undefined;
  if (!dryRun) {
    outcome = input.publishAction
      ? await input.publishAction(action)
      : await createVenueProvider(config).publishAction(action);
  }

  const recorded: RedditDecisionMemoryEntry = {
    id: `${dryRun ? "draft" : "outcome"}:${decision.action.item.source.id}:${Date.now()}`,
    decisionId: decision.action.item.id,
    subreddit: decision.action.item.source.subreddit,
    kind: decision.action.type === "reply_to_comment" ? "reply" : "comment",
    action: dryRun
      ? "skipped"
      : decision.action.type === "reply_to_comment"
        ? "replied"
        : "commented",
    content: draft.content,
    createdAt: new Date().toISOString(),
    targetId: decision.action.item.source.id,
    targetSummary: decision.action.item.source.body ?? decision.action.item.source.title,
    status: dryRun ? "drafted" : "posted",
    firstReply: true,
    productMentioned: false,
    linkIncluded: false,
    structuralFingerprint: structuralFingerprint(draft.content),
    controller: getRedditControllerConfig(config).controller,
    decisionReason: decision.action.reason,
    relevanceScore: decision.action.item.relevanceScore,
    riskScore: decision.action.item.riskScore,
    remoteContentUrl: outcome?.remoteContentUrl
  };
  await appendRedditMemory(operating.memoryPath, recorded);

  return {
    generatedAt: new Date().toISOString(),
    dryRun,
    readSource: operating.readController,
    memoryPath: operating.memoryPath,
    ingestion: {
      snapshotCount: ingestion.snapshots.length,
      sourceItemCount: ingestion.sourceItems.length,
      skipped: ingestion.skipped
    },
    decision,
    draft,
    outcome,
    recorded
  };
}

function toVenueAction(
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

function findKillSwitch(history: readonly RedditDecisionMemoryEntry[]): string | undefined {
  const recent = history.slice(-50);
  if (recent.some((entry) => entry.status === "banned")) {
    return "Kill switch: a ban was recorded in Reddit memory.";
  }
  if (recent.filter((entry) => entry.status === "spam_accusation").length > 0) {
    return "Kill switch: spam accusation recorded in Reddit memory.";
  }
  if (recent.filter((entry) => entry.status === "removed" || entry.status === "mod_warning").length >= 2) {
    return "Kill switch: repeated removals or mod warnings recorded in Reddit memory.";
  }
  return undefined;
}

function structuralFingerprint(content: string): string {
  return (content.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).slice(0, 20).join("-");
}

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

export async function runRedditSessionCli(): Promise<void> {
  const subreddits = getArg("--subreddits")?.split(",").map((entry) => entry.trim()).filter(Boolean);
  const maxActions = Number(getArg("--max-actions") ?? "1");
  const report = await runRedditSession({
    dryRun: hasFlag("--dry-run") ? true : hasFlag("--live") ? false : undefined,
    maxActions: Number.isFinite(maxActions) && maxActions >= 0 ? maxActions : 1,
    subreddits,
    once: hasFlag("--once")
  });
  console.log(JSON.stringify(report, null, 2));
}
