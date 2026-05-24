import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import sqlite3 from "sqlite3";

export type StarterGrantAttributionEventType =
  | "click"
  | "grant_challenge"
  | "grant_claim_attempted"
  | "grant_claim_queued"
  | "grant_claim_succeeded"
  | "grant_claim_failed"
  | "private_message_received"
  | "skill_usage";

export interface StarterGrantOutreachRef {
  id: string;
  venue: string;
  venueAccountId?: string;
  surface?: string;
  contentType: string;
  campaignId: string;
  promptProfileId: string;
  promptParameters: Record<string, unknown>;
  messageStyle: string;
  layout: string;
  ctaStyle?: string;
  promotionLevel?: string;
  productSpecificity?: string;
  rewardEmphasis?: string;
  audience?: string;
  candidateId: string;
  generatedContentId: string;
  remoteContentId?: string;
  remoteContentUrl?: string;
  attributionMode?: string;
  publicValueDeliveredFirst?: boolean;
  privateMessageEscalationReason?: string;
  utm?: Record<string, unknown>;
  createdAt?: string;
}

export interface StarterGrantAttributionEventInput {
  refId: string;
  type: StarterGrantAttributionEventType;
  venue?: string;
  walletAddress?: string;
  installId?: string;
  sessionId?: string;
  skillId?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

export interface StarterGrantAttributionSummary {
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
    attributionMode: string;
    publicValueDeliveredFirst: boolean;
    privateMessageEscalationReason?: string;
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

export function validateAttributionRefId(refId: string): string {
  const trimmed = refId.trim();
  if (!/^[A-Za-z0-9_-]{3,96}$/u.test(trimmed)) {
    throw new Error("Invalid attribution ref. Expected 3-96 URL-safe characters.");
  }
  return trimmed;
}

export function parseAttributionEventType(value: string): StarterGrantAttributionEventType {
  if (
    value === "click" ||
    value === "grant_challenge" ||
    value === "grant_claim_attempted" ||
    value === "grant_claim_queued" ||
    value === "grant_claim_succeeded" ||
    value === "grant_claim_failed" ||
    value === "private_message_received" ||
    value === "skill_usage"
  ) {
    return value;
  }
  throw new Error(`Unsupported attribution event type: ${value}`);
}

export class StarterGrantAttributionStore {
  constructor(private readonly databasePath: string) {}

  async upsertOutreachRef(ref: StarterGrantOutreachRef): Promise<void> {
    const db = await this.open();
    try {
      await db.transaction(async () => {
        await upsertOutreachRef(db, ref);
      });
    } finally {
      await db.close();
    }
  }

  async hasOutreachRef(refId: string): Promise<boolean> {
    const db = await this.open();
    try {
      const rows = await db.all<{ ref_id: string }>(
        "SELECT ref_id FROM outreach_refs WHERE ref_id = ? LIMIT 1",
        [validateAttributionRefId(refId)]
      );
      return rows.length > 0;
    } finally {
      await db.close();
    }
  }

  async recordEvent(input: StarterGrantAttributionEventInput): Promise<void> {
    const db = await this.open();
    try {
      await db.transaction(async () => {
        await recordAttributionEvent(db, input);
      });
    } finally {
      await db.close();
    }
  }

  async upsertWalletAttribution(input: {
    walletAddress: string;
    refId: string;
    claimedAt?: Date;
  }): Promise<void> {
    const db = await this.open();
    try {
      await db.transaction(async () => {
        await upsertWalletAttribution(db, input);
      });
    } finally {
      await db.close();
    }
  }

  async lookupRefForWallet(walletAddress: string): Promise<string | undefined> {
    const db = await this.open();
    try {
      const rows = await db.all<{ ref_id: string }>(
        `
          SELECT ref_id
          FROM wallet_attribution
          WHERE wallet_address = ?
          LIMIT 1
        `,
        [walletAddress.toLowerCase()]
      );
      return rows[0]?.ref_id;
    } finally {
      await db.close();
    }
  }

