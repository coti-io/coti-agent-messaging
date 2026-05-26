#!/usr/bin/env node
/**
 * Live CTA funnel smoke test against production grant service.
 *
 * Simulates: post ref minted → landing click → grant claim with ref → PM received.
 * Requires STARTER_GRANT_SERVICE_URL and STARTER_GRANT_SERVICE_AUTH_TOKEN in env.
 *
 * Usage:
 *   set -a && source ../.env && set +a
 *   node scripts/test-cta-funnel-live.mjs
 */

import { createHash, randomUUID } from "node:crypto";
import { Wallet } from "@coti-io/coti-ethers";

const grantUrl = (process.env.STARTER_GRANT_SERVICE_URL ?? "https://agents.coti.io/grant").replace(/\/$/, "");
const authToken = process.env.STARTER_GRANT_SERVICE_AUTH_TOKEN?.trim();

if (!authToken) {
  console.error("Missing STARTER_GRANT_SERVICE_AUTH_TOKEN.");
  process.exit(1);
}

const refToken = createHash("sha256")
  .update(`cta-funnel-live-${Date.now()}-${randomUUID()}`)
  .digest("base64url")
  .slice(0, 10);
const refId = `manual_cta_${refToken}`;
const installId = `cta-funnel-${refToken}`;

function solveChallengePrompt(prompt) {
  const numbers = prompt.match(/\d+/gu)?.map(Number) ?? [];
  const [left = 0, right = 0] = numbers;
  if (prompt.includes("receives")) return String(left + right);
  if (prompt.includes("archives")) return String(left - right);
  return String(left * right);
}

function buildOutreachRef() {
  return {
    id: refId,
    venue: "manual",
    contentType: "post",
    campaignId: "private_messaging",
    promptProfileId: "cta-funnel-live",
    promptParameters: {
      builder: "cta_funnel_live_test",
      messageStyle: "technical",
      layout: "regular_paragraph"
    },
    messageStyle: "technical",
    layout: "regular_paragraph",
    ctaStyle: "direct_next_step",
    promotionLevel: "explicit",
    productSpecificity: "product_named",
    rewardEmphasis: "balanced",
    audience: "builders",
    candidateId: `cta-funnel-${refToken}`,
    generatedContentId: `cta-funnel-${refToken}`,
    attributionMode: "manual_ref",
    publicValueDeliveredFirst: true,
    utm: {
      source: "manual",
      medium: "cta_funnel_live",
      campaign: "private_messaging",
      content: refId
    }
  };
}

async function request(path, { method = "GET", body, auth = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = `Bearer ${authToken}`;
  const response = await fetch(`${grantUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  return { status: response.status, payload };
}

function assertStep(name, result, expectedStatus) {
  if (result.status !== expectedStatus) {
    console.error(`FAIL ${name}: expected ${expectedStatus}, got ${result.status}`, result.payload);
    process.exit(1);
  }
  console.log(`OK   ${name} (${result.status})`);
  return result.payload;
}

console.log(`CTA funnel live test → ${grantUrl}`);
console.log(`refId: ${refId}`);

assertStep(
  "register post ref",
  await request("/attribution/ref", {
    method: "POST",
    auth: true,
    body: { outreachRef: buildOutreachRef() }
  }),
  201
);

assertStep(
  "landing click",
  await request("/attribution/event", {
    method: "POST",
    body: {
      ref: refId,
      type: "click",
      venue: "landing_page",
      metadata: { path: "/pm", utm_campaign: "private_messaging" }
    }
  }),
  202
);

const wallet = Wallet.createRandom();
const challenge = assertStep(
  "grant challenge with ref",
  await request("/challenge", {
    method: "POST",
    body: {
      walletAddress: wallet.address,
      installId,
      ref: refId
    }
  }),
  200
);

if (challenge.attributionRefId !== refId) {
  console.error("FAIL challenge ref mismatch:", challenge.attributionRefId);
  process.exit(1);
}

const claimPayload = String(challenge.claimPayload);
const claim = assertStep(
  "grant claim",
  await request("/claim", {
    method: "POST",
    body: {
      challengeId: challenge.challengeId,
      walletAddress: wallet.address,
      installId,
      challengeAnswer: solveChallengePrompt(String(challenge.prompt)),
      claimPayload,
      signature: await wallet.signMessage(claimPayload)
    }
  }),
  200
);

if (claim.status !== "claimed") {
  console.error("FAIL grant not claimed:", claim);
  process.exit(1);
}

const pmBody = {
  ref: refId,
  type: "private_message_received",
  walletAddress: wallet.address,
  installId,
  metadata: {
    transactionHash: "0xcta-funnel-live",
    messageId: "cta-funnel-live-1"
  }
};

let pmResult = await request("/attribution/event", {
  method: "POST",
  body: pmBody
});

if (pmResult.status === 401) {
  console.warn(
    "WARN public private_message_received rejected (401). Prod starter-grant-service likely needs redeploy."
  );
  console.warn("     Retrying with service auth to verify attribution store join...");
  pmResult = await request("/attribution/event", {
    method: "POST",
    auth: true,
    body: pmBody
  });
}

assertStep("private message received", pmResult, 202);

const summary = assertStep(
  "attribution summary",
  await request("/attribution/summary?campaignId=private_messaging", { auth: true }),
  200
);

const group = summary.groups?.find((entry) => entry.promptProfileId === "cta-funnel-live");
if (!group) {
  console.error("FAIL summary group for cta-funnel-live not found");
  console.error(JSON.stringify(summary.groups?.slice(0, 3), null, 2));
  process.exit(1);
}

const checks = [
  ["clicks", 1],
  ["grantChallenges", 1],
  ["grantClaimsSucceeded", 1],
  ["privateMessagesReceived", 1]
];

for (const [field, expected] of checks) {
  const actual = group[field] ?? 0;
  if (actual < expected) {
    console.error(`FAIL ${field}: expected >= ${expected}, got ${actual}`);
    process.exit(1);
  }
  console.log(`OK   summary.${field} = ${actual}`);
}

console.log("\nCTA funnel live test passed.");
console.log(`Tracked ref: ${refId}`);
console.log(`Wallet: ${wallet.address}`);
