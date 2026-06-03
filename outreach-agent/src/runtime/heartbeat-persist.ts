import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { MoltbookRuntimeConfig } from "../config.js";
import { getOutreachAgentConfig } from "../config.js";
import { buildAnalyticsReadModelFromStorage } from "./analytics-read-model.js";
import { createRuntimePorts } from "./create-runtime-ports.js";
import { heartbeatReportToStoredRun, type HeartbeatReportLike } from "./heartbeat-report.js";

export async function persistMoltbookHeartbeatReport(
  config: Pick<MoltbookRuntimeConfig, "statePath" | "heartbeatReportPath">,
  report: HeartbeatReportLike
): Promise<void> {
  const ports = createRuntimePorts(config);
  await ports.runs.persistRun(heartbeatReportToStoredRun(report));
  await mkdir(path.dirname(config.heartbeatReportPath), { recursive: true });
  await ports.runs.writeLatestReport(report);
  await ports.runs.appendRunHistory(report);
}

export async function writeMoltbookAnalyticsReadModel(
  config: MoltbookRuntimeConfig,
  report: HeartbeatReportLike
): Promise<void> {
  const agent = getOutreachAgentConfig(config);
  const ports = createRuntimePorts(config);
  await ports.analytics.write(
    await buildAnalyticsReadModelFromStorage({
      statePath: config.statePath,
      heartbeatReportPath: config.heartbeatReportPath,
      venue: agent.venue,
      venueAccountId: agent.venueAccountId,
      agentId: config.agentId,
      runtimeKind: "heartbeat",
      attributionDbPath: config.attributionDbPath,
      promptRotationStatePath: config.promptRotationStatePath,
      latestRun: {
        runId: report.runId,
        status: report.status,
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        summary: report.summary
      }
    })
  );
}
