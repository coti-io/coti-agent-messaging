import { writeFile } from "node:fs/promises";

import { appendHeartbeatRunHistory } from "../heartbeat-run-history.js";
import { saveHeartbeatRunToStorage, type StoredHeartbeatRun } from "../storage.js";
import type { RunReporter } from "./contracts.js";

export class CompositeRunReporter implements RunReporter {
  constructor(
    private readonly statePath: string,
    private readonly heartbeatReportPath: string
  ) {}

  async persistRun(report: StoredHeartbeatRun): Promise<void> {
    await saveHeartbeatRunToStorage(this.statePath, report);
  }

  async writeLatestReport(report: unknown): Promise<void> {
    await writeFile(this.heartbeatReportPath, JSON.stringify(report, null, 2), "utf8");
  }

  async appendRunHistory(report: unknown): Promise<void> {
    await appendHeartbeatRunHistory(this.heartbeatReportPath, report);
  }
}
