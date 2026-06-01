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

const REDDIT_BLOCKED_BY_MARKER = ": blocked by ";
const REDDIT_GATE_LABELS: Record<string, string> = {
  clear_user_need: "No explicit help intent or operational pain",
  discovery_topical_fit: "Off-topic for agent-messaging discovery",
  safe_draft_generated: "No safe explanatory draft",
  low_argument_risk: "Hostile or bait thread",
  low_spam_topic_risk: "Spam or promo topic",
  not_near_duplicate: "Too similar to prior outbound",
  not_redundant_with_thread: "Too similar to thread comments",
  subreddit_daily_limit: "Subreddit daily reply cap",
  global_daily_limit: "Global daily reply cap",
  prompt_profile_safety: "Draft failed prompt safety checks",
  no_product_or_company_mention: "Draft mentioned product or company",
  no_links: "Draft contained links",
  no_cta_or_dm_prompt: "Draft contained CTA or DM prompt",
  subreddit_rules_registered: "Missing subreddit rules entry",
  subreddit_not_blocked: "Subreddit blocked for outreach"
};

function humanizeRedditGate(gate: string): string {
  return REDDIT_GATE_LABELS[gate] ?? gate.replaceAll("_", " ");
}

function isPerItemBlockedSkipLine(line: string): boolean {
  return line.includes(REDDIT_BLOCKED_BY_MARKER);
}

function parseBlockedSkipLine(line: string): { id: string; gates: string[] } | undefined {
  const markerIndex = line.indexOf(REDDIT_BLOCKED_BY_MARKER);
  if (markerIndex === -1) {
    return undefined;
  }
  const id = line.slice(0, markerIndex).trim();
  const gates = line
    .slice(markerIndex + REDDIT_BLOCKED_BY_MARKER.length)
    .split(",")
    .map((gate) => gate.trim())
    .filter(Boolean);
  if (!id || gates.length === 0) {
    return undefined;
  }
  return { id, gates };
}

function aggregateGateCountsFromSkipLines(lines: readonly string[]): Array<{ gate: string; count: number }> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const parsed = parseBlockedSkipLine(line);
    if (!parsed) {
      continue;
    }
    for (const gate of parsed.gates) {
      counts.set(gate, (counts.get(gate) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([gate, count]) => ({ gate, count }))
    .sort((left, right) => right.count - left.count || left.gate.localeCompare(right.gate));
}

function splitRedditSkipLines(lines: readonly string[]): {
  perItemBlocked: string[];
  perItemRequires: string[];
  operational: string[];
} {
  const perItemBlocked: string[] = [];
  const perItemRequires: string[] = [];
  const operational: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (/^requires /u.test(trimmed) || /: requires /u.test(trimmed)) {
      perItemRequires.push(trimmed);
      continue;
    }
    if (isPerItemBlockedSkipLine(trimmed)) {
      perItemBlocked.push(trimmed);
      continue;
    }
    operational.push(trimmed);
  }
  return { perItemBlocked, perItemRequires, operational };
}

function parseRequiresSkipLine(line: string): string | undefined {
  const marker = ": requires ";
  const markerIndex = line.indexOf(marker);
  if (markerIndex === -1) {
    return undefined;
  }
  return line.slice(markerIndex + marker.length).trim().replaceAll("_", " ");
}

function aggregateRequiresActionCounts(lines: readonly string[]): Array<{ action: string; count: number }> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const action = parseRequiresSkipLine(line);
    if (!action) {
      continue;
    }
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([action, count]) => ({ action, count }))
    .sort((left, right) => right.count - left.count || left.action.localeCompare(right.action));
}

function extractLlmDraftFailureReason(operational: readonly string[]): string | undefined {
  for (const line of operational) {
    const nested = line.match(/after \d+ LLM attempts: (.+)$/u);
    if (nested?.[1]) {
      return nested[1].trim();
    }
    if (line.startsWith("LLM draft failed: ")) {
      return line.slice("LLM draft failed: ".length).trim();
    }
  }
  return undefined;
}

function explainLlmDraftFailure(reason: string | undefined): string {
  const normalized = reason?.trim() ?? "";
  if (normalized.includes("hook-style draft must open briefly")) {
    return "OpenRouter wrote a reply 3 times, but validation rejected each draft: the prompt uses a hook-then-detail layout, so the comment must start with a brief opener and then add concrete helpful detail. Fluff-only or one-liners fail. Nothing was queued or posted.";
  }
  if (normalized.includes("too fluffy")) {
    return "OpenRouter wrote a reply, but validation rejected it as too fluffy — Reddit drafts need concrete operational detail, not generic praise. Nothing was queued or posted.";
  }
  if (normalized.includes("exceeds") && normalized.includes("length limit")) {
    return `OpenRouter wrote a reply, but validation rejected it for length: ${normalized}. Nothing was queued or posted.`;
  }
  if (normalized.length > 0) {
    return `OpenRouter wrote a reply, but validation rejected it: ${normalized}. Nothing was queued or posted.`;
  }
  return "OpenRouter wrote a reply, but validation rejected it before queue/post. Nothing was queued or posted.";
}

