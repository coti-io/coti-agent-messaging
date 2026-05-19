import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import sqlite3 from "sqlite3";

import {
  createInitialState,
  normalizeState,
  type EngagementCounts,
  type EngagementEvent,
  type EngagementEventType,
  type EngagementSummary,
  type OutreachAgentState,
  type PendingWrite
} from "./policy.js";

export interface StoredHeartbeatRun {
  runId: string;
  agentId?: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "ok" | "degraded" | "failed";
  summary?: string;
  dryRun: boolean;
  plannedActions: string[];
  performed: string[];
  skipped: string[];
  errors: unknown[];
  reconciledPendingWrites: unknown[];
  writeCandidates: unknown[];
  selectedWriteDecision?: unknown;
  engagementSummary?: EngagementSummary;
}

const STORAGE_SCHEMA_VERSION = 1;
const STATE_SNAPSHOT_ID = 1;
const BASELINE_META_KEY = "engagement_baseline_json";
const SCHEMA_VERSION_META_KEY = "schema_version";
const LEGACY_MIGRATED_AT_META_KEY = "legacy_migrated_at";
const LAST_SUCCESSFUL_RUN_AT_META_KEY = "last_successful_run_at";
const HEARTBEAT_FRESHNESS_MS = 15 * 60 * 1_000;

interface SqliteRow {
  [key: string]: unknown;
}

interface StorageAnalytics {
  state: OutreachAgentState;
  engagementSummary: EngagementSummary;
  pendingWrites: number;
  lastSuccessfulHeartbeatAt?: string;
  latestStatus?: string;
  latestErrors: number;
  latestSkipped: number;
  latestStartedAt?: string;
  latestFinishedAt?: string;
  schedulerHealth: "fresh" | "stale" | "unknown";
}

function createEmptyCounts(): EngagementCounts {
  return {
    posts: 0,
    comments: 0,
    replies: 0,
    upvotes: 0,
    follows: 0,
    total: 0
  };
}

function countKey(type: EngagementEventType): keyof Omit<EngagementCounts, "total"> {
  switch (type) {
    case "post":
      return "posts";
    case "comment":
      return "comments";
    case "reply":
      return "replies";
    case "upvote":
      return "upvotes";
    case "follow":
      return "follows";
  }
}

function normalizeCounts(counts: Partial<EngagementCounts>): EngagementCounts {
  const next = {
    ...createEmptyCounts(),
    ...counts
  };
  next.total = next.posts + next.comments + next.replies + next.upvotes + next.follows;
  return next;
}

function countEvents(events: readonly EngagementEvent[]): EngagementCounts {
  const counts = createEmptyCounts();
  for (const event of events) {
    counts[countKey(event.type)] += 1;
  }
  counts.total = counts.posts + counts.comments + counts.replies + counts.upvotes + counts.follows;
  return counts;
}

function subtractCounts(left: EngagementCounts, right: EngagementCounts): EngagementCounts {
  return normalizeCounts({
    posts: Math.max(0, left.posts - right.posts),
    comments: Math.max(0, left.comments - right.comments),
    replies: Math.max(0, left.replies - right.replies),
    upvotes: Math.max(0, left.upvotes - right.upvotes),
    follows: Math.max(0, left.follows - right.follows)
  });
}

function summarizeEvents(events: readonly EngagementEvent[], now = new Date()): EngagementSummary {
  const nowMs = now.getTime();
  const last2Hours = nowMs - 2 * 60 * 60 * 1_000;
  const lastDay = nowMs - 24 * 60 * 60 * 1_000;
  const lastWeek = nowMs - 7 * 24 * 60 * 60 * 1_000;
  const parseTime = (value: string) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  return {
    generatedAt: now.toISOString(),
    windows: {
      last2Hours: countEvents(events.filter((event) => parseTime(event.createdAt) >= last2Hours)),
      lastDay: countEvents(events.filter((event) => parseTime(event.createdAt) >= lastDay)),
      lastWeek: countEvents(events.filter((event) => parseTime(event.createdAt) >= lastWeek))
    },
    total: countEvents(events)
  };
}

function deriveReportPath(statePath: string): string {
  return path.join(path.dirname(statePath), "last-heartbeat.json");
}

export function deriveStoragePath(statePath: string): string {
  const parsed = path.parse(statePath);
  return path.join(parsed.dir, `${parsed.name}.sqlite`);
}

