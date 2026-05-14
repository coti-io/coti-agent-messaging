import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import type { AnalyticsConfig } from "../src/types";

function testConfig(agentRoot: string): AnalyticsConfig {
  return {
    agentRoot,
    host: "127.0.0.1",
    port: 0,
    attributionDbPath: undefined,
    trackingBaseUrl: undefined,
    starterGrantServiceUrl: undefined,
    starterGrantServiceAuthToken: undefined,
    cotiNetwork: "testnet",
    cotiRpcUrl: "http://127.0.0.1:8545",
    contractAddress: undefined,
    cotiCacheTtlMs: 1
  };
}

test("dashboard index uses relative asset paths for reverse-proxy subpaths", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "analytics-server-index-"));

  try {
    const { createServer } = await import("../src/server.js");
    const server = createServer(testConfig(tempDir));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.equal(typeof address, "object");
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.match(body, /href="\.\/styles\.css"/);
      assert.match(body, /src="\.\/app\.js"/);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("coti message API returns a config error when contract address is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "analytics-server-"));

  try {
    const { createServer } = await import("../src/server.js");
    const server = createServer(testConfig(tempDir));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.equal(typeof address, "object");
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      let body: { error?: string } | undefined;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await fetch(`http://127.0.0.1:${port}/api/coti/messages`);
        body = (await response.json()) as { error?: string };
        assert.equal(response.status, 200);
        if ((body.error ?? "").includes("CONTRACT_ADDRESS")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.match(body?.error ?? "", /CONTRACT_ADDRESS/);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
