import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import sqlite3 from "sqlite3";

import {
  readMessageFunnelSummaryFromStore,
  readAttributionSummaryFromStore,
  saveMessageFunnelEventToStore,
  saveAttributionEventToStore,
  saveOutreachRefToAttributionStore
} from "../src/attribution-store.js";
import {
  buildAttributionEvent,
  buildOutreachRef,
  buildTrackedLink,
  extractRefIdFromUrl,
  summarizeAttribution,
  type AttributionEvent
} from "../src/outreach-attribution.js";
import { DEFAULT_PROMPT_PARAMETERS } from "../src/prompt-profile.js";

async function readRemoteIdentity(databasePath: string, refId: string): Promise<{
  remoteContentId: string | null;
  remoteContentUrl: string | null;
}> {
  return await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(databasePath, (error) => {
      if (error) {
        reject(error);
        return;
      }
      db.get(
        "SELECT remote_content_id AS remoteContentId, remote_content_url AS remoteContentUrl FROM outreach_refs WHERE ref_id = ?",
        [refId],
        (queryError, row) => {
          db.close(() => {
            if (queryError) {
              reject(queryError);
              return;
            }
            resolve((row ?? { remoteContentId: null, remoteContentUrl: null }) as {
              remoteContentId: string | null;
              remoteContentUrl: string | null;
            });
          });
        }
      );
    });
  });
}

test("tracked links include stable UTM fields and full prompt/ref metadata", () => {
  const ref = buildOutreachRef({
    venue: "moltbook",
    venueAccountId: "OutreachBot",
    surface: "general",
    contentType: "post",
    promptProfileId: "aggressive-structured",
    parameters: {
      ...DEFAULT_PROMPT_PARAMETERS,
      messageStyle: "aggressive",
      layout: "structured_bullets"
    },
    campaignId: "private_messaging",
    candidateId: "create-post",
    generatedContentId: "generated-1",
    timestamp: new Date("2026-05-10T08:00:00.000Z")
  });
  const cta = buildTrackedLink({
    baseUrl: "https://example.com/agent-messaging",
    ref,
    placement: "end",
    approvedDomains: ["example.com"]
  });
  const url = new URL(cta.url);

  assert.equal(url.searchParams.get("utm_source"), "moltbook");
  assert.equal(url.searchParams.get("utm_medium"), "outreach_agent");
  assert.equal(url.searchParams.get("utm_campaign"), "private_messaging");
  assert.match(url.searchParams.get("utm_content") ?? "", /aggressive_structured/);
  assert.equal(url.searchParams.get("ref"), ref.id);
  assert.equal(extractRefIdFromUrl(cta.url), ref.id);
  assert.equal(cta.ref.venueAccountId, "OutreachBot");
  assert.equal(cta.ref.surface, "general");
  assert.equal(cta.ref.promptParameters.ctaStyle, DEFAULT_PROMPT_PARAMETERS.ctaStyle);
  assert.equal(cta.ref.messageStyle, "aggressive");
  assert.equal(cta.ref.layout, "structured_bullets");
});

test("outreach refs stay unique across repeated publishes in the same hour", () => {
  const first = buildOutreachRef({
    venue: "moltbook",
    venueAccountId: "OutreachBot",
    surface: "general",
    contentType: "post",
    promptProfileId: "technical-regular",
    parameters: DEFAULT_PROMPT_PARAMETERS,
    campaignId: "private_messaging",
    candidateId: "create-post",
    generatedContentId: "attempt-1",
    timestamp: new Date("2026-05-10T08:00:00.000Z")
  });
  const second = buildOutreachRef({
    venue: "moltbook",
    venueAccountId: "OutreachBot",
    surface: "general",
    contentType: "post",
    promptProfileId: "technical-regular",
    parameters: DEFAULT_PROMPT_PARAMETERS,
    campaignId: "private_messaging",
    candidateId: "create-post",
    generatedContentId: "attempt-2",
    timestamp: new Date("2026-05-10T08:05:00.000Z")
  });

  assert.notEqual(first.id, second.id);
  assert.notEqual(first.utm.content, second.utm.content);
});