class SqliteDatabase {
  constructor(private readonly db: sqlite3.Database) {}

  static async open(databasePath: string): Promise<SqliteDatabase> {
    await mkdir(path.dirname(databasePath), { recursive: true });
    const db = await new Promise<sqlite3.Database>((resolve, reject) => {
      const next = new sqlite3.Database(databasePath, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(next);
      });
    });
    return new SqliteDatabase(db);
  }

  async exec(sql: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.db.exec(sql, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.db.run(sql, params, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async get<T extends SqliteRow>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return await new Promise<T | undefined>((resolve, reject) => {
      this.db.get(sql, params, (error, row) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(row as T | undefined);
      });
    });
  }

  async all<T extends SqliteRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    return await new Promise<T[]>((resolve, reject) => {
      this.db.all(sql, params, (error, rows) => {
        if (error) {
          reject(error);
          return;
        }
        resolve((rows ?? []) as T[]);
      });
    });
  }

  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    await this.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const value = await callback();
      await this.exec("COMMIT");
      return value;
    } catch (error) {
      await this.exec("ROLLBACK");
      throw error;
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.db.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function readOptionalJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function ensureSchema(db: SqliteDatabase): Promise<void> {
  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS agent_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS heartbeat_runs (
      run_id TEXT PRIMARY KEY,
      agent_id TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      summary TEXT,
      dry_run INTEGER NOT NULL,
      error_count INTEGER NOT NULL,
      skip_count INTEGER NOT NULL,
      planned_actions_json TEXT NOT NULL,
      performed_json TEXT NOT NULL,
      skipped_json TEXT NOT NULL,
      errors_json TEXT NOT NULL,
      reconciled_pending_writes_json TEXT NOT NULL,
      write_candidates_json TEXT NOT NULL,
      selected_write_decision_json TEXT,
      engagement_summary_json TEXT
    );

    CREATE INDEX IF NOT EXISTS heartbeat_runs_finished_at_idx
      ON heartbeat_runs(finished_at);

    CREATE TABLE IF NOT EXISTS engagement_events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT,
      event_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      target_id TEXT,
      target_summary TEXT
    );

    CREATE INDEX IF NOT EXISTS engagement_events_created_at_idx
      ON engagement_events(created_at);

    CREATE TABLE IF NOT EXISTS pending_writes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      reconciliation_misses INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      content TEXT NOT NULL,
      post_id TEXT,
      target_comment_id TEXT,
      target_summary TEXT,
      reply_to_author TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS state_snapshots (
      snapshot_id INTEGER PRIMARY KEY CHECK (snapshot_id = 1),
      snapshot_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  await db.run(
    `
      INSERT INTO agent_meta(key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
    [SCHEMA_VERSION_META_KEY, String(STORAGE_SCHEMA_VERSION)]
  );
}

async function getMetaValue(db: SqliteDatabase, key: string): Promise<string | undefined> {
  const row = await db.get<{ value: string }>("SELECT value FROM agent_meta WHERE key = ?", [key]);
  return typeof row?.value === "string" ? row.value : undefined;
}

async function setMetaValue(db: SqliteDatabase, key: string, value: string): Promise<void> {
  await db.run(
    `
      INSERT INTO agent_meta(key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
    [key, value]
  );
}

async function getBaselineCounts(db: SqliteDatabase): Promise<EngagementCounts> {
  const raw = await getMetaValue(db, BASELINE_META_KEY);
  if (!raw) {
    return createEmptyCounts();
  }
  return normalizeCounts(JSON.parse(raw) as Partial<EngagementCounts>);
}

async function setBaselineCounts(db: SqliteDatabase, counts: EngagementCounts): Promise<void> {
  await setMetaValue(db, BASELINE_META_KEY, JSON.stringify(normalizeCounts(counts)));
}

async function getSnapshotState(
  db: SqliteDatabase,
  now = new Date()
): Promise<OutreachAgentState | undefined> {
  const row = await db.get<{ snapshot_json: string }>(
    "SELECT snapshot_json FROM state_snapshots WHERE snapshot_id = ?",
    [STATE_SNAPSHOT_ID]
  );
  if (!row?.snapshot_json) {
    return undefined;
  }
  return normalizeState(JSON.parse(row.snapshot_json) as Partial<OutreachAgentState>, now);
}

async function writeSnapshotState(db: SqliteDatabase, state: OutreachAgentState): Promise<void> {
  await db.run(
    `
      INSERT INTO state_snapshots(snapshot_id, snapshot_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(snapshot_id) DO UPDATE SET
        snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at
    `,
    [STATE_SNAPSHOT_ID, JSON.stringify(state, null, 2), new Date().toISOString()]
  );
}

async function loadStoredEvents(db: SqliteDatabase): Promise<EngagementEvent[]> {
  const rows = await db.all<{
    event_id: string;
    event_type: EngagementEventType;
    created_at: string;
    target_id: string | null;
    target_summary: string | null;
  }>(
    `
      SELECT event_id, event_type, created_at, target_id, target_summary
      FROM engagement_events
      ORDER BY created_at ASC, event_id ASC
    `
  );

  return rows.map((row) => ({
    id: row.event_id,
    type: row.event_type,
    createdAt: row.created_at,
    targetId: row.target_id ?? undefined,
    targetSummary: row.target_summary ?? undefined
  }));
}

async function loadPendingWrites(db: SqliteDatabase): Promise<PendingWrite[]> {
  const rows = await db.all<{
    id: string;
    type: PendingWrite["type"];
    fingerprint: string;
    reconciliation_misses: number;
    title: string | null;
    content: string;
    post_id: string | null;
    target_comment_id: string | null;
    target_summary: string | null;
    reply_to_author: string | null;
    created_at: string;
  }>(
    `
      SELECT
        id,
        type,
        fingerprint,
        reconciliation_misses,
        title,
        content,
        post_id,
        target_comment_id,
        target_summary,
        reply_to_author,
        created_at
      FROM pending_writes
      ORDER BY created_at ASC, id ASC
    `
  );

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    fingerprint: row.fingerprint,
    reconciliationMisses: row.reconciliation_misses,
    title: row.title ?? undefined,
    content: row.content,
    postId: row.post_id ?? undefined,
    targetCommentId: row.target_comment_id ?? undefined,
    targetSummary: row.target_summary ?? undefined,
    replyToAuthor: row.reply_to_author ?? undefined,
    createdAt: row.created_at
  }));
}

