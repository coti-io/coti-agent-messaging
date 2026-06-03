import type { ActionJob } from "./action-planning.js";
import type { ActionExecutionConfig } from "./config.js";
import type { VenueAction } from "./venue.js";

export interface ActionExecutionRecord {
  venue: VenueAction["venue"];
  type: VenueAction["type"];
  createdAt: string;
  surface?: string;
  status?: string;
  nextEligibleAt?: string;
}

export interface ResolvedActionExecutionConfig {
  globalCooldownMs: CooldownRange;
  actionCooldowns: Record<VenueAction["type"], CooldownRange>;
  maxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  runningLeaseTimeoutMs: number;
}

export interface CooldownRange {
  minMs: number;
  maxMs: number;
}

export type ActionJobSelection =
  | {
      selectedJob: ActionJob;
      jobs: ActionJob[];
      skipped?: undefined;
      nextEligibleAt?: undefined;
    }
  | {
      selectedJob?: undefined;
      jobs: ActionJob[];
      skipped?: string;
      nextEligibleAt?: string;
    };

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;

export const DEFAULT_ACTION_EXECUTION_CONFIG: ResolvedActionExecutionConfig = {
  globalCooldownMs: { minMs: 10 * SECOND_MS, maxMs: 60 * SECOND_MS },
  actionCooldowns: {
    create_post: { minMs: 20 * 60 * MINUTE_MS, maxMs: 36 * 60 * MINUTE_MS },
    comment_on_post: { minMs: 45 * MINUTE_MS, maxMs: 120 * MINUTE_MS },
    reply_to_comment: { minMs: 20 * MINUTE_MS, maxMs: 75 * MINUTE_MS },
    upvote_post: { minMs: 90 * SECOND_MS, maxMs: 6 * MINUTE_MS },
    follow_account: { minMs: 5 * MINUTE_MS, maxMs: 20 * MINUTE_MS },
    review_only: { minMs: 0, maxMs: 0 },
    ignore: { minMs: 0, maxMs: 0 }
  },
  maxAttempts: 3,
  retryBaseDelayMs: 5 * MINUTE_MS,
  retryMaxDelayMs: 120 * MINUTE_MS,
  runningLeaseTimeoutMs: 15 * MINUTE_MS
};

export function resolveActionExecutionConfig(
  config?: ActionExecutionConfig
): ResolvedActionExecutionConfig {
  if (!config) {
    return DEFAULT_ACTION_EXECUTION_CONFIG;
  }
  return {
    globalCooldownMs: secondsRange(config.globalMinDelaySeconds, config.globalMaxDelaySeconds),
    actionCooldowns: {
      create_post: minutesRange(config.createPostMinMinutes, config.createPostMaxMinutes),
      comment_on_post: minutesRange(config.commentMinMinutes, config.commentMaxMinutes),
      reply_to_comment: minutesRange(config.replyMinMinutes, config.replyMaxMinutes),
      upvote_post: secondsRange(config.upvoteMinDelaySeconds, config.upvoteMaxDelaySeconds),
      follow_account: secondsRange(config.followMinDelaySeconds, config.followMaxDelaySeconds),
      review_only: { minMs: 0, maxMs: 0 },
      ignore: { minMs: 0, maxMs: 0 }
    },
    maxAttempts: Math.max(1, Math.floor(config.maxAttempts)),
    retryBaseDelayMs: Math.max(1, config.retryBaseDelaySeconds) * SECOND_MS,
    retryMaxDelayMs: Math.max(1, config.retryMaxDelayMinutes) * MINUTE_MS,
    runningLeaseTimeoutMs: Math.max(1, config.runningLeaseTimeoutMinutes) * MINUTE_MS
  };
}

