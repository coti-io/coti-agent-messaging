import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import sqlite3 from "sqlite3";

import type { AttributionEvent, OutreachRef } from "./outreach-attribution.js";

interface SqliteRow {
  [key: string]: unknown;
}

class SqliteDatabase {
  constructor(private readonly db: sqlite3.Database) {}

  static async open(databasePath: string): Promise<SqliteDatabase> {
    if (databasePath !== ":memory:") {
      await mkdir(path.dirname(databasePath), { recursive: true });
    }
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

export interface StoredAttributionSummary {
  generatedAt: string;
  groups: Array<{
    key: string;
    refCount: number;
    unresolvedEventCount: number;
    venue: string;
    campaignId: string;
    promptProfileId: string;
    messageStyle: string;
    layout: string;
    clicks: number;
    grantChallenges: number;
    grantClaimAttempts: number;
    grantClaimsQueued: number;
    grantClaimsSucceeded: number;
    grantClaimsFailed: number;
    privateMessagesReceived: number;
    skillUsages: number;
  }>;
}

export function validateAttributionRefId(refId: string): string {
  const trimmed = refId.trim();
  if (!/^[A-Za-z0-9_-]{3,96}$/u.test(trimmed)) {
    throw new Error("Invalid attribution ref. Expected 3-96 URL-safe characters.");
  }
  return trimmed;
}

export async function saveOutreachRefToAttributionStore(
  databasePath: string | undefined,
  ref: OutreachRef
): Promise<void> {
  if (!databasePath) {
    return;
  }
  const db = await openAttributionDatabase(databasePath);
  try {
    await db.transaction(async () => {
      await upsertOutreachRef(db, ref);
    });
  } finally {
    await db.close();
  }
}

export async function saveAttributionEventToStore(
  databasePath: string | undefined,
  event: AttributionEvent
): Promise<void> {
  if (!databasePath) {
    return;
  }
  const db = await openAttributionDatabase(databasePath);
  try {
    await db.transaction(async () => {
      await recordAttributionEvent(db, event);
    });
  } finally {
    await db.close();
  }
}

export async function readAttributionSummaryFromStore(
  databasePath: string,
  input: { campaignId?: string } = {}
): Promise<StoredAttributionSummary> {
  const db = await openAttributionDatabase(databasePath);
  try {
    const filters: string[] = [];
    const params: unknown[] = [];
    if (input.campaignId) {
      filters.push("r.campaign_id = ?");
      params.push(input.campaignId);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = await db.all<{
      key: string;
      ref_count: number;
      unresolved_event_count: number;
      venue: string;
      campaign_id: string;
      prompt_profile_id: string;
      message_style: string;
      layout: string;
      clicks: number;
      grant_challenges: number;
      grant_claim_attempts: number;
      grant_claims_queued: number;
      grant_claims_succeeded: number;
      grant_claims_failed: number;
      private_messages_received: number;
      skill_usages: number;
    }>(
      `
        SELECT
          COALESCE(r.venue, e.venue, 'unresolved') || ':' ||
          COALESCE(r.campaign_id, 'unresolved') || ':' ||
          COALESCE(r.prompt_profile_id, 'unresolved') || ':' ||
          COALESCE(r.message_style, 'unresolved') || ':' ||
          COALESCE(r.layout, 'unresolved') AS key,
          COUNT(DISTINCT r.ref_id) AS ref_count,
          SUM(CASE WHEN r.ref_id IS NULL THEN 1 ELSE 0 END) AS unresolved_event_count,
          COALESCE(r.venue, e.venue, 'unresolved') AS venue,
          COALESCE(r.campaign_id, 'unresolved') AS campaign_id,
          COALESCE(r.prompt_profile_id, 'unresolved') AS prompt_profile_id,
          COALESCE(r.message_style, 'unresolved') AS message_style,
          COALESCE(r.layout, 'unresolved') AS layout,
          SUM(CASE WHEN e.event_type = 'click' THEN 1 ELSE 0 END) AS clicks,
          SUM(CASE WHEN e.event_type = 'grant_challenge' THEN 1 ELSE 0 END) AS grant_challenges,
          SUM(CASE WHEN e.event_type = 'grant_claim_attempted' THEN 1 ELSE 0 END) AS grant_claim_attempts,
          SUM(CASE WHEN e.event_type = 'grant_claim_queued' THEN 1 ELSE 0 END) AS grant_claims_queued,
          SUM(CASE WHEN e.event_type = 'grant_claim_succeeded' THEN 1 ELSE 0 END) AS grant_claims_succeeded,
          SUM(CASE WHEN e.event_type = 'grant_claim_failed' THEN 1 ELSE 0 END) AS grant_claims_failed,
          SUM(CASE WHEN e.event_type = 'private_message_received' THEN 1 ELSE 0 END) AS private_messages_received,
          SUM(CASE WHEN e.event_type = 'skill_usage' THEN 1 ELSE 0 END) AS skill_usages
        FROM attribution_events e
        LEFT JOIN outreach_refs r ON r.ref_id = e.ref_id
        ${where}
        GROUP BY 1, 4, 5, 6, 7, 8
        ORDER BY skill_usages DESC, private_messages_received DESC, clicks DESC, key ASC
      `,
      params
    );

    return {
      generatedAt: new Date().toISOString(),
      groups: rows.map((row) => ({
        key: row.key,
        refCount: Number(row.ref_count) || 0,
        unresolvedEventCount: Number(row.unresolved_event_count) || 0,
        venue: row.venue,
        campaignId: row.campaign_id,
        promptProfileId: row.prompt_profile_id,
        messageStyle: row.message_style,
        layout: row.layout,
        clicks: Number(row.clicks) || 0,
        grantChallenges: Number(row.grant_challenges) || 0,
        grantClaimAttempts: Number(row.grant_claim_attempts) || 0,
        grantClaimsQueued: Number(row.grant_claims_queued) || 0,
        grantClaimsSucceeded: Number(row.grant_claims_succeeded) || 0,
        grantClaimsFailed: Number(row.grant_claims_failed) || 0,
        privateMessagesReceived: Number(row.private_messages_received) || 0,
        skillUsages: Number(row.skill_usages) || 0
      }))
    };
  } finally {
    await db.close();
  }
}

async function openAttributionDatabase(databasePath: string): Promise<SqliteDatabase> {
  const db = await SqliteDatabase.open(databasePath);
  await ensureAttributionSchema(db);
  return db;
}

async function ensureAttributionSchema(db: SqliteDatabase): Promise<void> {
  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS outreach_refs (
      ref_id TEXT PRIMARY KEY,
      venue TEXT NOT NULL,
      venue_account_id TEXT,
      surface TEXT,
      content_type TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      prompt_profile_id TEXT NOT NULL,
      prompt_parameters_json TEXT NOT NULL,
      message_style TEXT NOT NULL,
      layout TEXT NOT NULL,
      cta_style TEXT,
      promotion_level TEXT,
      product_specificity TEXT,
      reward_emphasis TEXT,
      audience TEXT,
      candidate_id TEXT NOT NULL,
      generated_content_id TEXT NOT NULL,
      remote_content_id TEXT,
      utm_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attribution_events (
      event_id TEXT PRIMARY KEY,
      ref_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      venue TEXT,
      wallet_address TEXT,
      install_id TEXT,
      session_id TEXT,
      skill_id TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS attribution_events_ref_idx
      ON attribution_events(ref_id, created_at);
    CREATE INDEX IF NOT EXISTS attribution_events_type_idx
      ON attribution_events(event_type, created_at);
  `);
}

async function upsertOutreachRef(db: SqliteDatabase, ref: OutreachRef): Promise<void> {
  const now = new Date().toISOString();
  const refId = validateAttributionRefId(ref.id);
  await db.run(
    `
      INSERT INTO outreach_refs(
        ref_id,
        venue,
        venue_account_id,
        surface,
        content_type,
        campaign_id,
        prompt_profile_id,
        prompt_parameters_json,
        message_style,
        layout,
        cta_style,
        promotion_level,
        product_specificity,
        reward_emphasis,
        audience,
        candidate_id,
        generated_content_id,
        remote_content_id,
        utm_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ref_id) DO UPDATE SET
        remote_content_id = COALESCE(excluded.remote_content_id, outreach_refs.remote_content_id),
        utm_json = COALESCE(excluded.utm_json, outreach_refs.utm_json),
        updated_at = excluded.updated_at
    `,
    [
      refId,
      ref.venue,
      ref.venueAccountId ?? null,
      ref.surface ?? null,
      ref.contentType,
      ref.campaignId,
      ref.promptProfileId,
      JSON.stringify(ref.promptParameters),
      ref.messageStyle,
      ref.layout,
      ref.ctaStyle ?? null,
      ref.promotionLevel ?? null,
      ref.productSpecificity ?? null,
      ref.rewardEmphasis ?? null,
      ref.audience ?? null,
      ref.candidateId,
      ref.generatedContentId,
      ref.remoteContentId ?? null,
      JSON.stringify(ref.utm),
      now,
      now
    ]
  );
}

async function recordAttributionEvent(db: SqliteDatabase, event: AttributionEvent): Promise<void> {
  const refId = validateAttributionRefId(event.refId);
  await db.run(
    `
      INSERT INTO attribution_events(
        event_id,
        ref_id,
        event_type,
        venue,
        wallet_address,
        install_id,
        session_id,
        skill_id,
        metadata_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      randomUUID(),
      refId,
      event.type,
      event.venue ?? null,
      event.walletAddress ?? null,
      event.installId ?? null,
      event.sessionId ?? null,
      event.skillId ?? null,
      event.metadata ? JSON.stringify(event.metadata) : null,
      event.occurredAt
    ]
  );
}
