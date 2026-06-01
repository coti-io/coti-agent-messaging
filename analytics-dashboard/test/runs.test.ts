import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { loadAgentRecentRuns } from "../src/runs";

test("loadAgentRecentRuns explains idle reddit heartbeats like moltbook summaries", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "analytics-runs-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  await mkdir(runtimeDir, { recursive: true });

  const report = {
    runId: "heartbeat:2026-06-01T09:05:03.308Z:1",
    phase: "heartbeat",
    startedAt: "2026-06-01T09:05:01.000Z",
    finishedAt: "2026-06-01T09:05:03.308Z",
    status: "ok",
    summary: "HEARTBEAT_OK - Reddit runtime idle.",
    dryRun: false,
    skipped: [],
    errors: [],
    ingestion: {
      snapshotCount: 4,
      sourceItemCount: 77,
      discoveryThreadSnapshots: 4,
      ownThreadSnapshots: 0,
      skipped: []
    },
    actionCandidates: [
      {
        id: "comment:sales:abc",
        type: "comment_on_post",
        source: { subreddit: "sales", title: "AI receptionist rant" },
        allowed: false,
        blockedBy: ["daily_comment_cap"]
      }
    ],
    selectedActionBundle: {
      selectedCandidateIds: [],
      rationale: "No legal Reddit action candidate survived filtering."
    },
    planner: {
      skipped: ["comment:sales:abc: blocked by daily_comment_cap"],
      blockedGateSample: [
        { id: "comment:sales:abc", gates: ["daily_comment_cap"] }
      ],
      filterSummary: {
        sourceItemCount: 77,
        inTargetSubredditCount: 12,
        outOfTargetSubredditCount: 65,
        reviewedCount: 12,
        blockedCount: 12,
        needsReviewCount: 0,
        plannedCandidateCount: 0,
        blockedByGate: [
          { gate: "discovery_topical_fit", count: 9, category: "topical_validation" },
          { gate: "clear_user_need", count: 3, category: "intent_validation" }
        ],
        nonPublicActionCounts: []
      },
      pipeline: {
        llmDraft: "not_reached"
      }
    },
    queuedActionJobs: [],
    engagementSummary: {
      total: { posts: 2, comments: 5, replies: 1, upvotes: 0, follows: 0, total: 8 }
    }
  };

  await writeFile(
    path.join(runtimeDir, "heartbeat-runs.jsonl"),
    `${JSON.stringify(report)}\n`,
    "utf8"
  );

  try {
    const runs = await loadAgentRecentRuns(
      {
        agentDir: tempDir,
        runtimeDir,
        envPath: path.join(tempDir, ".env"),
        metadataPath: path.join(tempDir, "agent.json"),
        statePath: path.join(runtimeDir, "state.json"),
        storagePath: path.join(runtimeDir, "state.sqlite"),
        reportPath: path.join(runtimeDir, "last-heartbeat.json")
      },
      undefined,
      5
    );

    assert.equal(runs.length, 1);
    assert.match(runs[0]?.summary ?? "", /No action — 0\/12 items passed picker/);
    assert.equal(runs[0]?.skipped.length, 0);
    assert.equal((runs[0]?.filteringSummary?.length ?? 0) >= 3, true);
    assert.match(runs[0]?.filteringSummary?.join("\n") ?? "", /Block reasons:/);
    assert.match(runs[0]?.filteringSummary?.join("\n") ?? "", /No explicit help intent/);
    assert.match(runs[0]?.filteringSummary?.join("\n") ?? "", /LLM: not reached/);
    assert.equal(runs[0]?.skipCount, 0);
    assert.equal(runs[0]?.runCounts.total, 8);
    assert.equal(runs[0]?.countsScope, "lifetime");
    assert.match(runs[0]?.activityThisRun ?? "", /77 source items|passed picker/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadAgentRecentRuns groups noisy reddit planner skips by gate", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "analytics-runs-grouped-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  await mkdir(runtimeDir, { recursive: true });

  const plannerSkipped = [
    "comment:mcp:a: blocked by clear_user_need,safe_draft_generated",
    "comment:mcp:b: blocked by clear_user_need,safe_draft_generated",
    "comment:LocalLLaMA:c: blocked by discovery_topical_fit,clear_user_need",
    "comment:LocalLLaMA:oobw879: requires ask clarifying question",
    "Reddit draft generation failed: Reddit draft generation failed after 3 LLM attempts: hook-style draft must open briefly.",
    "Deferred 10 candidate(s) to a later run."
  ];

  const report = {
    runId: "heartbeat:2026-06-01T09:35:03.141Z:1",
    phase: "heartbeat",
    startedAt: "2026-06-01T09:35:01.000Z",
    finishedAt: "2026-06-01T09:35:03.141Z",
    status: "ok",
    dryRun: false,
    skipped: plannerSkipped,
    errors: [],
    ingestion: { snapshotCount: 6, sourceItemCount: 122, discoveryThreadSnapshots: 6, ownThreadSnapshots: 0 },
    actionCandidates: [
      {
        id: "post:mcp:1tij7nt",
        type: "comment_on_post",
        source: { subreddit: "mcp", title: "Agent inbox question" },
        allowed: true,
        blockedBy: ["human_review_required"]
      }
    ],
    selectedActionBundle: {
      selectedWriteCandidateId: "post:mcp:1tij7nt",
      deferredCandidateIds: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
      rationale: "Selected comment_on_post from explore_feed as the single safe Reddit action for this run."
    },
    planner: {
      skipped: plannerSkipped,
      filterSummary: {
        sourceItemCount: 122,
        inTargetSubredditCount: 122,
        outOfTargetSubredditCount: 0,
        reviewedCount: 122,
        blockedCount: 110,
        needsReviewCount: 12,
        plannedCandidateCount: 11,
        blockedByGate: [
          { gate: "clear_user_need", count: 110, category: "intent_validation" },
          { gate: "safe_draft_generated", count: 110, category: "draft_generation" },
          { gate: "discovery_topical_fit", count: 89, category: "topical_validation" }
        ],
        nonPublicActionCounts: []
      },
      pipeline: { llmDraft: "failed" }
    },
    queuedActionJobs: []
  };

  await writeFile(path.join(runtimeDir, "heartbeat-runs.jsonl"), `${JSON.stringify(report)}\n`, "utf8");

  try {
    const runs = await loadAgentRecentRuns(
      {
        agentDir: tempDir,
        runtimeDir,
        envPath: path.join(tempDir, ".env"),
        metadataPath: path.join(tempDir, "agent.json"),
        statePath: path.join(runtimeDir, "state.json"),
        storagePath: path.join(runtimeDir, "state.sqlite"),
        reportPath: path.join(runtimeDir, "last-heartbeat.json")
      },
      undefined,
      5
    );

    assert.equal(runs.length, 1);
    assert.match(runs[0]?.summary ?? "", /Draft rejected for r\/mcp/);
    assert.equal(runs[0]?.skipped.some((line) => line.includes("comment:mcp:a")), false);
    assert.match(runs[0]?.skipped.join("\n") ?? "", /OpenRouter wrote a reply 3 times/);
    assert.match(runs[0]?.skipped.join("\n") ?? "", /not saved to a queue/);
    assert.match(runs[0]?.skipped.join("\n") ?? "", /clarifying question/);
    assert.ok((runs[0]?.skipCount ?? 0) <= 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
