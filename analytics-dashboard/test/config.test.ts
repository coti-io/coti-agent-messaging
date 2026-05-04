import test from "node:test";
import assert from "node:assert/strict";

import { loadAnalyticsConfig } from "../src/config";

test("loadAnalyticsConfig defaults dashboard host to all interfaces", () => {
  const config = loadAnalyticsConfig({});

  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 8788);
});