function explainRequiresAction(action: string, count: number): string {
  if (action === "ask clarifying question") {
    return `${count} thread(s) looked relevant but had no clear question or operational pain — policy says do not public-reply yet (would need a clarifying question first). MVP does not auto-post these; they can reappear on later ingests.`;
  }
  if (action === "contact mods") {
    return `${count} thread(s) need mod contact before outreach — skipped for auto-post.`;
  }
  return `${count} thread(s) marked "${action}" — not eligible for auto-post this run.`;
}

function explainDeferredCandidates(count: number): string {
  return `${count} other target(s) also passed filters this run but were not chosen — hard cap is 1 action per heartbeat. They are not saved to a queue; each must win the picker again on a future run if still ingested.`;
}

function buildRedditRunNotes(input: {
  operational: readonly string[];
  perItemRequires: readonly string[];
  deferredCount: number;
  pipeline?: Record<string, unknown>;
  filterSummary?: Record<string, unknown>;
}): string[] {
  const notes: string[] = [];

  if (input.pipeline?.llmDraft === "failed" || extractLlmDraftFailureReason(input.operational)) {
    notes.push(explainLlmDraftFailure(extractLlmDraftFailureReason(input.operational)));
  }

  const requiresFromSummary = parseJsonArray<Record<string, unknown>>(
    input.filterSummary?.nonPublicActionCounts
  );
  const clarifyFromSummary = requiresFromSummary.find(
    (entry) => asOptionalString(entry.action) === "ask_clarifying_question"
  );
  const clarifyCount =
    Number(clarifyFromSummary?.count ?? 0) ||
    aggregateRequiresActionCounts(input.perItemRequires).find((entry) => entry.action === "ask clarifying question")
      ?.count ||
    0;
  if (clarifyCount > 0) {
    notes.push(explainRequiresAction("ask clarifying question", clarifyCount));
  }

  for (const entry of aggregateRequiresActionCounts(input.perItemRequires)) {
    if (entry.action === "ask clarifying question") {
      continue;
    }
    notes.push(explainRequiresAction(entry.action, entry.count));
  }

  if (input.deferredCount > 0) {
    notes.push(explainDeferredCandidates(input.deferredCount));
  }

  for (const line of input.operational) {
    if (/draft generation failed|LLM draft failed/u.test(line)) {
      continue;
    }
    if (/^Deferred \d+/u.test(line)) {
      continue;
    }
    const normalized = line.trim();
    if (
      normalized.includes("cooldown") ||
      normalized.includes("daily") ||
      normalized.includes("kill switch") ||
      normalized.includes("Executed one queued")
    ) {
      notes.push(normalized);
    }
  }

  return uniqueStrings(notes);
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
  const subreddit = asOptionalString(source?.subreddit) ?? id.split(":")[1];
  const title = asOptionalString(source?.title);
  const target = subreddit ? `r/${subreddit}` : id;
  const blockedBy = parseJsonArray<string>(candidate.blockedBy).map(String);
  const blockingGates = blockedBy.filter((gate) => !["product_follow_up_requires_explicit_interest", "pm_only_when_needed", "human_review_required"].includes(gate));
  const headline = title ? `${type} on ${target} — "${title}"` : `${type} on ${target}`;
  if (candidate.allowed === false && blockingGates.length > 0) {
    return `${headline} (blocked: ${blockingGates.map(humanizeRedditGate).join(", ")})`;
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

function formatFilterCategory(category: string | undefined): string {
  return category ? category.replaceAll("_", " ") : "other";
}

function formatGateBreakdownLine(gate: string, count: number, category?: string): string {
  const label = humanizeRedditGate(gate);
  const categorySuffix = category ? ` · ${formatFilterCategory(category)}` : "";
  return `${count}× ${label}${categorySuffix}`;
}

function buildRedditFilteringSummary(
  planner: Record<string, unknown> | undefined,
  bundle: Record<string, unknown> | undefined,
  candidates: readonly Record<string, unknown>[],
  plannerSkipped: readonly string[]
): string[] {
  const lines: string[] = [];
  const filterSummary = parseJsonRecord(planner?.filterSummary);
  const pipeline = parseJsonRecord(planner?.pipeline);
  const { perItemBlocked } = splitRedditSkipLines(plannerSkipped);

  if (filterSummary) {
    const sourceItemCount = Number(filterSummary.sourceItemCount ?? 0);
    const inTargetSubredditCount = Number(filterSummary.inTargetSubredditCount ?? 0);
    const outOfTargetSubredditCount = Number(filterSummary.outOfTargetSubredditCount ?? 0);
    const reviewedCount = Number(filterSummary.reviewedCount ?? 0);
    const blockedCount = Number(filterSummary.blockedCount ?? 0);
    const plannedCandidateCount = Number(filterSummary.plannedCandidateCount ?? 0);

    lines.push(
      `Pipeline: ${sourceItemCount} ingested → ${plannedCandidateCount} passed picker (${blockedCount} blocked, ${reviewedCount} reviewed)`
    );

    if (outOfTargetSubredditCount > 0 && inTargetSubredditCount === 0) {
      lines.push("Planner subs did not match ingested subs — check OUTREACH_REDDIT_TARGET_SUBREDDITS.");
    } else if (outOfTargetSubredditCount > 0) {
      lines.push(`${outOfTargetSubredditCount} ingested item(s) were outside configured planner subs.`);
    }

    const blockedByGate = parseJsonArray<Record<string, unknown>>(filterSummary.blockedByGate);
    if (blockedByGate.length > 0) {
      lines.push("Block reasons:");
      for (const entry of blockedByGate.slice(0, 6)) {
        const gate = asOptionalString(entry.gate);
        const count = Number(entry.count ?? 0);
        if (!gate || count <= 0) {
          continue;
        }
        lines.push(`  ${formatGateBreakdownLine(gate, count, asOptionalString(entry.category))}`);
      }
    }

    const nonPublicActionCounts = parseJsonArray<Record<string, unknown>>(
      filterSummary.nonPublicActionCounts
    );
    for (const entry of nonPublicActionCounts.slice(0, 3)) {
      const action = asOptionalString(entry.action);
      const count = Number(entry.count ?? 0);
      if (!action || count <= 0) {
        continue;
      }
      if (action === "ask_clarifying_question") {
        lines.push(`${count} thread(s) need clarifying question before a public reply (see Notes)`);
      } else {
        lines.push(`${count} thread(s) marked "${action.replaceAll("_", " ")}" instead of a public reply`);
      }
    }
  } else if (perItemBlocked.length > 0) {
    lines.push(`Pipeline: ${perItemBlocked.length} item(s) blocked during review`);
    lines.push("Block reasons:");
    for (const entry of aggregateGateCountsFromSkipLines(perItemBlocked).slice(0, 6)) {
      lines.push(`  ${formatGateBreakdownLine(entry.gate, entry.count)}`);
    }
  } else if (candidates.length === 0) {
    lines.push("No items reached the action candidate stage.");
  }

  for (const limit of parseJsonArray<string>(planner?.sessionLimits).map(String)) {
    lines.push(`Session limit: ${limit}`);
  }

  if (pipeline?.llmDraft === "not_reached") {
    lines.push("LLM: not reached — no target was selected for draft generation.");
  } else if (pipeline?.llmDraft === "failed") {
    lines.push("LLM: draft generation ran for the selected target but failed validation (see Notes).");
  } else if (pipeline?.llmDraft === "succeeded") {
    const selectionSource = asOptionalString(pipeline.selectionSource);
    lines.push(`LLM: draft generated${selectionSource ? ` (${selectionSource})` : ""}.`);
  }

  const rationale = asOptionalString(bundle?.rationale);
  if (rationale && lines.length === 0) {
    lines.push(rationale);
  }

  return uniqueStrings(lines);
}

function buildRedditRunHeadline(input: {
  performed: readonly string[];
  operationalSkipped: readonly string[];
  filterSummary?: Record<string, unknown>;
  pipeline?: Record<string, unknown>;
  bundleRationale?: string;
}): string {
  const posted = input.performed.find((entry) => /^(Posted|Recorded|Queued)/u.test(entry));
  if (posted) {
    return posted;
  }

  const selected = input.performed.find((entry) => entry.startsWith("Selected "));
  const llmFailed = input.pipeline?.llmDraft === "failed";
  const llmFailure = extractLlmDraftFailureReason(input.operationalSkipped);
  if (llmFailed || llmFailure) {
    const target = selected?.match(/on (r\/[^ ]+|post:[^ ]+)/u)?.[1] ?? "selected target";
    return `Draft rejected for ${target} — OpenRouter reply failed validation`;
  }

  if (selected) {
    return selected.replace(/^Selected /u, "Picked ");
  }

  const blockedCount = Number(input.filterSummary?.blockedCount ?? 0);
  const reviewedCount = Number(input.filterSummary?.reviewedCount ?? 0);
  const plannedCandidateCount = Number(input.filterSummary?.plannedCandidateCount ?? 0);
  if (reviewedCount > 0 && plannedCandidateCount === 0) {
    return `No action — 0/${reviewedCount} items passed picker`;
  }
  if (blockedCount > 0) {
    return `No action — ${blockedCount} item(s) blocked during review`;
  }

  if (input.operationalSkipped.length > 0) {
    return input.operationalSkipped[0]!;
  }

  if (input.bundleRationale) {
    return input.bundleRationale;
  }

  return "No Reddit action this run.";
}

function extractRedditRunDetails(report: Record<string, unknown>): {
  performed: string[];
  skipped: string[];
  filteringSummary: string[];
  summary: string;
  skipCount: number;
  runCounts: EngagementCounts;
  countsScope: "lifetime" | "run";
  activityThisRun?: string;
} {
  const planner = parseJsonRecord(report.planner);
  const ingestion = parseJsonRecord(report.ingestion);
  const bundle = parseJsonRecord(report.selectedActionBundle);
  const candidates = parseJsonArray<Record<string, unknown>>(report.actionCandidates);
  const queuedJobs = parseJsonArray<Record<string, unknown>>(report.queuedActionJobs);
  const filterSummary = parseJsonRecord(planner?.filterSummary);
  const pipeline = parseJsonRecord(planner?.pipeline);

  const rawPlannerSkipped = uniqueStrings([
    ...parseJsonArray<string>(report.skipped).map(String),
    ...parseJsonArray<string>(planner?.skipped).map(String),
    ...parseJsonArray<string>(ingestion?.skipped).map(String)
  ]);
  const { perItemBlocked, perItemRequires, operational } = splitRedditSkipLines(rawPlannerSkipped);
  const filteringSummary = buildRedditFilteringSummary(planner, bundle, candidates, rawPlannerSkipped);

  const rationale = asOptionalString(bundle?.rationale);
  const deferredIds = parseJsonArray<string>(bundle?.deferredCandidateIds).map(String);
  const skipped = buildRedditRunNotes({
    operational,
    perItemRequires,
    deferredCount: deferredIds.length,
    pipeline,
    filterSummary
  });

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

  const allowedCount = candidates.filter((candidate) => candidate.allowed === true).length;
  const blockedCandidateCount = candidates.filter((candidate) => candidate.allowed === false).length;

  if (skipped.length === 0 && performed.length === 0 && !filterSummary) {
    if (blockedCandidateCount > 0) {
      skipped.push(`Reviewed ${candidates.length} picker candidate(s); all blocked.`);
    } else if (candidates.length === 0 && perItemBlocked.length === 0) {
      skipped.push("No action candidates were generated this run.");
    } else if (allowedCount > 0) {
      skipped.push(`${allowedCount} allowed candidate(s) but nothing was queued (check daily caps, cooldowns, or jitter).`);
    }
  }

  const engagementSummary = parseJsonRecord(report.engagementSummary);
  const engagementTotals = parseJsonRecord(engagementSummary?.total);
  const runCounts =
    engagementTotals && Object.keys(engagementTotals).length > 0
      ? normalizeCounts(engagementTotals as Partial<EngagementCounts>)
      : countPerformedActions(performed);

  const activityParts: string[] = [];
  if (ingestion && typeof ingestion.sourceItemCount === "number") {
    activityParts.push(`${ingestion.sourceItemCount} source items`);
  }
  if (filterSummary && typeof filterSummary.plannedCandidateCount === "number") {
    activityParts.push(`${filterSummary.plannedCandidateCount} passed picker`);
  } else if (candidates.length > 0) {
    activityParts.push(`${candidates.length} picker candidate(s)`);
  }
  if (typeof filterSummary?.blockedCount === "number" && filterSummary.blockedCount > 0) {
    activityParts.push(`${filterSummary.blockedCount} blocked`);
  }

  const skipCount = skipped.length;

  return {
    performed,
    skipped,
    filteringSummary,
    summary: buildRedditRunHeadline({
      performed,
      operationalSkipped: skipped,
      filterSummary,
      pipeline,
      bundleRationale: rationale
    }),
    skipCount,
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
      skipCount: reddit.skipCount,
      runCounts: reddit.runCounts,
      countsScope: reddit.countsScope,
      activityThisRun: reddit.activityThisRun,
      errors,
      skipped: reddit.skipped,
      performed: reddit.performed,
      filteringSummary: reddit.filteringSummary,
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
