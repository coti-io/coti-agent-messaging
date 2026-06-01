import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_ENTRIES = 50;

export function heartbeatRunHistoryPath(heartbeatReportPath: string): string {
  return path.join(path.dirname(heartbeatReportPath), "heartbeat-runs.jsonl");
}

export async function appendHeartbeatRunHistory(
  heartbeatReportPath: string,
  report: unknown,
  maxEntries = DEFAULT_MAX_ENTRIES
): Promise<void> {
  const historyPath = heartbeatRunHistoryPath(heartbeatReportPath);
  await mkdir(path.dirname(historyPath), { recursive: true });
  await appendFile(historyPath, `${JSON.stringify(report)}\n`, "utf8");

  if (maxEntries <= 0) {
    return;
  }

  let raw = "";
  try {
    raw = await readFile(historyPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  const lines = raw.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length <= maxEntries) {
    return;
  }

  await writeFile(historyPath, `${lines.slice(-maxEntries).join("\n")}\n`, "utf8");
}
