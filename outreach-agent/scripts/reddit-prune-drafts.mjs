#!/usr/bin/env node
/** Clear ephemeral drafted rows before a new soak batch. Posted history is kept. */

import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const memoryModule = await import(path.join(packageRoot, "dist/src/reddit-memory.js"));
const memoryPath =
  process.env.OUTREACH_REDDIT_MEMORY_PATH?.trim() || memoryModule.defaultRedditMemoryPath(packageRoot);
const before = await memoryModule.loadRedditMemory(memoryPath);
const drafted = before.history.filter((entry) => entry.status === "drafted").length;
const store = await memoryModule.pruneDraftedRedditMemory(memoryPath);
console.log(
  JSON.stringify({
    ok: true,
    memoryPath,
    clearedDrafts: drafted,
    remaining: store.history.length
  })
);
