import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";

import { startManualBridgeServer } from "../src/bridge-server.js";
import type { ChatMessage } from "../src/llm-client.js";

async function waitForSingleFile(directory: string, timeoutMs = 5000): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const files = await readdir(directory);
    if (files.length > 0) {
      return files[0]!;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for file in ${directory}`);
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

test("manual bridge server waits for response files and returns the result", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "moltbook-bridge-server-"));
  const handle = await startManualBridgeServer({
    host: "127.0.0.1",
    port: 0,
    routePath: "/json-completion",
    bridgeDir: tempDir,
    responseTimeoutMs: 5000,
    pollIntervalMs: 50
  });

  try {
    const requestPromise = fetch(
      `http://${handle.config.host}:${handle.config.port}${handle.config.routePath}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messages: [
            {
              role: "system",
              content: "Select one candidate."
            },
            {
              role: "user",
              content: "Candidate shortlist."
            }
          ] satisfies ChatMessage[]
        })
      }
    );

    const requestFile = await waitForSingleFile(handle.requestsDir);
    await writeFile(
      path.join(handle.responsesDir, requestFile),
      JSON.stringify({
        selectedCandidateId: "comment:post-1",
        rationale: "Returned by manual file response."
      }),
      "utf8"
    );

    const response = await requestPromise;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      result: {
        selectedCandidateId: "comment:post-1",
        rationale: "Returned by manual file response."
      }
    });
    assert.deepEqual(await readdir(handle.requestsDir), []);
    assert.deepEqual(await readdir(handle.responsesDir), []);
  } finally {
    await handle.close();
  }

  assert.equal(await exists(tempDir), false);
});
