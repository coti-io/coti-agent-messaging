import sqlite3 from "sqlite3";

import type {
  AttributionConversionRates,
  AttributionRefDetail,
  AttributionSummary,
  AttributionTotals,
  EngagementCounts,
  EngagementSummary
} from "./types";

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

function emptyAttributionTotals(): AttributionTotals {
  return {
    refs: 0,
    clicks: 0,
    grantChallenges: 0,
    grantClaimAttempts: 0,
    grantClaimsQueued: 0,
    grantClaimsSucceeded: 0,
    grantClaimsFailed: 0,
    privateMessagesReceived: 0,
    skillUsages: 0,
    unresolvedEvents: 0
  };
}

function rates(totals: AttributionTotals): AttributionConversionRates {
  return {
    clickToGrantChallenge: totals.clicks === 0 ? 0 : totals.grantChallenges / totals.clicks,
    clickToPrivateMessage: totals.clicks === 0 ? 0 : totals.privateMessagesReceived / totals.clicks,
    clickToSkillUsage: totals.clicks === 0 ? 0 : totals.skillUsages / totals.clicks,
    refToSkillUsage: totals.refs === 0 ? 0 : totals.skillUsages / totals.refs
  };
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function sanitizeAttributionMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const blocked = new Set([
    "wallet",
    "walletAddress",
    "wallet_address",
    "installId",
    "install_id",
    "sessionId",
    "session_id"
  ]);
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (blocked.has(key)) {
      continue;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      sanitized[key] = sanitizeAttributionMetadata(entry as Record<string, unknown>);
      continue;
    }
    sanitized[key] = entry;
  }
  return sanitized;
}

function attributionTotalsFromRow(row: Partial<Record<keyof AttributionTotals, unknown>> | undefined): AttributionTotals {
  return {
    refs: Number(row?.refs) || 0,
    clicks: Number(row?.clicks) || 0,
    grantChallenges: Number(row?.grantChallenges) || 0,
    grantClaimAttempts: Number(row?.grantClaimAttempts) || 0,
    grantClaimsQueued: Number(row?.grantClaimsQueued) || 0,
    grantClaimsSucceeded: Number(row?.grantClaimsSucceeded) || 0,
    grantClaimsFailed: Number(row?.grantClaimsFailed) || 0,
    privateMessagesReceived: Number(row?.privateMessagesReceived) || 0,
    skillUsages: Number(row?.skillUsages) || 0,
    unresolvedEvents: Number(row?.unresolvedEvents) || 0
  };
}

export function emptyAttributionSummary(databasePath?: string, error?: string): AttributionSummary {
  const totals = emptyAttributionTotals();
  return {
    configured: Boolean(databasePath),
    databasePath,
    generatedAt: new Date().toISOString(),
    error,
    totals,
    conversionRates: rates(totals),
    groups: [],
    topRefs: []
  };
}

