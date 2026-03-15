import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { loadProductFacts } from "../src/product-facts.js";
import type { MoltbookRuntimeConfig } from "../src/config.js";

test("loads product claims from the repo docs without requiring chain credentials", async () => {
  const packageRoot = path.resolve(import.meta.dirname, "..", "..");
  const config: MoltbookRuntimeConfig = {
    packageRoot,
    projectRoot: path.resolve(packageRoot, ".."),
    credentialsPath: path.join(packageRoot, ".tmp", "credentials.json"),
    statePath: path.join(packageRoot, ".tmp", "state.json"),
    moltbookBaseUrl: "https://www.moltbook.com/api/v1",
    defaultSubmolt: "general",
    dryRun: true,
    autoVerify: true
  };

  const facts = await loadProductFacts(config);

  assert.equal(facts.claims.length >= 4, true);
  assert.equal(facts.liveSnapshot.walletAddress, undefined);
  for (const claim of facts.claims) {
    assert.equal(claim.evidence.length > 0, true);
  }
});