async function getLifetimeCounts(db: SqliteDatabase): Promise<EngagementCounts> {
  const baseline = await getBaselineCounts(db);
  const rows = await db.all<{ event_type: EngagementEventType; count: number }>(
    `
      SELECT event_type, COUNT(*) AS count
      FROM engagement_events
      GROUP BY event_type
    `
  );

  const counts = { ...baseline };
  for (const row of rows) {
    counts[countKey(row.event_type)] += Number(row.count) || 0;
  }
  return normalizeCounts(counts);
}

async function getWindowCounts(db: SqliteDatabase, fromIso: string): Promise<EngagementCounts> {
  const rows = await db.all<{ event_type: EngagementEventType; count: number }>(
    `
      SELECT event_type, COUNT(*) AS count
      FROM engagement_events
      WHERE created_at >= ?
      GROUP BY event_type
    `,
    [fromIso]
  );
  const counts = createEmptyCounts();
  for (const row of rows) {
    counts[countKey(row.event_type)] += Number(row.count) || 0;
  }
  return normalizeCounts(counts);
}

async function buildAnalytics(db: SqliteDatabase, now = new Date()): Promise<StorageAnalytics> {
  const snapshotState = (await getSnapshotState(db, now)) ?? createInitialState();
  const pendingWrites = mergePendingWrites(snapshotState.pendingWrites, await loadPendingWrites(db));
  const state = normalizeState({
    ...snapshotState,
    pendingWrites
  });
  const last2Hours = new Date(now.getTime() - 2 * 60 * 60 * 1_000).toISOString();
  const lastDay = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
  const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString();
  const storedEvents = await loadStoredEvents(db);
  const snapshotEventSummary = summarizeEvents(state.engagementEvents, now);
  const [latestRun, latestSuccess, total, twoHours, day, week] = await Promise.all([
    db.get<{
      status: string;
      error_count: number;
      skip_count: number;
      started_at: string | null;
      finished_at: string | null;
    }>(
      `
        SELECT status, error_count, skip_count, started_at, finished_at
        FROM heartbeat_runs
        ORDER BY COALESCE(finished_at, started_at) DESC
        LIMIT 1
      `
    ),
    db.get<{ finished_at: string | null }>(
      `
        SELECT finished_at
        FROM heartbeat_runs
        WHERE status = 'ok'
        ORDER BY COALESCE(finished_at, started_at) DESC
        LIMIT 1
      `
    ),
    storedEvents.length === 0 ? Promise.resolve(normalizeCounts(state.engagementTotals)) : getLifetimeCounts(db),
    storedEvents.length === 0
      ? Promise.resolve(snapshotEventSummary.windows.last2Hours)
      : getWindowCounts(db, last2Hours),
    storedEvents.length === 0
      ? Promise.resolve(snapshotEventSummary.windows.lastDay)
      : getWindowCounts(db, lastDay),
    storedEvents.length === 0
      ? Promise.resolve(snapshotEventSummary.windows.lastWeek)
      : getWindowCounts(db, lastWeek)
  ]);

  const summary: EngagementSummary = {
    generatedAt: now.toISOString(),
    windows: {
      last2Hours: twoHours,
      lastDay: day,
      lastWeek: week
    },
    total
  };

  const finishedAt = typeof latestRun?.finished_at === "string" ? latestRun.finished_at : undefined;
  const startedAt = typeof latestRun?.started_at === "string" ? latestRun.started_at : undefined;
  const heartbeatTime = finishedAt ?? startedAt;
  const schedulerHealth =
    heartbeatTime === undefined
      ? "unknown"
      : now.getTime() - Date.parse(heartbeatTime) <= HEARTBEAT_FRESHNESS_MS
        ? "fresh"
        : "stale";

  return {
    state: normalizeState({
      ...state,
      engagementTotals: total
    }),
    engagementSummary: summary,
    pendingWrites: pendingWrites.length,
    lastSuccessfulHeartbeatAt:
      typeof latestSuccess?.finished_at === "string" ? latestSuccess.finished_at : undefined,
    latestStatus: typeof latestRun?.status === "string" ? latestRun.status : undefined,
    latestErrors: Number(latestRun?.error_count) || 0,
    latestSkipped: Number(latestRun?.skip_count) || 0,
    latestStartedAt: startedAt,
    latestFinishedAt: finishedAt,
    schedulerHealth
  };
}

