import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";

import sqlite3 from "sqlite3";

import { readAttributionSummary } from "../src/storage";
import { createServer } from "../src/server";
import type { AnalyticsConfig } from "../src/types";

async function execSql(databasePath: string, sql: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const db = new sqlite3.Database(databasePath, (error) => {
      if (error) {
        reject(error);
        return;
      }
      db.exec(sql, (runError) => {
        db.close(() => {
          if (runError) {
            reject(runError);
            return;
          }
          resolve();
        });
      });
    });
  });
}

function attributionSchemaSql(): string {
  return `
    CREATE TABLE outreach_refs (
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
      utm_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE attribution_events (
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
  `;
}

function populatedAttributionSql(): string {
  const prompt = JSON.stringify({
    intent: "starter-grant",
    messageStyle: "informative",
    layout: "structured",
    walletAddress: "0xshould-not-render",
    installId: "install-should-not-render",
    sessionId: "session-should-not-render"
  }).replaceAll("'", "''");
  const utm = JSON.stringify({
    source: "moltbook",
    medium: "dm",
    campaign: "campaign-a",
    content: "ref-a"
  }).replaceAll("'", "''");

  return `
    ${attributionSchemaSql()}
    INSERT INTO outreach_refs(
      ref_id, venue, venue_account_id, surface, content_type, campaign_id, prompt_profile_id,
      prompt_parameters_json, message_style, layout, cta_style, promotion_level,
      product_specificity, reward_emphasis, audience, candidate_id, generated_content_id,
      remote_content_id, remote_content_url, utm_json, created_at, updated_at
    ) VALUES (
      'ref-a', 'moltbook', 'agent-a', 'timeline', 'post', 'campaign-a', 'profile-a',
      '${prompt}', 'informative', 'structured', 'soft', 'low', 'generic', 'medium',
      'builders', 'candidate-a', 'generated-a', 'remote-a', 'https://www.moltbook.com/posts/remote-a', '${utm}',
      '2026-05-04T10:00:00.000Z', '2026-05-04T10:00:00.000Z'
    );

    INSERT INTO outreach_refs(
      ref_id, venue, venue_account_id, surface, content_type, campaign_id, prompt_profile_id,
      prompt_parameters_json, message_style, layout, cta_style, promotion_level,
      product_specificity, reward_emphasis, audience, candidate_id, generated_content_id,
      remote_content_id, remote_content_url, utm_json, created_at, updated_at
    ) VALUES (
      'ref-zero', 'moltbook', 'agent-a', 'timeline', 'reply', 'campaign-a', 'profile-a',
      '${prompt}', 'informative', 'structured', 'soft', 'low', 'generic', 'medium',
      'builders', 'candidate-zero', 'generated-zero', 'comment-zero', 'https://www.moltbook.com/posts/post-zero', '${utm}',
      '2026-05-04T10:06:00.000Z', '2026-05-04T10:06:00.000Z'
    );

    INSERT INTO attribution_events(event_id, ref_id, event_type, venue, wallet_address, install_id, session_id, skill_id, metadata_json, created_at) VALUES
      ('e-click', 'ref-a', 'click', 'moltbook', '0xabc', 'install-a', 'session-a', NULL, '{"raw":"hidden"}', '2026-05-04T10:01:00.000Z'),
      ('e-grant', 'ref-a', 'grant_challenge', 'moltbook', '0xabc', 'install-a', 'session-a', NULL, NULL, '2026-05-04T10:02:00.000Z'),
      ('e-pm', 'ref-a', 'private_message_received', 'moltbook', '0xabc', 'install-a', 'session-a', NULL, NULL, '2026-05-04T10:03:00.000Z'),
      ('e-skill', 'ref-a', 'skill_usage', 'moltbook', '0xabc', 'install-a', 'session-a', 'skill-a', NULL, '2026-05-04T10:04:00.000Z'),
      ('e-unresolved', 'missing-ref', 'click', 'moltbook', '0xabc', 'install-a', 'session-a', NULL, NULL, '2026-05-04T10:05:00.000Z');
  `;
}

