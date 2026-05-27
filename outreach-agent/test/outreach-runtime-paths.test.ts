import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  defaultAttributionDbPath,
  defaultHeartbeatReportPath,
  defaultLlmDebugDir,
  defaultPromptRotationStatePath,
  resolvePaths,
  resolveRuntimeDataDir
} from "../src/config.js";

test("runtime path defaults colocate under the state directory", () => {
  const statePath = "/srv/outreach/.runtime/state.json";

  assert.equal(resolveRuntimeDataDir(statePath), "/srv/outreach/.runtime");
  assert.equal(
    defaultAttributionDbPath(statePath),
    "/srv/outreach/.runtime/outreach-attribution.sqlite"
  );
  assert.equal(defaultHeartbeatReportPath(statePath), "/srv/outreach/.runtime/last-heartbeat.json");
  assert.equal(
    defaultPromptRotationStatePath(statePath),
    "/srv/outreach/.runtime/prompt-rotation.json"
  );
  assert.equal(defaultLlmDebugDir(statePath), "/srv/outreach/.runtime/llm-debug");
});

test("resolvePaths uses runtime credentials when state lives under .runtime", () => {
  const previousStatePath = process.env.MOLTBOOK_STATE_PATH;
  const previousCredentialsPath = process.env.MOLTBOOK_CREDENTIALS_PATH;
  process.env.MOLTBOOK_STATE_PATH = "/tmp/outreach-runtime/state.json";
  delete process.env.MOLTBOOK_CREDENTIALS_PATH;

  try {
    const paths = resolvePaths();
    assert.equal(paths.statePath, "/tmp/outreach-runtime/state.json");
    assert.equal(paths.credentialsPath, "/tmp/outreach-runtime/credentials.json");
    assert.equal(paths.heartbeatReportPath, "/tmp/outreach-runtime/last-heartbeat.json");
  } finally {
    if (previousStatePath === undefined) {
      delete process.env.MOLTBOOK_STATE_PATH;
    } else {
      process.env.MOLTBOOK_STATE_PATH = previousStatePath;
    }
    if (previousCredentialsPath === undefined) {
      delete process.env.MOLTBOOK_CREDENTIALS_PATH;
    } else {
      process.env.MOLTBOOK_CREDENTIALS_PATH = previousCredentialsPath;
    }
  }
});

test("resolvePaths honors OUTREACH_RUNTIME_DIR for default state location", () => {
  const previousRuntimeDir = process.env.OUTREACH_RUNTIME_DIR;
  const previousStatePath = process.env.MOLTBOOK_STATE_PATH;
  delete process.env.MOLTBOOK_STATE_PATH;
  process.env.OUTREACH_RUNTIME_DIR = "/tmp/custom-runtime";

  try {
    const paths = resolvePaths();
    assert.equal(paths.statePath, path.join("/tmp/custom-runtime", "state.json"));
    assert.equal(paths.credentialsPath, path.join("/tmp/custom-runtime", "credentials.json"));
  } finally {
    if (previousRuntimeDir === undefined) {
      delete process.env.OUTREACH_RUNTIME_DIR;
    } else {
      process.env.OUTREACH_RUNTIME_DIR = previousRuntimeDir;
    }
    if (previousStatePath === undefined) {
      delete process.env.MOLTBOOK_STATE_PATH;
    } else {
      process.env.MOLTBOOK_STATE_PATH = previousStatePath;
    }
  }
});
