import type { MoltbookRuntimeConfig } from "../config.js";
import type { OutreachRuntimePorts } from "./contracts.js";
import { FileAnalyticsReadModelWriter } from "./analytics-read-model.js";
import { buildRuntimePaths } from "./paths.js";
import { CompositeRunReporter } from "./run-reporter.js";
import { SqliteActionJobStore, SqliteAgentStateStore } from "./sqlite-action-job-store.js";

export function createRuntimePorts(config: Pick<MoltbookRuntimeConfig, "statePath" | "heartbeatReportPath">): OutreachRuntimePorts {
  const state = new SqliteAgentStateStore(config.statePath, config.heartbeatReportPath);
  return {
    state,
    jobs: new SqliteActionJobStore(state),
    runs: new CompositeRunReporter(config.statePath, config.heartbeatReportPath),
    analytics: new FileAnalyticsReadModelWriter(config.statePath)
  };
}

export function createRuntimeContext(input: {
  config: MoltbookRuntimeConfig;
  phase: "heartbeat" | "executor" | "session";
  dryRun: boolean;
}): {
  paths: ReturnType<typeof buildRuntimePaths>;
  ports: OutreachRuntimePorts;
} {
  const paths = buildRuntimePaths(input.config);
  return {
    paths,
    ports: createRuntimePorts(input.config)
  };
}
