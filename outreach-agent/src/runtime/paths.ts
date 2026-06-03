import path from "node:path";

import { deriveStoragePath } from "../storage.js";
import type { MoltbookRuntimeConfig } from "../config.js";
import type { RuntimePaths } from "./contracts.js";

export function buildRuntimePaths(config: Pick<MoltbookRuntimeConfig, "statePath" | "heartbeatReportPath" | "attributionDbPath" | "promptRotationStatePath">): RuntimePaths {
  return {
    statePath: config.statePath,
    storagePath: deriveStoragePath(config.statePath),
    heartbeatReportPath: config.heartbeatReportPath,
    attributionDbPath: config.attributionDbPath,
    promptRotationStatePath: config.promptRotationStatePath
  };
}

export function analyticsReadModelPath(statePath: string): string {
  return path.join(path.dirname(statePath), "analytics-read-model.json");
}
