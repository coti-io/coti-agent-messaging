import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, stat } from "node:fs/promises";

import { stopBridgeServer } from "../src/bridge-stop.js";

async function exists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(targetPath: string, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await exists(targetPath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for ${targetPath}`);
}

test("bridge stop command terminates the running server and removes bridge files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "moltbook-bridge-stop-"));
  const statusPath = path.join(tempDir, "status.json");
  const originalDir = process.env.MOLTBOOK_LLM_BRIDGE_SERVER_DIR;
  const originalPort = process.env.MOLTBOOK_LLM_BRIDGE_SERVER_PORT;
  process.env.MOLTBOOK_LLM_BRIDGE_SERVER_DIR = tempDir;
  process.env.MOLTBOOK_LLM_BRIDGE_SERVER_PORT = "0";

  const bridgeProcess = spawn(
    process.execPath,
    [path.resolve(import.meta.dirname, "../src/bridge-server.js")],
    {
      env: process.env,
      stdio: "ignore"
    }
  );
  try {
    await waitForFile(statusPath);
    const result = await stopBridgeServer();
    assert.equal(result.ok, true);
    assert.equal(result.stopped, true);
    assert.equal(typeof result.pid, "number");
    assert.equal(result.bridgeDir, tempDir);
    assert.equal(await exists(tempDir), false);
  } finally {
    process.env.MOLTBOOK_LLM_BRIDGE_SERVER_DIR = originalDir;
    process.env.MOLTBOOK_LLM_BRIDGE_SERVER_PORT = originalPort;
    bridgeProcess.kill("SIGKILL");
  }
});
