#!/usr/bin/env node
/**
 * Real SDK send E2E: mint ref → landing click → npx --init --ref send → verify attribution DB.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const grantUrl = (process.env.STARTER_GRANT_SERVICE_URL ?? "https://agents.coti.io/grant").replace(
  /\/$/,
  ""
);
const authToken = process.env.STARTER_GRANT_SERVICE_AUTH_TOKEN?.trim();
const sshHost = process.env.CTA_E2E_SSH_HOST ?? "grant";
const attributionDb =
  process.env.OUTREACH_ATTRIBUTION_DB_PATH ??
  "/home/ubuntu/outreach-agent/.runtime/outreach-attribution.sqlite";
const recipient =
  process.env.CTA_E2E_RECIPIENT ?? "0x000000000000000000000000000000000000c0a1";
const sdkPackage = process.env.CTA_E2E_SDK_PACKAGE ?? "@coti-io/coti-sdk-private-messaging@latest";

if (!authToken) {
  console.error("Missing STARTER_GRANT_SERVICE_AUTH_TOKEN.");
  process.exit(1);
}

const refToken = createHash("sha256")
  .update(`sdk-e2e-${Date.now()}-${randomUUID()}`)
  .digest("base64url")
  .slice(0, 10);
const refId = `manual_e2e_${refToken}`;
const promptProfileId = `sdk_e2e_${refToken}`;

function buildOutreachRef() {
  return {
    id: refId,
    venue: "manual",
    contentType: "post",
    campaignId: "private_messaging",
    promptProfileId,
    promptParameters: { builder: "sdk_e2e_live", messageStyle: "technical", layout: "regular_paragraph" },
    messageStyle: "technical",
    layout: "regular_paragraph",
    ctaStyle: "direct_next_step",
    promotionLevel: "explicit",
    productSpecificity: "product_named",
    rewardEmphasis: "balanced",
    audience: "builders",
    candidateId: `sdk-e2e-${refToken}`,
    generatedContentId: `sdk-e2e-${refToken}`,
    attributionMode: "manual_ref",
    publicValueDeliveredFirst: true,
    utm: {
      source: "manual",
      medium: "sdk_e2e_live",
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
  console.log(`OK   ${name}`);
  return result.payload;
}

async function queryRefEvents(ref) {
  const sql = `SELECT event_type, wallet_address, created_at FROM attribution_events WHERE ref_id='${ref}' ORDER BY created_at;`;
  const child = spawn(
    "ssh",
    [
      sshHost,
      `python3 -c ${JSON.stringify(
        `import sqlite3; con=sqlite3.connect(${JSON.stringify(attributionDb)}); ref=${JSON.stringify(ref)}; print("\\n".join("|".join(str(x or "") for x in row) for row in con.execute("SELECT event_type, wallet_address, created_at FROM attribution_events WHERE ref_id=? ORDER BY created_at", (ref,))))`
      )}`
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) {
    throw new Error(stderr || `sqlite3 query failed with code ${code}`);
  }
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [eventType, walletAddress, createdAt] = line.split("|");
      return { eventType, walletAddress, createdAt };
    });
}

async function waitForEvents(ref, expected, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await queryRefEvents(ref);
    const counts = Object.fromEntries(
      expected.map((type) => [type, events.filter((event) => event.eventType === type).length])
    );
    if (expected.every((type) => (counts[type] ?? 0) >= 1)) {
      return { events, counts };
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`Timed out waiting for events on ${ref}: ${expected.join(", ")}`);
}

function runNpxSend(workdir, ref) {
  return new Promise((resolve, reject) => {
    const {
      PRIVATE_KEY: _privateKey,
      AES_KEY: _aesKey,
      CONTRACT_ADDRESS: _contractAddress,
      STARTER_GRANT_REF: _starterGrantRef,
      ...baseEnv
    } = process.env;
    const args = [
      "-p",
      sdkPackage,
      "coti-private-messaging-send",
      "--init",
      "--to",
      recipient,
      "--text",
      "hello from coti e2e",
      "--ref",
      ref,
      "--network",
      "mainnet"
    ];
    const child = spawn("npx", args, {
      cwd: workdir,
      env: {
        ...baseEnv,
        STARTER_GRANT_SERVICE_URL: grantUrl,
        STARTER_GRANT_INSTALL_ID_PATH: join(workdir, "install-state.json"),
        HOME: workdir
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `npx exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve({ raw: stdout.trim() });
      }
    });
  });
}

console.log(`SDK send E2E → ${grantUrl}`);
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
      metadata: { path: "/pm" }
    }
  }),
  202
);

const workdir = await mkdtemp(join(tmpdir(), "coti-sdk-e2e-"));
console.log(`OK   temp workdir ${workdir}`);

let sendResult;
try {
  console.log("RUN  npx coti-private-messaging-send --init ...");
  sendResult = await runNpxSend(workdir, refId);
  console.log("OK   sdk send completed");
} finally {
  await rm(workdir, { recursive: true, force: true });
}

const expectedEvents = [
  "click",
  "grant_challenge",
  "grant_claim_succeeded",
  "private_message_received",
  "skill_usage"
];

console.log("WAIT attribution events in DB ...");
const { events, counts } = await waitForEvents(refId, expectedEvents);

console.log("\nAttribution events:");
for (const event of events) {
  console.log(`  ${event.createdAt}  ${event.eventType}  ${event.walletAddress ?? ""}`);
}

for (const type of expectedEvents) {
  console.log(`OK   ${type} = ${counts[type]}`);
}

console.log("\nSDK send E2E passed.");
console.log(`refId: ${refId}`);
console.log(`sender: ${sendResult.sender ?? "unknown"}`);
console.log(`messageId: ${sendResult.messageId ?? "unknown"}`);
console.log(`tx: ${sendResult.transactionHash ?? "unknown"}`);