async function migrateLegacyStateIfNeeded(
  db: SqliteDatabase,
  statePath: string,
  heartbeatReportPath = deriveReportPath(statePath)
): Promise<void> {
  const snapshotState = await getSnapshotState(db);
  if (snapshotState) {
    return;
  }

  const legacyStateJson = await readOptionalJson(statePath);
  const legacyState = (legacyStateJson as Partial<OutreachAgentState>) ?? createInitialState();
  const migrationNow =
    typeof legacyState.lastHeartbeatAt === "string"
      ? new Date(legacyState.lastHeartbeatAt)
      : new Date();
  const migratedState = normalizeState(legacyState, migrationNow);
  const baselineCounts = subtractCounts(
    normalizeCounts(migratedState.engagementTotals),
    countEvents(migratedState.engagementEvents)
  );
  const legacyReport = await readOptionalJson(heartbeatReportPath);

  await db.transaction(async () => {
    const existingSnapshot = await getSnapshotState(db);
    if (existingSnapshot) {
      return;
    }

    await setBaselineCounts(db, baselineCounts);
    await writeSnapshotState(
      db,
      normalizeState({
        ...migratedState,
        engagementTotals: normalizeCounts(migratedState.engagementTotals)
      })
    );

    await db.run("DELETE FROM pending_writes");
    for (const pendingWrite of migratedState.pendingWrites) {
      await db.run(
        `
          INSERT OR REPLACE INTO pending_writes(
            id,
            type,
            fingerprint,
            reconciliation_misses,
            title,
            content,
            post_id,
            target_comment_id,
            target_summary,
            reply_to_author,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          pendingWrite.id,
          pendingWrite.type,
          pendingWrite.fingerprint,
          pendingWrite.reconciliationMisses ?? 0,
          pendingWrite.title ?? null,
          pendingWrite.content,
          pendingWrite.postId ?? null,
          pendingWrite.targetCommentId ?? null,
          pendingWrite.targetSummary ?? null,
          pendingWrite.replyToAuthor ?? null,
          pendingWrite.createdAt
        ]
      );
    }

    for (const event of migratedState.engagementEvents) {
      await db.run(
        `
          INSERT OR IGNORE INTO engagement_events(
            event_id,
            run_id,
            event_type,
            created_at,
            target_id,
            target_summary
          ) VALUES (?, NULL, ?, ?, ?, ?)
        `,
        [event.id, event.type, event.createdAt, event.targetId ?? null, event.targetSummary ?? null]
      );
    }

    if (legacyReport) {
      const startedAt =
        typeof legacyReport.startedAt === "string"
          ? legacyReport.startedAt
          : migratedState.lastHeartbeatAt ?? new Date().toISOString();
      const finishedAt =
        typeof legacyReport.finishedAt === "string"
          ? legacyReport.finishedAt
          : migratedState.lastHeartbeatAt;
      const status =
        legacyReport.status === "running" || legacyReport.status === "failed" ? legacyReport.status : "ok";
      await db.run(
        `
          INSERT OR IGNORE INTO heartbeat_runs(
            run_id,
            agent_id,
            started_at,
            finished_at,
            status,
            summary,
            dry_run,
            error_count,
            skip_count,
            planned_actions_json,
            performed_json,
            skipped_json,
            errors_json,
            reconciled_pending_writes_json,
            write_candidates_json,
            selected_write_decision_json,
            engagement_summary_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          `legacy:${startedAt}`,
          typeof legacyReport.agentId === "string" ? legacyReport.agentId : migratedState.agentId ?? null,
          startedAt,
          finishedAt ?? null,
          status,
          typeof legacyReport.summary === "string" ? legacyReport.summary : null,
          legacyReport.dryRun ? 1 : 0,
          Array.isArray(legacyReport.errors) ? legacyReport.errors.length : 0,
          Array.isArray(legacyReport.skipped) ? legacyReport.skipped.length : 0,
          JSON.stringify(Array.isArray(legacyReport.plannedActions) ? legacyReport.plannedActions : []),
          JSON.stringify(Array.isArray(legacyReport.performed) ? legacyReport.performed : []),
          JSON.stringify(Array.isArray(legacyReport.skipped) ? legacyReport.skipped : []),
          JSON.stringify(Array.isArray(legacyReport.errors) ? legacyReport.errors : []),
          JSON.stringify(
            Array.isArray(legacyReport.reconciledPendingWrites)
              ? legacyReport.reconciledPendingWrites
              : []
          ),
          JSON.stringify(Array.isArray(legacyReport.writeCandidates) ? legacyReport.writeCandidates : []),
          legacyReport.selectedWriteDecision
            ? JSON.stringify(legacyReport.selectedWriteDecision)
            : null,
          legacyReport.engagementSummary ? JSON.stringify(legacyReport.engagementSummary) : null
        ]
      );

      if (status === "ok" && finishedAt) {
        await setMetaValue(db, LAST_SUCCESSFUL_RUN_AT_META_KEY, finishedAt);
      }
    } else if (migratedState.lastHeartbeatAt) {
      await setMetaValue(db, LAST_SUCCESSFUL_RUN_AT_META_KEY, migratedState.lastHeartbeatAt);
    }

    await setMetaValue(db, LEGACY_MIGRATED_AT_META_KEY, new Date().toISOString());
  });
}