export function pickNextExecutableJob(input: {
  jobs: readonly ActionJob[];
  records: readonly ActionExecutionRecord[];
  now: Date;
  config?: ActionExecutionConfig;
}): ActionJobSelection {
  const config = resolveActionExecutionConfig(input.config);
  const nowMs = input.now.getTime();
  let jobs = recoverStaleRunningJobs(input.jobs, input.now, config);
  const dueJobs = jobs
    .filter((job) => job.status === "queued" && parseTime(job.notBefore) <= nowMs)
    .sort(compareJobsForExecution);

  if (dueJobs.length === 0) {
    const nextQueued = jobs
      .filter((job) => job.status === "queued")
      .sort(compareJobsForExecution)[0];
    return {
      jobs,
      skipped: nextQueued ? `No queued action is due until ${nextQueued.notBefore}.` : undefined,
      nextEligibleAt: nextQueued?.notBefore
    };
  }

  const blocked: Array<{ job: ActionJob; until: string; reason: string }> = [];
  for (const job of dueJobs) {
    const cooldown = findCooldownBlock(job, input.records, input.now, config);
    if (cooldown) {
      blocked.push({ job, ...cooldown });
      jobs = updateJob(jobs, job.id, (entry) => ({
        ...entry,
        notBefore: maxIso(entry.notBefore, cooldown.until)
      }));
      continue;
    }

    const selected = {
      ...job,
      status: "running" as const,
      attempts: job.attempts + 1,
      runningAt: input.now.toISOString(),
      lastAttemptAt: input.now.toISOString(),
      lastError: undefined
    };
    jobs = updateJob(jobs, job.id, () => selected);
    return { selectedJob: selected, jobs };
  }

  const next = blocked.sort((left, right) => Date.parse(left.until) - Date.parse(right.until))[0];
  return {
    jobs,
    skipped: next ? next.reason : "Queued actions are blocked by execution cooldowns.",
    nextEligibleAt: next?.until
  };
}

export function scheduleActionJobNotBefore(input: {
  now: Date;
  actionType: VenueAction["type"];
  order?: number;
  needsContent?: boolean;
  existingJobs?: readonly ActionJob[];
  records?: readonly ActionExecutionRecord[];
  config?: ActionExecutionConfig;
  rng?: () => number;
}): string {
  const config = resolveActionExecutionConfig(input.config);
  const order = input.order ?? 0;
  const rng = input.rng ?? Math.random;
  const baseMinMs = input.needsContent ? 5 * MINUTE_MS : 30 * SECOND_MS;
  const baseMaxMs = input.needsContent ? 30 * MINUTE_MS : 3 * MINUTE_MS;
  const orderSpacingMs = order * (input.needsContent ? 90 * SECOND_MS : 15 * SECOND_MS);
  const baseAt = input.now.getTime() + orderSpacingMs + randomBetween({ minMs: baseMinMs, maxMs: baseMaxMs }, rng);
  const cooldownAt = nextCooldownEligibleAt({
    actionType: input.actionType,
    records: input.records ?? [],
    queuedJobs: input.existingJobs ?? [],
    now: input.now,
    config,
    rng
  });
  return new Date(Math.max(baseAt, cooldownAt)).toISOString();
}

export function nextActionCooldownAt(input: {
  actionType: VenueAction["type"];
  now: Date;
  config?: ActionExecutionConfig;
  rng?: () => number;
}): string {
  const config = resolveActionExecutionConfig(input.config);
  const rng = input.rng ?? Math.random;
  const globalAt = input.now.getTime() + randomBetween(config.globalCooldownMs, rng);
  const typeAt = input.now.getTime() + randomBetween(config.actionCooldowns[input.actionType], rng);
  return new Date(Math.max(globalAt, typeAt)).toISOString();
}

export function requeueFailedActionJob(input: {
  jobs: readonly ActionJob[];
  jobId: string;
  error: unknown;
  now: Date;
  config?: ActionExecutionConfig;
  rng?: () => number;
}): { jobs: ActionJob[]; retrying: boolean; failedJob?: ActionJob } {
  const config = resolveActionExecutionConfig(input.config);
  const rng = input.rng ?? Math.random;
  let retrying = false;
  let failedJob: ActionJob | undefined;
  const message = errorMessage(input.error);
  const jobs = input.jobs.map((job) => {
    if (job.id !== input.jobId) {
      return job;
    }
    if (!isRetryablePublishError(input.error) || job.attempts >= config.maxAttempts) {
      failedJob = {
        ...job,
        status: "failed",
        runningAt: undefined,
        lastError: message
      };
      return failedJob;
    }
    const retryDelayMs = Math.min(
      config.retryMaxDelayMs,
      config.retryBaseDelayMs * 2 ** Math.max(0, job.attempts - 1)
    );
    const notBefore = new Date(
      input.now.getTime() + randomBetween({ minMs: retryDelayMs, maxMs: retryDelayMs * 2 }, rng)
    ).toISOString();
    retrying = true;
    return {
      ...job,
      status: "queued" as const,
      runningAt: undefined,
      notBefore,
      lastError: message
    };
  });
  return { jobs, retrying, failedJob };
}