function testConfig(agentRoot: string, attributionDbPath?: string): AnalyticsConfig {
  return {
    agentRoot,
    host: "127.0.0.1",
    port: 0,
    attributionDbPath,
    cotiNetwork: "testnet",
    cotiRpcUrl: "http://127.0.0.1:8545",
    contractAddress: undefined,
    cotiCacheTtlMs: 1
  };
}

test("readAttributionSummary returns empty state when database path is missing or empty", async () => {
  const missing = await readAttributionSummary(undefined, new Date("2026-05-04T12:00:00.000Z"));
  assert.equal(missing.configured, false);
  assert.equal(missing.totals.refs, 0);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "analytics-attribution-empty-"));
  const emptyDb = path.join(tempDir, "empty.sqlite");
  closeSync(openSync(emptyDb, "w"));
  try {
    const empty = await readAttributionSummary(emptyDb, new Date("2026-05-04T12:00:00.000Z"));
    assert.equal(empty.configured, true);
    assert.equal(empty.totals.refs, 0);
    assert.equal(empty.groups.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readAttributionSummary groups conversions and exposes per-ref prompt drilldown", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "analytics-attribution-"));
  const databasePath = path.join(tempDir, "attribution.sqlite");
  await execSql(databasePath, populatedAttributionSql());

  try {
    const summary = await readAttributionSummary(databasePath, new Date("2026-05-04T12:00:00.000Z"));

    assert.equal(summary.configured, true);
    assert.equal(summary.totals.refs, 2);
    assert.equal(summary.totals.clicks, 2);
    assert.equal(summary.totals.unresolvedEvents, 1);
    assert.equal(summary.totals.privateMessagesReceived, 1);
    assert.equal(summary.totals.skillUsages, 1);
    assert.equal(summary.conversionRates.clickToSkillUsage, 0.5);
    assert.equal(summary.groups[0]?.campaignId, "campaign-a");
    assert.equal(summary.groups[0]?.messageStyle, "informative");
    assert.equal(summary.groups[0]?.layout, "structured");
    assert.equal(summary.groups[0]?.conversionRates.clickToSkillUsage, 1);
    assert.equal(summary.topRefs[0]?.promptParameters.intent, "starter-grant");
    assert.equal(summary.topRefs[0]?.utm?.campaign, "campaign-a");
    assert.equal(summary.topRefs[0]?.remoteContentUrl, "https://www.moltbook.com/posts/remote-a");
    assert.equal(summary.topRefs.some((ref) => ref.refId === "ref-zero"), true);
    assert.equal("walletAddress" in summary.topRefs[0]!, false);
    assert.equal("installId" in summary.topRefs[0]!, false);
    assert.equal("sessionId" in summary.topRefs[0]!, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("attribution API and summary include attribution payload", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "analytics-attribution-api-"));
  const databasePath = path.join(tempDir, "attribution.sqlite");
  await execSql(databasePath, populatedAttributionSql());

  const server = createServer(testConfig(tempDir, databasePath));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    const attributionResponse = await fetch(`http://127.0.0.1:${port}/api/attribution`);
    const attribution = await attributionResponse.json() as { totals: { refs: number } };
    assert.equal(attributionResponse.status, 200);
    assert.equal(attribution.totals.refs, 2);

    const summaryResponse = await fetch(`http://127.0.0.1:${port}/api/summary`);
    const summary = await summaryResponse.json() as {
      config: { attributionConfigured: boolean };
      attribution: { topRefs: Array<{ refId: string }> };
    };
    assert.equal(summaryResponse.status, 200);
    assert.equal(summary.config.attributionConfigured, true);
    assert.equal(summary.attribution.topRefs.length, 2);
    assert.equal(summary.attribution.topRefs.some((ref) => ref.refId === "ref-a"), true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await rm(tempDir, { recursive: true, force: true });
  }
});
