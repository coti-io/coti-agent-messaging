import { runRedditExecutor } from "./runtime/reddit-executor-run.js";
import { runRedditHeartbeat, runRedditSession } from "./reddit-session.js";

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

export async function runRedditSessionCli(): Promise<void> {
  const subreddits = getArg("--subreddits")?.split(",").map((entry) => entry.trim()).filter(Boolean);
  const maxActions = Number(getArg("--max-actions") ?? "1");
  const report = await runRedditSession({
    dryRun: hasFlag("--dry-run") ? true : hasFlag("--live") ? false : undefined,
    maxActions: Number.isFinite(maxActions) && maxActions >= 0 ? maxActions : 1,
    subreddits,
    once: hasFlag("--once")
  });
  console.log(JSON.stringify(report, null, 2));
}

export async function runRedditHeartbeatCli(): Promise<void> {
  const subreddits = getArg("--subreddits")?.split(",").map((entry) => entry.trim()).filter(Boolean);
  const maxActions = Number(getArg("--max-actions") ?? "1");
  const report = await runRedditHeartbeat({
    dryRun: hasFlag("--dry-run") ? true : hasFlag("--live") ? false : undefined,
    maxActions: Number.isFinite(maxActions) && maxActions >= 0 ? maxActions : 1,
    subreddits,
    once: hasFlag("--once")
  });
  console.log(JSON.stringify(report, null, 2));
}

export async function runRedditExecutorCli(): Promise<void> {
  const report = await runRedditExecutor({
    dryRun: hasFlag("--dry-run") ? true : hasFlag("--live") ? false : undefined
  });
  console.log(JSON.stringify(report, null, 2));
}