export async function readAttributionSummary(
  databasePath: string | undefined,
  now = new Date()
): Promise<AttributionSummary> {
  if (!databasePath) {
    return emptyAttributionSummary(undefined);
  }

  let db: SqliteDatabase | undefined;
  try {
    db = await SqliteDatabase.open(databasePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("SQLITE_CANTOPEN")) {
      return emptyAttributionSummary(databasePath, "Attribution database was not found.");
    }
    return emptyAttributionSummary(databasePath, message);
  }

  try {
    const tableRow = await db.get<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table' AND name IN ('outreach_refs', 'attribution_events')
    `);
    if ((Number(tableRow?.count) || 0) < 2) {
      return {
        ...emptyAttributionSummary(databasePath),
        configured: true,
        generatedAt: now.toISOString()
      };
    }

    const totalsRow = await db.get<{
      refs: number;
      clicks: number;
      grantChallenges: number;
      grantClaimAttempts: number;
      grantClaimsQueued: number;
      grantClaimsSucceeded: number;
      grantClaimsFailed: number;
      privateMessagesReceived: number;
      skillUsages: number;
      unresolvedEvents: number;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM outreach_refs) AS refs,
        SUM(CASE WHEN e.event_type = 'click' THEN 1 ELSE 0 END) AS clicks,
        SUM(CASE WHEN e.event_type = 'grant_challenge' THEN 1 ELSE 0 END) AS grantChallenges,
        SUM(CASE WHEN e.event_type = 'grant_claim_attempted' THEN 1 ELSE 0 END) AS grantClaimAttempts,
        SUM(CASE WHEN e.event_type = 'grant_claim_queued' THEN 1 ELSE 0 END) AS grantClaimsQueued,
        SUM(CASE WHEN e.event_type = 'grant_claim_succeeded' THEN 1 ELSE 0 END) AS grantClaimsSucceeded,
        SUM(CASE WHEN e.event_type = 'grant_claim_failed' THEN 1 ELSE 0 END) AS grantClaimsFailed,
        SUM(CASE WHEN e.event_type = 'private_message_received' THEN 1 ELSE 0 END) AS privateMessagesReceived,
        SUM(CASE WHEN e.event_type = 'skill_usage' THEN 1 ELSE 0 END) AS skillUsages,
        SUM(CASE WHEN r.ref_id IS NULL THEN 1 ELSE 0 END) AS unresolvedEvents
      FROM attribution_events e
      LEFT JOIN outreach_refs r ON r.ref_id = e.ref_id
    `);
    const totals = attributionTotalsFromRow(totalsRow);

    const groupRows = await db.all<{
      key: string;
      venue: string;
      campaignId: string;
      promptProfileId: string;
      messageStyle: string;
      layout: string;
      ctaStyle: string | null;
      promotionLevel: string | null;
      rewardEmphasis: string | null;
      refs: number;
      clicks: number;
      grantChallenges: number;
      grantClaimAttempts: number;
      grantClaimsQueued: number;
      grantClaimsSucceeded: number;
      grantClaimsFailed: number;
      privateMessagesReceived: number;
      skillUsages: number;
      unresolvedEvents: number;
    }>(`
      SELECT
        r.venue || ':' || r.campaign_id || ':' || r.prompt_profile_id || ':' || r.message_style || ':' || r.layout || ':' || COALESCE(r.cta_style, '') AS key,
        r.venue AS venue,
        r.campaign_id AS campaignId,
        r.prompt_profile_id AS promptProfileId,
        r.message_style AS messageStyle,
        r.layout AS layout,
        r.cta_style AS ctaStyle,
        r.promotion_level AS promotionLevel,
        r.reward_emphasis AS rewardEmphasis,
        COUNT(DISTINCT r.ref_id) AS refs,
        SUM(CASE WHEN e.event_type = 'click' THEN 1 ELSE 0 END) AS clicks,
        SUM(CASE WHEN e.event_type = 'grant_challenge' THEN 1 ELSE 0 END) AS grantChallenges,
        SUM(CASE WHEN e.event_type = 'grant_claim_attempted' THEN 1 ELSE 0 END) AS grantClaimAttempts,
        SUM(CASE WHEN e.event_type = 'grant_claim_queued' THEN 1 ELSE 0 END) AS grantClaimsQueued,
        SUM(CASE WHEN e.event_type = 'grant_claim_succeeded' THEN 1 ELSE 0 END) AS grantClaimsSucceeded,
        SUM(CASE WHEN e.event_type = 'grant_claim_failed' THEN 1 ELSE 0 END) AS grantClaimsFailed,
        SUM(CASE WHEN e.event_type = 'private_message_received' THEN 1 ELSE 0 END) AS privateMessagesReceived,
        SUM(CASE WHEN e.event_type = 'skill_usage' THEN 1 ELSE 0 END) AS skillUsages,
        0 AS unresolvedEvents
      FROM outreach_refs r
      LEFT JOIN attribution_events e ON e.ref_id = r.ref_id
      GROUP BY
        r.venue, r.campaign_id, r.prompt_profile_id, r.message_style, r.layout,
        r.cta_style, r.promotion_level, r.reward_emphasis
      ORDER BY skillUsages DESC, privateMessagesReceived DESC, grantClaimsSucceeded DESC, clicks DESC, refs DESC
    `);

    const refRows = await db.all<{
      refId: string;
      venue: string;
      venueAccountId: string | null;
      surface: string | null;
      contentType: string;
      campaignId: string;
      promptProfileId: string;
      promptParametersJson: string;
      messageStyle: string;
      layout: string;
      ctaStyle: string | null;
      promotionLevel: string | null;
      productSpecificity: string | null;
      rewardEmphasis: string | null;
      audience: string | null;
      candidateId: string;
      generatedContentId: string;
      remoteContentId: string | null;
      remoteContentUrl: string | null;
      utmJson: string | null;
      createdAt: string;
      updatedAt: string;
      clicks: number;
      grantChallenges: number;
      grantClaimAttempts: number;
      grantClaimsQueued: number;
      grantClaimsSucceeded: number;
      grantClaimsFailed: number;
      privateMessagesReceived: number;
      skillUsages: number;
      lastEventAt: string | null;
    }>(`
      SELECT
        r.ref_id AS refId,
        r.venue AS venue,
        r.venue_account_id AS venueAccountId,
        r.surface AS surface,
        r.content_type AS contentType,
        r.campaign_id AS campaignId,
        r.prompt_profile_id AS promptProfileId,
        r.prompt_parameters_json AS promptParametersJson,
        r.message_style AS messageStyle,
        r.layout AS layout,
        r.cta_style AS ctaStyle,
        r.promotion_level AS promotionLevel,
        r.product_specificity AS productSpecificity,
        r.reward_emphasis AS rewardEmphasis,
        r.audience AS audience,
        r.candidate_id AS candidateId,
        r.generated_content_id AS generatedContentId,
        r.remote_content_id AS remoteContentId,
        r.remote_content_url AS remoteContentUrl,
        r.utm_json AS utmJson,
        r.created_at AS createdAt,
        r.updated_at AS updatedAt,
        SUM(CASE WHEN e.event_type = 'click' THEN 1 ELSE 0 END) AS clicks,
        SUM(CASE WHEN e.event_type = 'grant_challenge' THEN 1 ELSE 0 END) AS grantChallenges,
        SUM(CASE WHEN e.event_type = 'grant_claim_attempted' THEN 1 ELSE 0 END) AS grantClaimAttempts,
        SUM(CASE WHEN e.event_type = 'grant_claim_queued' THEN 1 ELSE 0 END) AS grantClaimsQueued,
        SUM(CASE WHEN e.event_type = 'grant_claim_succeeded' THEN 1 ELSE 0 END) AS grantClaimsSucceeded,
        SUM(CASE WHEN e.event_type = 'grant_claim_failed' THEN 1 ELSE 0 END) AS grantClaimsFailed,
        SUM(CASE WHEN e.event_type = 'private_message_received' THEN 1 ELSE 0 END) AS privateMessagesReceived,
        SUM(CASE WHEN e.event_type = 'skill_usage' THEN 1 ELSE 0 END) AS skillUsages,
        MAX(e.created_at) AS lastEventAt
      FROM outreach_refs r
      LEFT JOIN attribution_events e ON e.ref_id = r.ref_id
      GROUP BY r.ref_id
      ORDER BY skillUsages DESC, privateMessagesReceived DESC, grantClaimsSucceeded DESC, clicks DESC, COALESCE(lastEventAt, r.created_at) DESC
      LIMIT 25
    `);

    return {
      configured: true,
      databasePath,
      generatedAt: now.toISOString(),
      totals,
      conversionRates: rates(totals),
      groups: groupRows.map((row) => {
        const groupTotals = attributionTotalsFromRow(row);
        return {
          key: row.key,
          venue: row.venue,
          campaignId: row.campaignId,
          promptProfileId: row.promptProfileId,
          messageStyle: row.messageStyle,
          layout: row.layout,
          ctaStyle: row.ctaStyle ?? undefined,
          promotionLevel: row.promotionLevel ?? undefined,
          rewardEmphasis: row.rewardEmphasis ?? undefined,
          refCount: groupTotals.refs,
          totals: groupTotals,
          conversionRates: rates(groupTotals)
        };
      }),
      topRefs: refRows.map((row): AttributionRefDetail => {
        const refTotals = attributionTotalsFromRow({
          refs: 1,
          clicks: row.clicks,
          grantChallenges: row.grantChallenges,
          grantClaimAttempts: row.grantClaimAttempts,
          grantClaimsQueued: row.grantClaimsQueued,
          grantClaimsSucceeded: row.grantClaimsSucceeded,
          grantClaimsFailed: row.grantClaimsFailed,
          privateMessagesReceived: row.privateMessagesReceived,
          skillUsages: row.skillUsages,
          unresolvedEvents: 0
        });
        return {
          refId: row.refId,
          venue: row.venue,
          venueAccountId: row.venueAccountId ?? undefined,
          surface: row.surface ?? undefined,
          contentType: row.contentType,
          campaignId: row.campaignId,
          promptProfileId: row.promptProfileId,
          promptParameters: sanitizeAttributionMetadata(parseJsonRecord(row.promptParametersJson)),
          messageStyle: row.messageStyle,
          layout: row.layout,
          ctaStyle: row.ctaStyle ?? undefined,
          promotionLevel: row.promotionLevel ?? undefined,
          productSpecificity: row.productSpecificity ?? undefined,
          rewardEmphasis: row.rewardEmphasis ?? undefined,
          audience: row.audience ?? undefined,
          candidateId: row.candidateId,
          generatedContentId: row.generatedContentId,
          remoteContentId: row.remoteContentId ?? undefined,
          remoteContentUrl: row.remoteContentUrl ?? undefined,
          utm: sanitizeAttributionMetadata(parseJsonRecord(row.utmJson)),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          totals: refTotals,
          conversionRates: rates(refTotals),
          lastEventAt: row.lastEventAt ?? undefined
        };
      })
    };
  } catch (error) {
    return emptyAttributionSummary(databasePath, error instanceof Error ? error.message : String(error));
  } finally {
    await db.close();
  }
}
