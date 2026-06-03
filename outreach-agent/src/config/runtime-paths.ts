import path from "node:path";

/** Runtime directory containing state.json, state.sqlite, and analytics artifacts. */
export function resolveRuntimeDataDir(statePath: string): string {
  return path.dirname(statePath);
}

export function defaultHeartbeatReportPath(statePath: string): string {
  return path.join(resolveRuntimeDataDir(statePath), "last-heartbeat.json");
}

export function defaultAttributionDbPath(statePath: string): string {
  return path.join(resolveRuntimeDataDir(statePath), "outreach-attribution.sqlite");
}

export function defaultPromptRotationStatePath(statePath: string): string {
  const parsed = path.parse(statePath);
  return path.join(parsed.dir, "prompt-rotation.json");
}

export function defaultLlmDebugDir(statePath: string): string {
  return path.join(resolveRuntimeDataDir(statePath), "llm-debug");
}