export function compactActionJobs(jobs: readonly ActionJob[]): ActionJob[] {
  return dedupeActionJobs(jobs).filter((job) => job.status !== "succeeded");
}

export function actionJobDedupeKey(job: Pick<ActionJob, "venue" | "type" | "payload" | "candidateId">): string {
  const payload = job.payload;
  return [
    job.venue,
    job.type,
    payload.surface ?? "",
    payload.parentId ?? "",
    payload.candidateId ?? job.candidateId,
    payload.title ?? "",
    payload.content ? fingerprint(payload.content) : ""
  ].join(":");
}

export function isRetryablePublishError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return ![
    "manual_review_required",
    "invalid_configuration",
    "unsupported_action",
    "surface_not_allowed",
    "requires",
    "missing",
    "not configured",
    "must not",
    "cannot publish"
  ].some((needle) => message.includes(needle));
}

function findCooldownBlock(
  job: ActionJob,
  records: readonly ActionExecutionRecord[],
  now: Date,
  config: ResolvedActionExecutionConfig
): { until: string; reason: string } | undefined {
  const nowMs = now.getTime();
  const recentGlobal = latestRecord(records, (record) => record.venue === job.venue);
  const globalUntil = recentGlobal
    ? Date.parse(recentGlobal.createdAt) + config.globalCooldownMs.minMs
    : 0;
  if (globalUntil > nowMs) {
    const until = new Date(globalUntil).toISOString();
    return {
      until,
      reason: `Global execution cooldown blocks ${job.type} until ${until}.`
    };
  }

  const recentType = latestRecord(records, (record) => record.venue === job.venue && record.type === job.type);
  const typeUntil = Math.max(
    recentType?.nextEligibleAt ? parseTime(recentType.nextEligibleAt) : 0,
    recentType ? Date.parse(recentType.createdAt) + config.actionCooldowns[job.type].minMs : 0
  );
  if (typeUntil > nowMs) {
    const until = new Date(typeUntil).toISOString();
    return {
      until,
      reason: `${job.type} execution cooldown blocks queued action until ${until}.`
    };
  }

  const circuit = findCircuitBreaker(records, job, now);
  if (circuit) {
    return circuit;
  }
  return undefined;
}

function nextCooldownEligibleAt(input: {
  actionType: VenueAction["type"];
  records: readonly ActionExecutionRecord[];
  queuedJobs: readonly ActionJob[];
  now: Date;
  config: ResolvedActionExecutionConfig;
  rng: () => number;
}): number {
  const recentGlobal = latestRecord(input.records, () => true);
  const recentType = latestRecord(input.records, (record) => record.type === input.actionType);
  const queuedLatest = input.queuedJobs
    .filter((job) => job.status === "queued")
    .map((job) => parseTime(job.notBefore))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0] ?? 0;
  const globalAt = recentGlobal
    ? Date.parse(recentGlobal.createdAt) + randomBetween(input.config.globalCooldownMs, input.rng)
    : input.now.getTime();
  const typeAt = recentType
    ? Math.max(
        recentType.nextEligibleAt ? parseTime(recentType.nextEligibleAt) : 0,
        Date.parse(recentType.createdAt) + randomBetween(input.config.actionCooldowns[input.actionType], input.rng)
      )
    : input.now.getTime();
  const queuedAt = queuedLatest > 0
    ? queuedLatest + randomBetween(input.config.globalCooldownMs, input.rng)
    : input.now.getTime();
  return Math.max(input.now.getTime(), globalAt, typeAt, queuedAt);
}

