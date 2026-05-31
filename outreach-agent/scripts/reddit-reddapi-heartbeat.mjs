#!/usr/bin/env node
/**
 * Run reddit-session live iterations via ReddAPI (read + write).
 *
 * Usage:
 *   node scripts/reddit-reddapi-heartbeat.mjs [--runs 12] [--interval-min 5] [--out-dir path]
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { runs: 12, intervalMin: 5, outDir: undefined, pruneDraftsAtBatchStart: true };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--runs" && argv[i + 1]) {
      args.runs = Number(argv[++i]);
    } else if (argv[i] === "--interval-min" && argv[i + 1]) {
      args.intervalMin = Number(argv[++i]);
    } else if (argv[i] === "--out-dir" && argv[i + 1]) {
      args.outDir = argv[++i];
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

function summarizeReport(report) {
  const ingestion = report.ingestion ?? {};
  const action = report.decision?.action;
  return {
    generatedAt: report.generatedAt,
    dryRun: report.dryRun,
    readSource: report.readSource,
    readViaReddapi: ingestion.diagnostics?.readViaReddapi,
    readViaBrowser: ingestion.diagnostics?.readViaBrowser,
    snapshotCount: ingestion.snapshotCount,
    sourceItemCount: ingestion.sourceItemCount,
    ownThreadSnapshots: ingestion.ownThreadSnapshots,
    discoveryThreadSnapshots: ingestion.discoveryThreadSnapshots,
    ingestionSkipped: (ingestion.skipped ?? []).length,
    actionType: action?.type,
    actionSubreddit: action?.item?.source?.subreddit,
    posted: Boolean(report.outcome?.remoteContentUrl ?? report.recorded?.remoteContentUrl),
    remoteContentUrl: report.outcome?.remoteContentUrl ?? report.recorded?.remoteContentUrl,
    targetId: report.recorded?.targetId ?? action?.item?.source?.id,
    queuedOnly: Boolean(report.queuedActionJobs?.length && !report.outcome),
    plannerSkipped: (report.planner?.skipped ?? []).length,
    executedQueued: (report.decision?.skipped ?? []).some((s) => /queued Reddit action/i.test(s))
  };
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
  const { runs, intervalMin, outDir: outDirArg, pruneDraftsAtBatchStart } = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, "-").slice(0, 19);
  const outDir = outDirArg ?? path.join(packageRoot, ".data", `reddit-reddapi-heartbeat-${stamp}`);
  const intervalMs = intervalMin * 60 * 1000;
  const summaryPath = path.join(outDir, "heartbeat-summary.json");

  await mkdir(outDir, { recursive: true });

  console.log("ReddAPI Reddit heartbeat — live posts via ReddAPI read+write.");
  console.log(`Runs: ${runs}, interval: ${intervalMin}m (~${((runs - 1) * intervalMin) / 60}h), output: ${outDir}`);

  if (pruneDraftsAtBatchStart) {
    await pruneDraftsForNewBatch();
  }

  const ingestionModule = await import(path.join(packageRoot, "dist/src/reddit-ingestion.js"));
  const discoveryQueries = [...ingestionModule.DEFAULT_REDDIT_OPERATING_SEARCH_QUERIES];
  const batchDiscoverySeed = Date.now() % 1_000_000;

  const rows = [];
  await writeFile(path.join(outDir, "heartbeat.log"), `started ${startedAt}\n`, "utf8");

  for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
    const runStartedAt = new Date().toISOString();
    const rotatedQuery = discoveryQueries[(runIndex - 1) % discoveryQueries.length] ?? discoveryQueries[0];
    console.log(`\n--- Run ${runIndex}/${runs} @ ${runStartedAt} ---`);
    console.log(`ReddAPI ingest+post; query="${rotatedQuery}" seed=${batchDiscoverySeed + runIndex}`);

    const { code, stdout, stderr } = await runCommand({
      OUTREACH_AGENT_VENUE: "reddit",
      OUTREACH_AGENT_MODE: "approved_autopost",
      OUTREACH_REDDIT_CONTROLLER: "reddapi",
      OUTREACH_REDDIT_READ_CONTROLLER: "reddapi",
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

    let summary;
    let note = code === 0 ? "ok" : `exit ${code}`;
    try {
      const report = extractJsonReport(stdout);
      await writeFile(path.join(outDir, `run-${runIndex}.json`), JSON.stringify(report, null, 2), "utf8");
      summary = summarizeReport(report);
      if (summary.posted) {
        note = `posted ${summary.remoteContentUrl}`;
      } else if (summary.executedQueued) {
        note = "executed queued job";
      } else if (summary.queuedOnly) {
        note = "queued only";
      } else if (!summary.actionType) {
        note = "no action";
      }
    } catch (error) {
      note = `parse error: ${error instanceof Error ? error.message : String(error)}`;
      summary = {
        snapshotCount: 0,
        sourceItemCount: 0,
        posted: false,
        readViaReddapi: false
      };
    }

    const row = { runIndex, runStartedAt, exitCode: code, note, ...summary };
    rows.push(row);
    await appendFile(
      path.join(outDir, "heartbeat.log"),
      `run ${runIndex} exit=${code} note=${note} snapshots=${summary.snapshotCount ?? 0} reddapi=${summary.readViaReddapi} posted=${summary.posted}\n`,
      "utf8"
    );
    console.log(
      `Run ${runIndex}: exit=${code} snapshots=${summary.snapshotCount ?? 0} reddapi=${summary.readViaReddapi} posted=${summary.posted} note=${note}`
    );
    if (stderr.trim()) {
      console.error(stderr.trim().slice(0, 400));
    }

    await writeFile(
      summaryPath,
      JSON.stringify({ startedAt, runs, intervalMin, controller: "reddapi", rows }, null, 2),
      "utf8"
    );

    if (runIndex < runs) {
      console.log(`Sleeping ${intervalMin} minutes...`);
      await sleep(intervalMs);
    }
  }

  const finishedAt = new Date().toISOString();
  const aggregate = {
    startedAt,
    finishedAt,
    runs,
    intervalMin,
    controller: "reddapi",
    postedCount: rows.filter((r) => r.posted).length,
    noActionCount: rows.filter((r) => r.note === "no action").length,
    errorCount: rows.filter((r) => r.exitCode !== 0).length,
    avgSnapshots: rows.reduce((sum, r) => sum + (r.snapshotCount ?? 0), 0) / rows.length,
    rows
  };
  await writeFile(summaryPath, JSON.stringify(aggregate, null, 2), "utf8");
  await appendFile(path.join(outDir, "heartbeat.log"), `finished ${finishedAt}\n`, "utf8");
  console.log(`\nHeartbeat complete @ ${finishedAt}`);
  console.log(`Summary: ${summaryPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
