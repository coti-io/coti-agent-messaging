#!/usr/bin/env node
/**
 * Run live reddit-session iterations (real posts). Each iteration plans, queues, and publishes.
 *
 * Usage:
 *   node scripts/reddit-live-batch.mjs [--runs 2] [--interval-min 3]
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { runs: 2, intervalMin: 3, pruneDraftsAtBatchStart: true };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--runs" && argv[i + 1]) {
      args.runs = Number(argv[++i]);
    } else if (argv[i] === "--interval-min" && argv[i + 1]) {
      args.intervalMin = Number(argv[++i]);
    } else if (argv[i] === "--no-prune-drafts") {
      args.pruneDraftsAtBatchStart = false;
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(env) {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", "reddit:session"], {
      cwd: packageRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function extractJsonReport(stdout) {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(stdout.slice(start, end + 1));
  }
  throw new Error("No JSON report found in session output");
}

async function pruneDraftsForNewBatch() {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("npm", ["run", "reddit:memory:prune-drafts"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: process.env
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "reddit:memory:prune-drafts failed");
  }
  const payload = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
  console.log(
    payload.clearedDrafts > 0
      ? `Batch start: cleared ${payload.clearedDrafts} draft(s)`
      : "Batch start: no drafts to clear"
  );
}

async function main() {
  const { runs, intervalMin, pruneDraftsAtBatchStart } = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.join(packageRoot, ".data", `reddit-live-${stamp}`);
  const intervalMs = intervalMin * 60 * 1000;

  await mkdir(outDir, { recursive: true });

  console.log("LIVE Reddit batch — posts are real. Ctrl+C to abort.");
  console.log(`Runs: ${runs}, interval: ${intervalMin}m, output: ${outDir}`);

  if (pruneDraftsAtBatchStart) {
    await pruneDraftsForNewBatch();
  }

  const ingestionModule = await import(path.join(packageRoot, "dist/src/reddit-ingestion.js"));
  const discoveryQueries = [...ingestionModule.DEFAULT_REDDIT_OPERATING_SEARCH_QUERIES];
  const batchDiscoverySeed = Date.now() % 1_000_000;

  for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
    const runStartedAt = new Date().toISOString();
    const rotatedQuery = discoveryQueries[(runIndex - 1) % discoveryQueries.length] ?? discoveryQueries[0];
    console.log(`\n--- Live run ${runIndex}/${runs} @ ${runStartedAt} ---`);
    console.log(`Discovery query="${rotatedQuery}" seed=${batchDiscoverySeed + runIndex}`);

    const { code, stdout, stderr } = await runCommand({
      OUTREACH_AGENT_VENUE: "reddit",
      OUTREACH_AGENT_MODE: "approved_autopost",
      OUTREACH_REDDIT_CONTROLLER: "browser",
      OUTREACH_REDDIT_READ_CONTROLLER: "browser",
      OUTREACH_REDDIT_SESSION_DRY_RUN: "false",
      OUTREACH_REDDIT_PUBLISH_IMMEDIATELY: "true",
      OUTREACH_REDDIT_MIN_JITTER_MINUTES: "0",
      OUTREACH_REDDIT_MAX_JITTER_MINUTES: "1",
      OUTREACH_REDDIT_INGESTION_MAX_DISCOVERY_THREAD_READS: "4",
      OUTREACH_REDDIT_DISCOVERY_SEED: String(batchDiscoverySeed + runIndex),
      OUTREACH_REDDIT_SEARCH_QUERIES: rotatedQuery
    });

    await writeFile(path.join(outDir, `run-${runIndex}.stdout`), stdout, "utf8");
    await writeFile(path.join(outDir, `run-${runIndex}.stderr`), stderr, "utf8");

    let summary = `exit=${code}`;
    try {
      const report = extractJsonReport(stdout);
      await writeFile(path.join(outDir, `run-${runIndex}.json`), JSON.stringify(report, null, 2), "utf8");
      const posted = report.outcome?.remoteContentUrl ?? report.recorded?.remoteContentUrl;
      const target = report.recorded?.targetId ?? report.decision?.action?.item?.source?.id;
      summary = `exit=${code} posted=${posted ? "yes" : "no"} target=${target ?? "none"} url=${posted ?? "—"}`;
    } catch (error) {
      summary = `exit=${code} parse_error=${error instanceof Error ? error.message : String(error)}`;
    }

    console.log(summary);
    if (stderr.trim()) {
      console.error(stderr.trim().slice(0, 500));
    }

    await appendFile(path.join(outDir, "live.log"), `${runStartedAt} ${summary}\n`, "utf8");

    if (runIndex < runs) {
      console.log(`Sleeping ${intervalMin} minutes...`);
      await sleep(intervalMs);
    }
  }

  console.log(`\nLive batch complete @ ${new Date().toISOString()}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