test("shared sqlite attribution store persists refs and downstream events", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "outreach-attribution-store-"));
  const dbPath = path.join(tempDir, "attribution.sqlite");
  const ref = buildOutreachRef({
    venue: "moltbook",
    venueAccountId: "OutreachBot",
    surface: "general",
    contentType: "post",
    promptProfileId: "aggressive-structured",
    parameters: {
      ...DEFAULT_PROMPT_PARAMETERS,
      messageStyle: "aggressive",
      layout: "structured_bullets"
    },
    campaignId: "private_messaging",
    candidateId: "create-post",
    generatedContentId: "generated-1",
    timestamp: new Date("2026-05-10T08:00:00.000Z")
  });

  try {
    await saveOutreachRefToAttributionStore(dbPath, ref);
    await saveAttributionEventToStore(
      dbPath,
      buildAttributionEvent({
        refId: ref.id,
        type: "private_message_received"
      })
    );
    await saveAttributionEventToStore(
      dbPath,
      buildAttributionEvent({
        refId: ref.id,
        type: "skill_usage",
        skillId: "private-message-send"
      })
    );

    const summary = await readAttributionSummaryFromStore(dbPath, {
      campaignId: "private_messaging"
    });

    assert.equal(summary.groups.length, 1);
    assert.equal(summary.groups[0]?.promptProfileId, "aggressive-structured");
    assert.equal(summary.groups[0]?.messageStyle, "aggressive");
    assert.equal(summary.groups[0]?.layout, "structured_bullets");
    assert.equal(summary.groups[0]?.privateMessagesReceived, 1);
    assert.equal(summary.groups[0]?.skillUsages, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("shared sqlite attribution store backfills remote content identity on ref upsert", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "outreach-attribution-upsert-"));
  const dbPath = path.join(tempDir, "attribution.sqlite");
  const ref = buildOutreachRef({
    venue: "moltbook",
    venueAccountId: "OutreachBot",
    surface: "general",
    contentType: "post",
    promptProfileId: "technical-regular",
    parameters: DEFAULT_PROMPT_PARAMETERS,
    campaignId: "private_messaging",
    candidateId: "create-post",
    generatedContentId: "generated-remote"
  });

  try {
    await saveOutreachRefToAttributionStore(dbPath, ref);
    await saveOutreachRefToAttributionStore(dbPath, {
      ...ref,
      remoteContentId: "remote-post-1",
      remoteContentUrl: "https://www.moltbook.com/post/remote-post-1"
    });

    const stored = await readRemoteIdentity(dbPath, ref.id);
    assert.equal(stored.remoteContentId, "remote-post-1");
    assert.equal(stored.remoteContentUrl, "https://www.moltbook.com/post/remote-post-1");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("message funnel ledger tracks stage timestamps by cohort and variants", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "outreach-message-funnel-"));
  const dbPath = path.join(tempDir, "attribution.sqlite");

  try {
    await saveMessageFunnelEventToStore(dbPath, {
      messageId: "msg-1",
      refId: "mo_ref1",
      stage: "sent",
      cohort: "top-10",
      contentVariant: "integration-first",
      ctaVariant: "quickstart",
      recipient: "BuilderA",
      occurredAt: new Date("2026-05-12T08:00:00.000Z")
    });
    await saveMessageFunnelEventToStore(dbPath, {
      messageId: "msg-1",
      refId: "mo_ref1",
      stage: "delivered",
      occurredAt: new Date("2026-05-12T08:01:00.000Z")
    });
    await saveMessageFunnelEventToStore(dbPath, {
      messageId: "msg-1",
      refId: "mo_ref1",
      stage: "parsed",
      occurredAt: new Date("2026-05-12T08:02:00.000Z")
    });
    await saveMessageFunnelEventToStore(dbPath, {
      messageId: "msg-2",
      refId: "mo_ref2",
      stage: "sent",
      cohort: "top-10",
      contentVariant: "integration-first",
      ctaVariant: "quickstart"
    });

    const summary = await readMessageFunnelSummaryFromStore(dbPath);

    assert.deepEqual(summary.totals, {
      sent: 2,
      delivered: 1,
      parsed: 1,
      replied: 0,
      converted: 0
    });
    assert.equal(summary.cohorts[0]?.cohort, "top-10");
    assert.equal(summary.cohorts[0]?.contentVariant, "integration-first");
    assert.equal(summary.cohorts[0]?.ctaVariant, "quickstart");
    assert.equal(summary.cohorts[0]?.sent, 2);
    assert.equal(summary.cohorts[0]?.parsedRate, 0.5);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("attribution summary groups clicks and private messages by style and layout", () => {
  const ref = buildOutreachRef({
    venue: "moltbook",
    contentType: "comment",
    promptProfileId: "technical-regular",
    parameters: {
      ...DEFAULT_PROMPT_PARAMETERS,
      messageStyle: "technical",
      layout: "regular_paragraph"
    },
    campaignId: "private_messaging",
    candidateId: "comment-1",
    generatedContentId: "generated-2",
    timestamp: new Date("2026-05-10T08:00:00.000Z")
  });
  const events: AttributionEvent[] = [
    { refId: ref.id, type: "click", occurredAt: "2026-05-10T08:01:00.000Z" },
    { refId: ref.id, type: "click", occurredAt: "2026-05-10T08:02:00.000Z" },
    { refId: ref.id, type: "private_message", occurredAt: "2026-05-10T08:03:00.000Z" },
    buildAttributionEvent({
      refId: ref.id,
      type: "grant_request",
      occurredAt: new Date("2026-05-10T08:04:00.000Z"),
      walletAddress: "0xabc"
    }),
    buildAttributionEvent({
      refId: ref.id,
      type: "skill_usage",
      occurredAt: new Date("2026-05-10T08:05:00.000Z"),
      skillId: "private-message-send"
    })
  ];

  const summary = summarizeAttribution({
    refs: [ref],
    events,
    now: new Date("2026-05-10T09:00:00.000Z")
  });

  assert.equal(summary.groups.length, 1);
  assert.equal(summary.groups[0]?.clicks, 2);
  assert.equal(summary.groups[0]?.privateMessages, 1);
  assert.equal(summary.groups[0]?.grantRequests, 1);
  assert.equal(summary.groups[0]?.skillUsages, 1);
  assert.equal(summary.groups[0]?.clickToPrivateMessageRate, 0.5);
  assert.equal(summary.groups[0]?.clickToSkillUsageRate, 0.5);
  assert.equal(summary.groups[0]?.messageStyle, "technical");
  assert.equal(summary.groups[0]?.layout, "regular_paragraph");
});

test("manual no-link refs preserve attribution mode and PM escalation metadata", () => {
  const ref = buildOutreachRef({
    venue: "reddit",
    contentType: "reply",
    promptProfileId: "reddit-value-first",
    parameters: {
      ...DEFAULT_PROMPT_PARAMETERS,
      messageStyle: "informative",
      layout: "question_answer"
    },
    campaignId: "private_messaging",
    candidateId: "reddit-thread-1",
    generatedContentId: "reddit-reply-1",
    attributionMode: "manual_ref",
    publicValueDeliveredFirst: true,
    privateMessageEscalationReason: "privacy_sensitive",
    timestamp: new Date("2026-05-10T08:00:00.000Z")
  });

  assert.equal(ref.attributionMode, "manual_ref");
  assert.equal(ref.publicValueDeliveredFirst, true);
  assert.equal(ref.privateMessageEscalationReason, "privacy_sensitive");

  const summary = summarizeAttribution({
    refs: [ref],
    events: [buildAttributionEvent({ refId: ref.id, type: "private_message_received" })],
    now: new Date("2026-05-10T09:00:00.000Z")
  });

  assert.equal(summary.groups[0]?.attributionMode, "manual_ref");
  assert.equal(summary.groups[0]?.privateMessageEscalationReason, "privacy_sensitive");
  assert.equal(summary.groups[0]?.publicValueDeliveredFirst, true);
});
