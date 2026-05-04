import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

test("coti message API returns a config error when contract address is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "analytics-server-"));
  const previousContract = process.env.CONTRACT_ADDRESS;
  const previousAgentRoot = process.env.MOLTBOOK_ANALYTICS_AGENT_ROOT;
  process.env.CONTRACT_ADDRESS = "";
  process.env.MOLTBOOK_ANALYTICS_AGENT_ROOT = tempDir;

  try {
    const { createServer } = await import("../src/server.js");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.equal(typeof address, "object");
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/coti/messages`);
      const body = (await response.json()) as { error?: string };
      assert.equal(response.status, 200);
      assert.match(body.error ?? "", /CONTRACT_ADDRESS/);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  } finally {
    if (previousContract === undefined) {
      delete process.env.CONTRACT_ADDRESS;
    } else {
      process.env.CONTRACT_ADDRESS = previousContract;
    }
    if (previousAgentRoot === undefined) {
      delete process.env.MOLTBOOK_ANALYTICS_AGENT_ROOT;
    } else {
      process.env.MOLTBOOK_ANALYTICS_AGENT_ROOT = previousAgentRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
