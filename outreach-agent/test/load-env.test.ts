import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadOutreachEnv, resolveOutreachEnvFilePaths } from "../src/load-env.js";

test("resolveOutreachEnvFilePaths prefers repo and agent env files over cwd", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "outreach-env-root-"));
  const packageRoot = path.join(root, "outreach-agent");
  const moltbookDir = path.join(root, "moltbook-outreach-agent");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(moltbookDir, { recursive: true });
  await writeFile(path.join(root, ".env"), "FROM=root\n", "utf8");
  await writeFile(path.join(moltbookDir, ".env"), "FROM=moltbook\n", "utf8");
  await writeFile(path.join(packageRoot, ".env"), "FROM=package\n", "utf8");

  const paths = resolveOutreachEnvFilePaths({
    packageRoot,
    cwd: "/tmp/unrelated-cwd"
  });

  assert.deepEqual(paths, [
    path.join(root, ".env"),
    path.join(moltbookDir, ".env"),
    path.join(packageRoot, ".env")
  ]);
});

test("loadOutreachEnv lets later files override earlier keys", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "outreach-env-load-"));
  const packageRoot = path.join(root, "outreach-agent");
  const moltbookDir = path.join(root, "moltbook-outreach-agent");
  await mkdir(moltbookDir, { recursive: true });
  await writeFile(path.join(root, ".env"), "OPENROUTER_API_KEY=from-root\n", "utf8");
  await writeFile(path.join(moltbookDir, ".env"), "OPENROUTER_API_KEY=from-moltbook\n", "utf8");

  const previous = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;

  try {
    loadOutreachEnv({ packageRoot, cwd: packageRoot });
    assert.equal(process.env.OPENROUTER_API_KEY, "from-moltbook");
  } finally {
    if (previous === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previous;
    }
  }
});
