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

export type MessageFunnelStage = "sent" | "delivered" | "parsed" | "replied" | "converted";

export interface MessageFunnelEventInput {
  messageId: string;
  refId: string;
  stage: MessageFunnelStage;
  occurredAt?: Date;
  recipient?: string;
  cohort?: string;
  contentVariant?: string;
  ctaVariant?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface MessageFunnelSummary {
  generatedAt: string;
  totals: {
    sent: number;
    delivered: number;
    parsed: number;
    replied: number;
    converted: number;
  };
  cohorts: Array<{
    cohort: string;
    contentVariant: string;
    ctaVariant: string;
    sent: number;
    delivered: number;
    parsed: number;
    replied: number;
    converted: number;
    deliveredRate: number;
    parsedRate: number;
    repliedRate: number;
    convertedRate: number;
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

export async function saveMessageFunnelEventToStore(
  databasePath: string | undefined,
  event: MessageFunnelEventInput
): Promise<void> {
  if (!databasePath) {
    return;
  }
  const db = await openAttributionDatabase(databasePath);
  try {
    await db.transaction(async () => {
      await recordMessageFunnelEvent(db, event);
    });
  } finally {
    await db.close();
  }
}

export async function readMessageFunnelSummaryFromStore(databasePath: string): Promise<MessageFunnelSummary> {
  const db = await openAttributionDatabase(databasePath);
  try {
    const [totals] = await db.all<{
      sent: number;
      delivered: number;
      parsed: number;
      replied: number;
      converted: number;
    }>(`
      SELECT
        COUNT(sent_at) AS sent,
        COUNT(delivered_at) AS delivered,
        COUNT(parsed_at) AS parsed,
        COUNT(replied_at) AS replied,
        COUNT(converted_at) AS converted
      FROM outbound_message_funnel
    `);
    const rows = await db.all<{
      cohort: string;
      content_variant: string;
      cta_variant: string;
      sent: number;
      delivered: number;
      parsed: number;
      replied: number;
      converted: number;
    }>(`
      SELECT
        COALESCE(cohort, 'unassigned') AS cohort,
        COALESCE(content_variant, 'unassigned') AS content_variant,
        COALESCE(cta_variant, 'unassigned') AS cta_variant,
        COUNT(sent_at) AS sent,
        COUNT(delivered_at) AS delivered,
        COUNT(parsed_at) AS parsed,
        COUNT(replied_at) AS replied,
        COUNT(converted_at) AS converted
      FROM outbound_message_funnel
      GROUP BY 1, 2, 3
      ORDER BY converted DESC, replied DESC, parsed DESC, sent DESC, cohort ASC
    `);

    return {
      generatedAt: new Date().toISOString(),
      totals: {
        sent: Number(totals?.sent) || 0,
        delivered: Number(totals?.delivered) || 0,
        parsed: Number(totals?.parsed) || 0,
        replied: Number(totals?.replied) || 0,
        converted: Number(totals?.converted) || 0
      },
      cohorts: rows.map((row) => {
        const sent = Number(row.sent) || 0;
        const delivered = Number(row.delivered) || 0;
        const parsed = Number(row.parsed) || 0;
        const replied = Number(row.replied) || 0;
        const converted = Number(row.converted) || 0;
        return {
          cohort: row.cohort,
          contentVariant: row.content_variant,
          ctaVariant: row.cta_variant,
          sent,
          delivered,
          parsed,
          replied,
          converted,
          deliveredRate: sent === 0 ? 0 : delivered / sent,
          parsedRate: sent === 0 ? 0 : parsed / sent,
          repliedRate: sent === 0 ? 0 : replied / sent,
          convertedRate: sent === 0 ? 0 : converted / sent
        };
      })
    };
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

    CREATE TABLE IF NOT EXISTS outbound_message_funnel (
      message_id TEXT PRIMARY KEY,
      ref_id TEXT NOT NULL,
      recipient TEXT,
      cohort TEXT,
      content_variant TEXT,
      cta_variant TEXT,
      sent_at TEXT,
      delivered_at TEXT,
      parsed_at TEXT,
      replied_at TEXT,
      converted_at TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS outbound_message_funnel_ref_idx
      ON outbound_message_funnel(ref_id, sent_at);
    CREATE INDEX IF NOT EXISTS outbound_message_funnel_cohort_idx
      ON outbound_message_funnel(cohort, content_variant, cta_variant);
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

async function recordMessageFunnelEvent(db: SqliteDatabase, event: MessageFunnelEventInput): Promise<void> {
  const stageColumn = stageToColumn(event.stage);
  const now = new Date().toISOString();
  const occurredAt = (event.occurredAt ?? new Date()).toISOString();
  const refId = validateAttributionRefId(event.refId);
  await db.run(
    `
      INSERT INTO outbound_message_funnel(
        message_id,
        ref_id,
        recipient,
        cohort,
        content_variant,
        cta_variant,
        ${stageColumn},
        metadata_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        ref_id = COALESCE(excluded.ref_id, outbound_message_funnel.ref_id),
        recipient = COALESCE(excluded.recipient, outbound_message_funnel.recipient),
        cohort = COALESCE(excluded.cohort, outbound_message_funnel.cohort),
        content_variant = COALESCE(excluded.content_variant, outbound_message_funnel.content_variant),
        cta_variant = COALESCE(excluded.cta_variant, outbound_message_funnel.cta_variant),
        ${stageColumn} = COALESCE(outbound_message_funnel.${stageColumn}, excluded.${stageColumn}),
        metadata_json = COALESCE(excluded.metadata_json, outbound_message_funnel.metadata_json),
        updated_at = excluded.updated_at
    `,
    [
      event.messageId,
      refId,
      event.recipient ?? null,
      event.cohort ?? null,
      event.contentVariant ?? null,
      event.ctaVariant ?? null,
      occurredAt,
      event.metadata ? JSON.stringify(event.metadata) : null,
      now,
      now
    ]
  );
}

function stageToColumn(stage: MessageFunnelStage): string {
  switch (stage) {
    case "sent":
      return "sent_at";
    case "delivered":
      return "delivered_at";
    case "parsed":
      return "parsed_at";
    case "replied":
      return "replied_at";
    case "converted":
      return "converted_at";
  }
}
