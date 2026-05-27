import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
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