function recoverStaleRunningJobs(
  jobs: readonly ActionJob[],
  now: Date,
  config: ResolvedActionExecutionConfig
): ActionJob[] {
  return jobs.map((job) => {
    if (job.status !== "running") {
      return job;
    }
    const startedAt = parseTime(job.runningAt ?? job.lastAttemptAt ?? job.notBefore);
    if (now.getTime() - startedAt < config.runningLeaseTimeoutMs) {
      return job;
    }
    return {
      ...job,
      status: "queued",
      runningAt: undefined,
      notBefore: now.toISOString(),
      lastError: job.lastError ?? "Recovered stale running action lease."
    };
  });
}

function dedupeActionJobs(jobs: readonly ActionJob[]): ActionJob[] {
  const byKey = new Map<string, ActionJob>();
  for (const job of jobs) {
    const key = actionJobDedupeKey(job);
    const existing = byKey.get(key);
    if (!existing || compareJobsForExecution(job, existing) > 0) {
      byKey.set(key, job);
    }
  }
  return [...byKey.values()].sort(compareJobsForExecution);
}

function latestRecord(
  records: readonly ActionExecutionRecord[],
  predicate: (record: ActionExecutionRecord) => boolean
): ActionExecutionRecord | undefined {
  return records
    .filter((record) => predicate(record) && isPublishedRecord(record))
    .sort((left, right) => parseTime(right.createdAt) - parseTime(left.createdAt))[0];
}

function findCircuitBreaker(
  records: readonly ActionExecutionRecord[],
  job: ActionJob,
  now: Date
): { until: string; reason: string } | undefined {
  const windowMs = 6 * 60 * MINUTE_MS;
  const badRecords = records.filter((record) => {
    const createdAt = parseTime(record.createdAt);
    return (
      record.venue === job.venue &&
      record.type === job.type &&
      now.getTime() - createdAt <= windowMs &&
      (record.status === "failed" || record.status === "spam_filtered" || record.status === "removed")
    );
  });
  if (badRecords.length < 3) {
    return undefined;
  }
  const latest = badRecords.sort((left, right) => parseTime(right.createdAt) - parseTime(left.createdAt))[0];
  const until = new Date(parseTime(latest.createdAt) + windowMs).toISOString();
  return {
    until,
    reason: `Circuit breaker blocks ${job.type}; ${badRecords.length} recent failures or hidden actions.`
  };
}

function isPublishedRecord(record: ActionExecutionRecord): boolean {
  return record.status !== "drafted" && record.status !== "skipped" && record.status !== "failed";
}

function compareJobsForExecution(left: ActionJob, right: ActionJob): number {
  return parseTime(left.notBefore) - parseTime(right.notBefore) || parseTime(left.createdAt) - parseTime(right.createdAt);
}

function updateJob(jobs: readonly ActionJob[], jobId: string, updater: (job: ActionJob) => ActionJob): ActionJob[] {
  return jobs.map((job) => (job.id === jobId ? updater(job) : job));
}

function randomBetween(range: CooldownRange, rng: () => number): number {
  if (range.maxMs <= range.minMs) {
    return Math.max(0, Math.floor(range.minMs));
  }
  const value = Math.min(0.999, Math.max(0, rng()));
  return Math.floor(range.minMs + (range.maxMs - range.minMs) * value);
}

function secondsRange(min: number, max: number): CooldownRange {
  return normalizeRange(min * SECOND_MS, max * SECOND_MS);
}

function minutesRange(min: number, max: number): CooldownRange {
  return normalizeRange(min * MINUTE_MS, max * MINUTE_MS);
}

function normalizeRange(minMs: number, maxMs: number): CooldownRange {
  const min = Math.max(0, Math.floor(minMs));
  const max = Math.max(min, Math.floor(maxMs));
  return { minMs: min, maxMs: max };
}

function parseTime(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function maxIso(left: string, right: string): string {
  return new Date(Math.max(parseTime(left), parseTime(right))).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fingerprint(value: string): string {
  return (value.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).slice(0, 12).join("-");
}