  async summarize(input: { campaignId?: string } = {}): Promise<StarterGrantAttributionSummary> {
    const db = await this.open();
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
        attribution_mode: string;
        public_value_delivered_first: number | null;
        private_message_escalation_reason: string | null;
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
            COALESCE(r.layout, 'unresolved') || ':' ||
            COALESCE(r.attribution_mode, 'tracked_link') || ':' ||
            CASE COALESCE(r.public_value_delivered_first, 1) WHEN 1 THEN 'public_first' ELSE 'private_first' END || ':' ||
            COALESCE(r.private_message_escalation_reason, 'none') AS key,
            COUNT(DISTINCT r.ref_id) AS ref_count,
            SUM(CASE WHEN r.ref_id IS NULL THEN 1 ELSE 0 END) AS unresolved_event_count,
            COALESCE(r.venue, e.venue, 'unresolved') AS venue,
            COALESCE(r.campaign_id, 'unresolved') AS campaign_id,
            COALESCE(r.prompt_profile_id, 'unresolved') AS prompt_profile_id,
            COALESCE(r.message_style, 'unresolved') AS message_style,
            COALESCE(r.layout, 'unresolved') AS layout,
          COALESCE(r.attribution_mode, 'tracked_link') AS attribution_mode,
          COALESCE(r.public_value_delivered_first, 1) AS public_value_delivered_first,
          r.private_message_escalation_reason AS private_message_escalation_reason,
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
          GROUP BY 1, 4, 5, 6, 7, 8, 9, 10, 11
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
          attributionMode: row.attribution_mode,
          publicValueDeliveredFirst: Number(row.public_value_delivered_first ?? 1) !== 0,
          privateMessageEscalationReason: row.private_message_escalation_reason ?? undefined,
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

  private async open(): Promise<SqliteDatabase> {
    const db = await SqliteDatabase.open(this.databasePath);
    await ensureAttributionSchema(db);
    return db;
  }
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
      remote_content_url TEXT,
      attribution_mode TEXT,
      public_value_delivered_first INTEGER,
      private_message_escalation_reason TEXT,
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

    CREATE TABLE IF NOT EXISTS wallet_attribution (
      wallet_address TEXT PRIMARY KEY,
      ref_id TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS wallet_attribution_ref_idx
      ON wallet_attribution(ref_id, claimed_at);
  `);
  await ensureColumn(db, "outreach_refs", "remote_content_url", "TEXT");
  await ensureColumn(db, "outreach_refs", "attribution_mode", "TEXT");
  await ensureColumn(db, "outreach_refs", "public_value_delivered_first", "INTEGER");
  await ensureColumn(db, "outreach_refs", "private_message_escalation_reason", "TEXT");
}

async function upsertOutreachRef(db: SqliteDatabase, ref: StarterGrantOutreachRef): Promise<void> {
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
        remote_content_url,
        attribution_mode,
        public_value_delivered_first,
        private_message_escalation_reason,
        utm_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ref_id) DO UPDATE SET
        remote_content_id = COALESCE(excluded.remote_content_id, outreach_refs.remote_content_id),
        remote_content_url = COALESCE(excluded.remote_content_url, outreach_refs.remote_content_url),
        attribution_mode = COALESCE(excluded.attribution_mode, outreach_refs.attribution_mode),
        public_value_delivered_first = COALESCE(
          excluded.public_value_delivered_first,
          outreach_refs.public_value_delivered_first
        ),
        private_message_escalation_reason = COALESCE(
          excluded.private_message_escalation_reason,
          outreach_refs.private_message_escalation_reason
        ),
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
      ref.remoteContentUrl ?? null,
      ref.attributionMode ?? null,
      ref.publicValueDeliveredFirst === undefined ? null : ref.publicValueDeliveredFirst ? 1 : 0,
      ref.privateMessageEscalationReason ?? null,
      ref.utm ? JSON.stringify(ref.utm) : null,
      ref.createdAt ?? now,
      now
    ]
  );
}

async function ensureColumn(
  db: SqliteDatabase,
  tableName: string,
  columnName: string,
  columnDefinition: string
): Promise<void> {
  const columns = await db.all<{ name: string }>(`PRAGMA table_info(${tableName})`);
  if (columns.some((column) => column.name === columnName)) {
    return;
  }
  await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}

async function upsertWalletAttribution(
  db: SqliteDatabase,
  input: {
    walletAddress: string;
    refId: string;
    claimedAt?: Date;
  }
): Promise<void> {
  const walletAddress = input.walletAddress.toLowerCase();
  const refId = validateAttributionRefId(input.refId);
  const claimedAt = (input.claimedAt ?? new Date()).toISOString();
  await db.run(
    `
      INSERT INTO wallet_attribution(wallet_address, ref_id, claimed_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(wallet_address) DO UPDATE SET
        ref_id = excluded.ref_id,
        claimed_at = excluded.claimed_at,
        updated_at = excluded.updated_at
    `,
    [walletAddress, refId, claimedAt, claimedAt]
  );
}

async function recordAttributionEvent(
  db: SqliteDatabase,
  input: StarterGrantAttributionEventInput
): Promise<void> {
  const refId = validateAttributionRefId(input.refId);
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
      input.type,
      input.venue ?? null,
      input.walletAddress ?? null,
      input.installId ?? null,
      input.sessionId ?? null,
      input.skillId ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      (input.occurredAt ?? new Date()).toISOString()
    ]
  );
}
