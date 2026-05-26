import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRedditBrowserStorageStatePath, resolveRedditMemoryPath } from "../src/config.js";

const testFile = fileURLToPath(import.meta.url);
const testDir = path.dirname(testFile);
const agentRoot =
  path.basename(path.dirname(testDir)) === "dist"
    ? path.resolve(testDir, "..", "..")
    : path.resolve(testDir, "..");

test("reddit memory path resolves under outreach-agent root", () => {
  const resolved = resolveRedditMemoryPath("outreach-agent/.data/reddit-memory.json");
  assert.equal(resolved, path.join(agentRoot, ".data", "reddit-memory.json"));
  assert.equal(resolveRedditMemoryPath(".data/reddit-memory.json"), path.join(agentRoot, ".data", "reddit-memory.json"));
});

test("reddit storage state path resolves under outreach-agent root", () => {
  const resolved = resolveRedditBrowserStorageStatePath(".browser/reddit-storage-state.json");
  assert.equal(resolved, path.join(agentRoot, ".browser", "reddit-storage-state.json"));
});
