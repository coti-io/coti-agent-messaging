import test from "node:test";
import assert from "node:assert/strict";

import { loadAnalyticsConfig } from "../src/config";

test("loadAnalyticsConfig defaults dashboard host to all interfaces", () => {
  const config = loadAnalyticsConfig({});

  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 8788);
});

test("loadAnalyticsConfig reads shared attribution database path", () => {
  const config = loadAnalyticsConfig({
    OUTREACH_ATTRIBUTION_DB_PATH: "/tmp/outreach-attribution.sqlite"
  });

  assert.equal(config.attributionDbPath, "/tmp/outreach-attribution.sqlite");
});
