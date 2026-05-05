import sqlite3 from "sqlite3";

import type { EngagementCounts, EngagementSummary } from "./types";

const HEARTBEAT_FRESHNESS_MS = 15 * 60 * 1_000;

type SqliteRow = Record<string, unknown>;

function emptyCounts(): EngagementCounts {
  return {
    posts: 0,
    comments: 0,
    replies: 0,
    upvotes: 0,
    follows: 0,
    total: 0
  };
}

function normalizeCounts(value: Partial<EngagementCounts>): EngagementCounts {
  const counts = {
    ...emptyCounts(),
    ...value
  };
  counts.total = counts.posts + counts.comments + counts.replies + counts.upvotes + counts.follows;
  return counts;
}

function countKey(type: string): keyof Omit<EngagementCounts, "total"> | undefined {
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
    default:
      return undefined;
  }
}

class SqliteDatabase {
  constructor(private readonly db: sqlite3.Database) {}

  static async open(databasePath: string): Promise<SqliteDatabase> {
    const db = await new Promise<sqlite3.Database>((resolve, reject) => {
      const next = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(next);
      });
    });
    return new SqliteDatabase(db);
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

async function getBaselineCounts(db: SqliteDatabase): Promise<EngagementCounts> {
  const row = await db.get<{ value: string }>("SELECT value FROM agent_meta WHERE key = ?", [
    "engagement_baseline_json"
  ]);
  if (!row?.value) {
    return emptyCounts();
  }
  return normalizeCounts(JSON.parse(row.value) as Partial<EngagementCounts>);
}

async function getLifetimeCounts(db: SqliteDatabase): Promise<EngagementCounts> {
  const baseline = await getBaselineCounts(db);
  const rows = await db.all<{ event_type: string; count: number }>(
    `
      SELECT event_type, COUNT(*) AS count
      FROM engagement_events
      GROUP BY event_type
    `
  );
  const counts = { ...baseline };
  for (const row of rows) {
    const key = countKey(String(row.event_type));
    if (key) {
      counts[key] += Number(row.count) || 0;
    }
  }
  return normalizeCounts(counts);
}

async function getWindowCounts(db: SqliteDatabase, fromIso: string): Promise<EngagementCounts> {
  const rows = await db.all<{ event_type: string; count: number }>(
    `
      SELECT event_type, COUNT(*) AS count
      FROM engagement_events
      WHERE created_at >= ?
      GROUP BY event_type
    `,
    [fromIso]
  );
  const counts = emptyCounts();
  for (const row of rows) {
    const key = countKey(String(row.event_type));
    if (key) {
      counts[key] += Number(row.count) || 0;
    }
  }
  return normalizeCounts(counts);
}

export interface SqliteAgentSnapshot {
  engagementSummary: EngagementSummary;
  pendingWrites: number;
  latestStatus?: string;
  latestErrors: number;
  latestSkipped: number;
  lastHeartbeatAt?: string;
  lastSuccessfulHeartbeatAt?: string;
  latestStartedAt?: string;
  latestFinishedAt?: string;
  schedulerHealth: "fresh" | "stale" | "unknown";
}

export async function readSqliteAgentSnapshot(
  databasePath: string,
  now = new Date()
): Promise<SqliteAgentSnapshot | undefined> {
  let db: SqliteDatabase | undefined;
  try {
    db = await SqliteDatabase.open(databasePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("SQLITE_CANTOPEN")) {
      return undefined;
    }
    throw error;
  }
  try {
    const last2Hours = new Date(now.getTime() - 2 * 60 * 60 * 1_000).toISOString();
    const lastDay = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
    const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString();
    const [latestRun, latestSuccess, pendingWritesRow, total, twoHours, day, week] = await Promise.all([
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
      db.get<{ count: number }>("SELECT COUNT(*) AS count FROM pending_writes"),
      getLifetimeCounts(db),
      getWindowCounts(db, last2Hours),
      getWindowCounts(db, lastDay),
      getWindowCounts(db, lastWeek)
    ]);

    const latestStartedAt =
      typeof latestRun?.started_at === "string" ? String(latestRun.started_at) : undefined;
    const latestFinishedAt =
      typeof latestRun?.finished_at === "string" ? String(latestRun.finished_at) : undefined;
    const heartbeatTime = latestFinishedAt ?? latestStartedAt;
    const schedulerHealth =
      heartbeatTime === undefined
        ? "unknown"
        : now.getTime() - Date.parse(heartbeatTime) <= HEARTBEAT_FRESHNESS_MS
          ? "fresh"
          : "stale";

    return {
      engagementSummary: {
        generatedAt: now.toISOString(),
        windows: {
          last2Hours: twoHours,
          lastDay: day,
          lastWeek: week
        },
        total
      },
      pendingWrites: Number(pendingWritesRow?.count) || 0,
      latestStatus: typeof latestRun?.status === "string" ? String(latestRun.status) : undefined,
      latestErrors: Number(latestRun?.error_count) || 0,
      latestSkipped: Number(latestRun?.skip_count) || 0,
      lastHeartbeatAt: heartbeatTime,
      lastSuccessfulHeartbeatAt:
        typeof latestSuccess?.finished_at === "string" ? String(latestSuccess.finished_at) : undefined,
      latestStartedAt,
      latestFinishedAt,
      schedulerHealth
    };
  } finally {
    await db.close();
  }
}
