#!/usr/bin/env node
/**
 * Run one or more live reddit-session iterations via unofficial oauth transport.
 *
 * Usage:
 *   node scripts/reddit-unofficial-heartbeat.mjs [--runs 1] [--interval-min 5] [--out-dir path]
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { runs: 1, intervalMin: 5, outDir: undefined };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--runs" && argv[i + 1]) {
      args.runs = Number(argv[++i]);
    } else if (argv[i] === "--interval-min" && argv[i + 1]) {
      args.intervalMin = Number(argv[++i]);
    } else if (argv[i] === "--out-dir" && argv[i + 1]) {
      args.outDir = argv[++i];
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runSession(env) {
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      ["dist/src/index.js", "reddit-session", "--live", "--once", "--max-actions", "1"],
      {
        cwd: packageRoot,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
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
    readViaUnofficial: ingestion.diagnostics?.readViaUnofficial,
    snapshotCount: ingestion.snapshotCount,
    sourceItemCount: ingestion.sourceItemCount,
    discoveryListingSorts: ingestion.diagnostics?.discoveryListingSorts?.length ?? 0,
    ingestionSkipped: (ingestion.skipped ?? []).length,
    actionType: action?.type,
    actionSubreddit: action?.item?.source?.subreddit,
    targetTitle: action?.item?.source?.title,
    posted: Boolean(
      report.outcome?.remoteContentUrl ??
        report.recorded?.remoteContentUrl ??
        (report.recorded?.status === "posted"
          ? report.recorded.targetUrl ?? true
          : undefined) ??
        (report.outcome?.type === "replied" || report.outcome?.type === "commented"
          ? report.outcome.occurredAt
          : undefined)
    ),
    remoteContentUrl:
      report.outcome?.remoteContentUrl ??
      report.recorded?.remoteContentUrl ??
      (report.outcome?.raw?.json?.data?.things?.[0]?.data?.permalink
        ? `https://www.reddit.com${report.outcome.raw.json.data.things[0].data.permalink}`
        : undefined),
    draftPreview: report.draft?.content?.slice(0, 120),
    plannerSkipped: (report.planner?.skipped ?? []).length
  };
}

async function main() {
  const { runs, intervalMin, outDir: outDirArg } = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, "-").slice(0, 19);
  const outDir = outDirArg ?? path.join(packageRoot, ".data", `reddit-unofficial-heartbeat-${stamp}`);
  const intervalMs = intervalMin * 60 * 1000;
  const summaryPath = path.join(outDir, "heartbeat-summary.json");

  await mkdir(outDir, { recursive: true });
  console.log(`Unofficial Reddit heartbeat — live ingest/decision/post`);
  console.log(`Runs: ${runs}, output: ${outDir}`);

  const rows = [];
  await writeFile(path.join(outDir, "heartbeat.log"), `started ${startedAt}\n`, "utf8");

  for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
    const runStartedAt = new Date().toISOString();
    console.log(`\n--- Run ${runIndex}/${runs} @ ${runStartedAt} ---`);

    const { code, stdout, stderr } = await runSession({
      OUTREACH_AGENT_VENUE: "reddit",
      OUTREACH_AGENT_MODE: "approved_autopost",
      OUTREACH_REDDIT_CONTROLLER: "unofficial",
      OUTREACH_REDDIT_READ_CONTROLLER: "unofficial",
      OUTREACH_REDDIT_SESSION_DRY_RUN: "false",
      OUTREACH_REDDIT_PUBLISH_IMMEDIATELY: "true",
      OUTREACH_REDDIT_MIN_JITTER_MINUTES: "0",
      OUTREACH_REDDIT_MAX_JITTER_MINUTES: "1",
      OUTREACH_REDDIT_INGESTION_MAX_DISCOVERY_THREAD_READS: "2",
      OUTREACH_REDDIT_INGESTION_MAX_SEARCHES_PER_SUBREDDIT: "1",
      OUTREACH_REDDIT_DISCOVERY_SEED: String(Date.now() % 1_000_000)
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
      } else if (!summary.actionType) {
        note = summary.snapshotCount === 0 ? "no ingestion (rate limit?)" : "no action";
      }
    } catch (error) {
      note = stderr.trim().slice(0, 200) || `parse error: ${error instanceof Error ? error.message : String(error)}`;
      summary = { snapshotCount: 0, posted: false };
    }

    const row = { runIndex, runStartedAt, exitCode: code, note, ...summary };
    rows.push(row);
    await appendFile(
      path.join(outDir, "heartbeat.log"),
      `run ${runIndex} exit=${code} note=${note} snapshots=${summary.snapshotCount ?? 0} posted=${summary.posted}\n`,
      "utf8"
    );
    console.log(JSON.stringify(row, null, 2));
    if (stderr.trim()) {
      console.error(stderr.trim().slice(0, 400));
    }

    await writeFile(
      summaryPath,
      JSON.stringify({ startedAt, runs, intervalMin, controller: "unofficial", rows }, null, 2),
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
    controller: "unofficial",
    postedCount: rows.filter((r) => r.posted).length,
    rows
  };
  await writeFile(summaryPath, JSON.stringify(aggregate, null, 2), "utf8");
  console.log(`\nDone @ ${finishedAt}`);
  console.log(`Summary: ${summaryPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
