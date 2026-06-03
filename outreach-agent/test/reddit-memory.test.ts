import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  appendRedditMemory,
  loadRedditMemory,
  pruneDraftedRedditMemory,
  saveRedditMemory,
  withoutDraftedMemoryEntries
} from "../src/reddit-memory.js";

test("withoutDraftedMemoryEntries keeps posted history only", () => {
  const kept = withoutDraftedMemoryEntries([
    {
      id: "posted-1",
      subreddit: "sales",
      kind: "comment",
      content: "live",
      createdAt: "2026-05-20T10:00:00.000Z",
      status: "posted",
      targetId: "t1"
    },
    {
      id: "draft-1",
      subreddit: "sales",
      kind: "comment",
      content: "scratch",
      createdAt: "2026-05-20T11:00:00.000Z",
      status: "drafted",
      targetId: "t2"
    }
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.id, "posted-1");
});

test("pruneDraftedRedditMemory writes pruned store to disk", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-memory-prune-"));
  const memoryPath = path.join(tempDir, "memory.json");
  await saveRedditMemory(memoryPath, {
    generatedAt: new Date().toISOString(),
    history: [
      {
        id: "draft-1",
        subreddit: "LocalLLaMA",
        kind: "comment",
        content: "old draft",
        createdAt: new Date().toISOString(),
        status: "drafted"
      }
    ]
  });

  await pruneDraftedRedditMemory(memoryPath);
  const memory = await loadRedditMemory(memoryPath);
  assert.equal(memory.history.length, 0);
});

test("appendRedditMemory preserves queued jobs, scan ledger, and upvote dedupe", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reddit-memory-append-"));
  const memoryPath = path.join(tempDir, "memory.json");
  await saveRedditMemory(memoryPath, {
    generatedAt: new Date().toISOString(),
    history: [],
    queuedJobs: [
      {
        id: "job-1",
        venue: "reddit",
        actionId: "action-1",
        candidateId: "candidate-1",
        type: "reply_to_comment",
        sourceDecisionId: "decision-1",
        status: "queued",
        createdAt: "2026-05-20T09:59:00.000Z",
        notBefore: "2026-05-20T10:00:00.000Z",
        attempts: 0,
        payload: {
          id: "action-1",
          venue: "reddit",
          type: "reply_to_comment",
          candidateId: "comment-1",
          content: "queued"
        }
      }
    ],
    scanLedger: [
      {
        postId: "post-1",
        subreddit: "AI_Agents",
        lastScannedAt: "2026-05-20T10:00:00.000Z",
        seenCommentIds: ["comment-1"]
      }
    ],
    upvotedThingIds: ["t1_existing"]
  });

  await appendRedditMemory(memoryPath, {
    id: "draft-1",
    subreddit: "AI_Agents",
    kind: "reply",
    content: "draft",
    createdAt: "2026-05-20T10:01:00.000Z",
    status: "drafted"
  });

  const memory = await loadRedditMemory(memoryPath);
  assert.equal(memory.history.length, 1);
  assert.equal(memory.queuedJobs?.length, 1);
  assert.equal(memory.scanLedger?.length, 1);
  assert.deepEqual(memory.upvotedThingIds, ["t1_existing"]);
});
