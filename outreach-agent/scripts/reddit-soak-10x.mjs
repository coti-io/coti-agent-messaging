#!/usr/bin/env node
/**
 * Run reddit-session dry-run N times with a fixed interval; save reports and update findings doc.
 *
 * Usage:
 *   node scripts/reddit-soak-10x.mjs [--runs 10] [--interval-min 5] [--out-dir path]
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

const SOAK_DISCOVERY_THREAD_READS = "4";

function parseArgs(argv) {
  const args = { runs: 10, intervalMin: 5, outDir: undefined, pruneDraftsAtBatchStart: true };
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

function runCommand(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
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

function categorizePlannerSkipped(skipped = []) {
  let memory = 0;
  let gates = 0;
  let other = 0;
  for (const line of skipped) {
    if (line.includes("skipped prior draft or post in memory")) {
      memory += 1;
    } else if (line.includes("blocked by")) {
      gates += 1;
    } else {
      other += 1;
    }
  }
  return { memory, gates, other, total: skipped.length };
}

function summarizeReport(report) {
  const decision = report.decision ?? {};
  const action = decision.action;
  const ingestion = report.ingestion ?? {};
  const skipped = report.ingestion?.skipped ?? [];
  const plannerSkippedLines = report.planner?.skipped ?? [];
  const plannerSkipBreakdown = categorizePlannerSkipped(plannerSkippedLines);
  const plannerSkipped = plannerSkippedLines.length;
  const blockedGateSample = report.planner?.blockedGateSample?.length ?? 0;
  return {
    generatedAt: report.generatedAt,
    dryRun: report.dryRun,
    duplicateCheckPolicy: report.duplicateCheckPolicy,
    readSource: report.readSource,
    browserHeadless: ingestion.diagnostics?.browserHeadless,
    readViaBrowser: ingestion.diagnostics?.readViaBrowser,
    snapshotCount: ingestion.snapshotCount,
    sourceItemCount: ingestion.sourceItemCount,
    ownThreadTargets: ingestion.ownThreadTargets,
    ownThreadSnapshots: ingestion.ownThreadSnapshots,
    discoveryThreadSnapshots: ingestion.discoveryThreadSnapshots,
    discoveryQueries: ingestion.diagnostics?.discoverySearchQueries ?? [],
    excludedThreads: ingestion.diagnostics?.excludedThreadPostIds ?? [],
    ingestionSkipped: skipped.length,
    ingestionSkippedSample: skipped.slice(0, 3),
    actionType: action?.type,
    actionSubreddit: action?.item?.source?.subreddit,
    actionTargetId: action?.item?.source?.id,
    draftChars: report.draft?.content?.length ?? 0,
    promptVariantId: report.recorded?.promptVariantId ?? report.draft ? "see-recorded" : undefined,
    selectedWriteId: report.selectedActionBundle?.selectedWriteCandidateId,
    plannerSkippedCount: plannerSkipped,
    plannerSkipBreakdown,
    blockedGateSampleCount: blockedGateSample,
    candidatesCount: decision.candidates?.length ?? 0,
    plannedCount: decision.plannedCandidates?.length ?? 0,
    hasDraft: Boolean(report.draft?.content),
    memoryPath: report.memoryPath
  };
}

function findingsHeader({ runs, intervalMin, outDir, startedAt }) {
  return `# Reddit agent soak test findings

Generated from automated soak runs. Use for follow-up fixes and improvements.

| Setting | Value |
|---------|--------|
| Runs | ${runs} |
| Interval | ${intervalMin} minutes |
| Mode | \`reddit-session --dry-run --once\` |
| Discovery reads / run | ${SOAK_DISCOVERY_THREAD_READS} |
| Query rotation | one query per iteration |
| Started (UTC) | ${startedAt} |
| Output dir | \`${outDir}\` |

## Run log

| Run | UTC time | Exit | Snapshots | Discovery | Source items | Action | Draft chars | Variant | Notes |
|-----|----------|------|-----------|-----------|--------------|--------|-------------|---------|-------|
`;
}

function findingsRow(runIndex, startedAt, exitCode, summary, note) {
  const action =
    summary.actionType && summary.actionSubreddit
      ? `${summary.actionType} @ r/${summary.actionSubreddit}`
      : summary.selectedWriteId
        ? `bundle:${summary.selectedWriteId}`
        : "—";
  return `| ${runIndex} | ${startedAt} | ${exitCode} | ${summary.snapshotCount} | ${summary.discoveryThreadSnapshots} | ${summary.sourceItemCount} | ${action} | ${summary.draftChars || "—"} | ${summary.recorded?.promptVariantId ?? "—"} | ${note} |`;
}

async function appendRunDetail(findingsPath, runIndex, startedAt, exitCode, summary, stderr, reportPath) {
  const section = `
### Run ${runIndex} (${startedAt})

- **Exit code:** ${exitCode}
- **Read source:** ${summary.readSource} (headless=${summary.browserHeadless}, viaBrowser=${summary.readViaBrowser})
- **Ingestion:** ${summary.snapshotCount} snapshots, ${summary.sourceItemCount} source items, own-thread targets=${summary.ownThreadTargets}
- **Discovery:** ${summary.discoveryThreadSnapshots} threads; queries=${JSON.stringify(summary.discoveryQueries)}
- **Excluded thread IDs:** ${JSON.stringify(summary.excludedThreads)}
- **Ingestion skipped (${summary.ingestionSkipped}):** ${summary.ingestionSkippedSample.map((s) => `\`${s}\``).join(", ") || "none"}
- **Planner:** ${summary.plannedCount} planned, ${summary.candidatesCount} candidates, ${summary.plannerSkippedCount} skipped (${summary.plannerSkipBreakdown.memory} memory, ${summary.plannerSkipBreakdown.gates} gates, ${summary.plannerSkipBreakdown.other} other)
- **Selected write:** ${summary.selectedWriteId ?? "none"}
- **Draft:** ${summary.hasDraft ? `${summary.draftChars} chars` : "none"}
- **Duplicate policy:** ${summary.duplicateCheckPolicy}
- **Report file:** \`${reportPath}\`

${stderr.trim() ? `**Stderr:**\n\`\`\`\n${stderr.trim().slice(0, 2000)}\n\`\`\`\n` : ""}
`;
  await appendFile(findingsPath, section, "utf8");
}

async function finalizeFindings(findingsPath, rows, failures) {
  const issues = [];
  const browserDeaths = rows.filter((r) =>
    r.summary.ingestionSkippedSample.some((s) => /browser has been closed|Target page/i.test(s))
  );
  const noActions = rows.filter((r) => !r.summary.actionType && !r.summary.hasDraft);
  const withDrafts = rows.filter((r) => r.summary.hasDraft);

  if (browserDeaths.length > 0) {
    issues.push(
      `- **Browser worker instability:** ${browserDeaths.length}/${rows.length} runs saw closed-browser ingestion errors. Restart worker before soak; add health check + auto-restart.`
    );
  }
  if (noActions.length === rows.length) {
    issues.push(
      "- **No actions in any run:** All runs ended with zero planned actions. Review discovery gates (`safe_draft_generated`, `discovery_topical_fit`, `clear_user_need`) and ingestion quality."
    );
  } else if (noActions.length > 0) {
    issues.push(
      `- **Intermittent empty runs:** ${noActions.length}/${rows.length} runs produced no action. Correlate with browser errors and gate blocks.`
    );
  }
  if (withDrafts.length > 0 && withDrafts.length < rows.length) {
    issues.push(
      `- **Draft inconsistency:** ${withDrafts.length}/${rows.length} runs produced drafts. Investigate gate failures on remaining runs.`
    );
  }
  if (failures.length > 0) {
    issues.push(`- **CLI failures:** ${failures.length} run(s) exited non-zero (parse errors or crash). See stderr in run sections.`);
  }

  const footer = `
## Summary statistics

| Metric | Value |
|--------|--------|
| Runs completed | ${rows.length} |
| Runs with draft | ${withDrafts.length} |
| Runs with planned action | ${rows.filter((r) => r.summary.actionType).length} |
| Runs with browser errors in ingestion | ${browserDeaths.length} |
| Runs with zero snapshots | ${rows.filter((r) => r.summary.snapshotCount === 0).length} |

## Recommended follow-ups (priority)

${issues.length > 0 ? issues.join("\n") : "- Soak completed without obvious systemic failures. Consider one live run on a strong thread before production."}

## Raw artifacts

See JSON reports and \`soak.log\` in the output directory listed above.
`;
  await appendFile(findingsPath, footer, "utf8");
}

async function pruneDraftsForNewBatch(packageRoot) {
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
  if (payload.clearedDrafts > 0) {
    console.log(`Batch start: cleared ${payload.clearedDrafts} draft(s) from ${payload.memoryPath}`);
  } else {
    console.log(`Batch start: no drafts to clear (${payload.memoryPath})`);
  }
}

async function main() {
  const { runs, intervalMin, outDir: outDirArg, pruneDraftsAtBatchStart } = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, "-").slice(0, 19);
  const outDir = outDirArg ?? path.join(packageRoot, ".data", `reddit-soak-${stamp}`);
  const findingsPath = path.join(packageRoot, "docs", "REDDIT_SOAK_TEST_FINDINGS.md");
  const intervalMs = intervalMin * 60 * 1000;

  await mkdir(outDir, { recursive: true });
  await mkdir(path.dirname(findingsPath), { recursive: true });

  const statusPath = path.join(packageRoot, ".bridge", "reddit-browser", "status.json");
  try {
    await readFile(statusPath, "utf8");
  } catch {
    console.error(`Missing ${statusPath}. Start headed worker first: npm run reddit:browser-worker`);
    process.exit(1);
  }

  console.log(`Soak batch: ${runs} iterations, ${intervalMin}m interval`);
  console.log(`Output: ${outDir}`);
  console.log(`Findings: ${findingsPath}`);

  if (pruneDraftsAtBatchStart) {
    await pruneDraftsForNewBatch(packageRoot);
  } else {
    console.log("Batch start: keeping existing drafts (--no-prune-drafts)");
  }

  await writeFile(findingsPath, findingsHeader({ runs, intervalMin, outDir, startedAt }), "utf8");
  await writeFile(path.join(outDir, "soak.log"), `started ${startedAt}\n`, "utf8");

  const ingestionModule = await import(path.join(packageRoot, "dist/src/reddit-ingestion.js"));
  const discoveryQueries = [...ingestionModule.DEFAULT_REDDIT_OPERATING_SEARCH_QUERIES];
  const batchDiscoverySeed = Date.now() % 1_000_000;

  const rows = [];
  const failures = [];

  for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
    const runStartedAt = new Date().toISOString();
    const rotatedQuery = discoveryQueries[(runIndex - 1) % discoveryQueries.length] ?? discoveryQueries[0];
    console.log(`\n--- Run ${runIndex}/${runs} @ ${runStartedAt} ---`);
    console.log(`Discovery: query="${rotatedQuery}" seed=${batchDiscoverySeed + runIndex} maxReads=${SOAK_DISCOVERY_THREAD_READS}`);

    const { code, stdout, stderr } = await runCommand("npm", ["run", "reddit:session:dry-run"], {
      OUTREACH_AGENT_VENUE: "reddit",
      OUTREACH_REDDIT_READ_CONTROLLER: "browser",
      OUTREACH_REDDIT_SESSION_DRY_RUN: "true",
      OUTREACH_REDDIT_INGESTION_MAX_DISCOVERY_THREAD_READS: SOAK_DISCOVERY_THREAD_READS,
      OUTREACH_REDDIT_DISCOVERY_SEED: String(batchDiscoverySeed + runIndex),
      OUTREACH_REDDIT_SEARCH_QUERIES: rotatedQuery
    });

    const stdoutPath = path.join(outDir, `run-${runIndex}.stdout`);
    const stderrPath = path.join(outDir, `run-${runIndex}.stderr`);
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");

    let report;
    let summary;
    let note = code === 0 ? "ok" : `exit ${code}`;
    try {
      report = extractJsonReport(stdout);
      const reportPath = path.join(outDir, `run-${runIndex}.json`);
      await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
      summary = summarizeReport(report);
      if (summary.ingestionSkippedSample.some((s) => /browser has been closed/i.test(s))) {
        note = "browser closed";
      } else if (!summary.actionType && !summary.hasDraft) {
        const { memory, gates } = summary.plannerSkipBreakdown ?? {};
        note = `no action (mem=${memory ?? 0} gates=${gates ?? 0})`;
      } else if (summary.hasDraft) {
        note = "drafted";
      }
      await appendRunDetail(
        findingsPath,
        runIndex,
        runStartedAt,
        code,
        summary,
        stderr,
        path.relative(packageRoot, path.join(outDir, `run-${runIndex}.json`))
      );
    } catch (error) {
      note = `parse error: ${error instanceof Error ? error.message : String(error)}`;
      failures.push({ runIndex, error });
      summary = {
        snapshotCount: 0,
        discoveryThreadSnapshots: 0,
        sourceItemCount: 0,
        ingestionSkipped: 0,
        ingestionSkippedSample: [],
        draftChars: 0,
        hasDraft: false
      };
    }

    rows.push({ runIndex, startedAt: runStartedAt, exitCode: code, summary, note });
    const row = findingsRow(runIndex, runStartedAt, code, summary, note);
    await appendFile(findingsPath, `${row}\n`, "utf8");
    await appendFile(
      path.join(outDir, "soak.log"),
      `run ${runIndex} exit=${code} note=${note} snapshots=${summary.snapshotCount} discovery=${summary.discoveryThreadSnapshots} draft=${summary.draftChars}\n`,
      "utf8"
    );

    console.log(
      `Run ${runIndex}: exit=${code} snapshots=${summary.snapshotCount} discovery=${summary.discoveryThreadSnapshots} action=${summary.actionType ?? "none"} draft=${summary.draftChars}`
    );

    if (runIndex < runs) {
      console.log(`Sleeping ${intervalMin} minutes...`);
      await sleep(intervalMs);
    }
  }

  await finalizeFindings(findingsPath, rows, failures);
  const finishedAt = new Date().toISOString();
  await appendFile(path.join(outDir, "soak.log"), `finished ${finishedAt}\n`, "utf8");
  console.log(`\nSoak complete @ ${finishedAt}`);
  console.log(`Findings written to ${findingsPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
