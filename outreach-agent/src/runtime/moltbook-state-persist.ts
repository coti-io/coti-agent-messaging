import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { OutreachAgentState } from "../policy.js";
import { saveStateToStorage } from "../storage.js";
import { loadStateFromStorage } from "../storage.js";

export async function loadMoltbookAgentState(
  statePath: string,
  heartbeatReportPath: string
): Promise<OutreachAgentState> {
  return await loadStateFromStorage(statePath, heartbeatReportPath);
}

function stateSidecarPaths(statePath: string) {
  const parsed = path.parse(statePath);
  return {
    previousPath: path.join(parsed.dir, `${parsed.name}.previous${parsed.ext}`),
    auditPath: path.join(parsed.dir, `${parsed.name}.audit.jsonl`)
  };
}

async function readOptionalUtf8(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeTextAtomic(filePath: string, contents: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tempPath, contents, "utf8");
  await rename(tempPath, filePath);
}

export async function saveMoltbookAgentState(
  statePath: string,
  state: OutreachAgentState,
  runId?: string
): Promise<OutreachAgentState> {
  await mkdir(path.dirname(statePath), { recursive: true });
  const previousRaw = await readOptionalUtf8(statePath);
  const persistedState = await saveStateToStorage(statePath, state, runId);
  const nextRaw = JSON.stringify(persistedState, null, 2);
  const { previousPath, auditPath } = stateSidecarPaths(statePath);

  if (previousRaw !== undefined && previousRaw !== nextRaw) {
    await writeTextAtomic(previousPath, previousRaw);
  }

  await writeTextAtomic(statePath, nextRaw);

  const previousState =
    previousRaw === undefined ? undefined : (JSON.parse(previousRaw) as Partial<OutreachAgentState>);
  const auditEntry = {
    savedAt: new Date().toISOString(),
    path: statePath,
    previousEngagementTotals: previousState?.engagementTotals,
    nextEngagementTotals: persistedState.engagementTotals,
    previousDailyCounts:
      previousState === undefined
        ? undefined
        : {
            posts: previousState.dailyPostCount,
            comments: previousState.dailyCommentCount,
            topLevelComments: previousState.dailyTopLevelCommentCount,
            replies: previousState.dailyReplyCount
          },
    nextDailyCounts: {
      posts: persistedState.dailyPostCount,
      comments: persistedState.dailyCommentCount,
      topLevelComments: persistedState.dailyTopLevelCommentCount,
      replies: persistedState.dailyReplyCount
    },
    previousStateBytes: previousRaw ? Buffer.byteLength(previousRaw, "utf8") : 0,
    nextStateBytes: Buffer.byteLength(nextRaw, "utf8")
  };
  await appendFile(auditPath, `${JSON.stringify(auditEntry)}\n`, "utf8");
  return persistedState;
}