export async function loadStateFromStorage(
  statePath: string,
  heartbeatReportPath?: string
): Promise<OutreachAgentState> {
  const storagePath = deriveStoragePath(statePath);
  const db = await SqliteDatabase.open(storagePath);
  try {
    await ensureSchema(db);
    await migrateLegacyStateIfNeeded(db, statePath, heartbeatReportPath);
    const analytics = await buildAnalytics(db);
    return analytics.state;
  } finally {
    await db.close();
  }
}

function mergePendingWrites(
  snapshotPendingWrites: readonly PendingWrite[] | undefined,
  storedPendingWrites: readonly PendingWrite[]
): PendingWrite[] {
  const snapshotById = new Map((snapshotPendingWrites ?? []).map((entry) => [entry.id, entry]));
  return storedPendingWrites.map((entry) => ({
    ...snapshotById.get(entry.id),
    ...entry
  }));
}

export async function saveStateToStorage(
  statePath: string,
  state: OutreachAgentState,
  runId?: string
): Promise<OutreachAgentState> {
  const storagePath = deriveStoragePath(statePath);
  const db = await SqliteDatabase.open(storagePath);
  try {
    await ensureSchema(db);
    await migrateLegacyStateIfNeeded(db, statePath);

    await db.transaction(async () => {
      const previousSnapshot = (await getSnapshotState(db)) ?? createInitialState();
      const previousEventIds = new Set(previousSnapshot.engagementEvents.map((event) => event.id));
      const nextEvents = state.engagementEvents.filter((event) => !previousEventIds.has(event.id));

      for (const event of nextEvents) {
        await db.run(
          `
            INSERT OR IGNORE INTO engagement_events(
              event_id,
              run_id,
              event_type,
              created_at,
              target_id,
              target_summary
            ) VALUES (?, ?, ?, ?, ?, ?)
          `,
          [
            event.id,
            runId ?? null,
            event.type,
            event.createdAt,
            event.targetId ?? null,
            event.targetSummary ?? null
          ]
        );
      }

      await db.run("DELETE FROM pending_writes");
      for (const pendingWrite of state.pendingWrites) {
        await db.run(
          `
            INSERT INTO pending_writes(
              id,
              type,
              fingerprint,
              reconciliation_misses,
              title,
              content,
              post_id,
              target_comment_id,
              target_summary,
              reply_to_author,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            pendingWrite.id,
            pendingWrite.type,
            pendingWrite.fingerprint,
            pendingWrite.reconciliationMisses ?? 0,
            pendingWrite.title ?? null,
            pendingWrite.content,
            pendingWrite.postId ?? null,
            pendingWrite.targetCommentId ?? null,
            pendingWrite.targetSummary ?? null,
            pendingWrite.replyToAuthor ?? null,
            pendingWrite.createdAt
          ]
        );
      }

      const totals = await getLifetimeCounts(db);
      await writeSnapshotState(
        db,
        normalizeState({
          ...state,
          engagementTotals: totals
        })
      );
    });

    const analytics = await buildAnalytics(db);
    return analytics.state;
  } finally {
    await db.close();
  }
}

export async function saveHeartbeatRunToStorage(
  statePath: string,
  report: StoredHeartbeatRun
): Promise<void> {
  const storagePath = deriveStoragePath(statePath);
  const db = await SqliteDatabase.open(storagePath);
  try {
    await ensureSchema(db);
    await migrateLegacyStateIfNeeded(db, statePath);
    await db.transaction(async () => {
      await db.run(
        `
          INSERT OR REPLACE INTO heartbeat_runs(
            run_id,
            agent_id,
            started_at,
            finished_at,
            status,
            summary,
            dry_run,
            error_count,
            skip_count,
            planned_actions_json,
            performed_json,
            skipped_json,
            errors_json,
            reconciled_pending_writes_json,
            write_candidates_json,
            selected_write_decision_json,
            engagement_summary_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          report.runId,
          report.agentId ?? null,
          report.startedAt,
          report.finishedAt ?? null,
          report.status,
          report.summary ?? null,
          report.dryRun ? 1 : 0,
          report.errors.length,
          report.skipped.length,
          JSON.stringify(report.plannedActions),
          JSON.stringify(report.performed),
          JSON.stringify(report.skipped),
          JSON.stringify(report.errors),
          JSON.stringify(report.reconciledPendingWrites),
          JSON.stringify(report.writeCandidates),
          report.selectedWriteDecision ? JSON.stringify(report.selectedWriteDecision) : null,
          report.engagementSummary ? JSON.stringify(report.engagementSummary) : null
        ]
      );

      if (report.status === "ok" && report.finishedAt) {
        await setMetaValue(db, LAST_SUCCESSFUL_RUN_AT_META_KEY, report.finishedAt);
      }
    });
  } finally {
    await db.close();
  }
}

export async function readStorageAnalytics(
  statePath: string,
  now = new Date()
): Promise<StorageAnalytics | undefined> {
  const storagePath = deriveStoragePath(statePath);
  try {
    const db = await SqliteDatabase.open(storagePath);
    try {
      await ensureSchema(db);
      await migrateLegacyStateIfNeeded(db, statePath);
      const analytics = await buildAnalytics(db, now);
      const lastSuccessfulHeartbeatAt =
        analytics.lastSuccessfulHeartbeatAt ??
        (await getMetaValue(db, LAST_SUCCESSFUL_RUN_AT_META_KEY)) ??
        undefined;
      return {
        ...analytics,
        lastSuccessfulHeartbeatAt
      };
    } finally {
      await db.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function readStoredEngagementSummary(
  statePath: string,
  now = new Date()
): Promise<EngagementSummary> {
  const analytics = await readStorageAnalytics(statePath, now);
  if (!analytics) {
    return summarizeEvents([], now);
  }
  return analytics.engagementSummary;
}
