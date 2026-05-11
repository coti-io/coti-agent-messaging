import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import {
  readAttributionSummaryFromStore,
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
