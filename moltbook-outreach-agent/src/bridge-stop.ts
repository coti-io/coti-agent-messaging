#!/usr/bin/env node

import { rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { resolveBridgeServerConfig } from "./bridge-server.js";

interface BridgeStatusPayload {
  pid?: number;
  bridgeDir?: string;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function removeBridgeDirSync(bridgeDir: string): void {
  try {
    rmSync(bridgeDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures in stop path.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function stopBridgeServer(): Promise<{
  ok: true;
  stopped: boolean;
  pid?: number;
  bridgeDir: string;
}> {
  const config = resolveBridgeServerConfig();
  const bridgeDir = config.bridgeDir;
  const statusPath = path.join(bridgeDir, "status.json");

  if (!(await pathExists(statusPath))) {
    removeBridgeDirSync(bridgeDir);
    return {
      ok: true,
      stopped: false,
      bridgeDir
    };
  }

  const raw = await readFile(statusPath, "utf8");
  const status = JSON.parse(raw) as BridgeStatusPayload;
  const pid = status.pid;

  if (!pid || !Number.isFinite(pid)) {
    removeBridgeDirSync(bridgeDir);
    return {
      ok: true,
      stopped: false,
      bridgeDir
    };
  }

  if (!isProcessAlive(pid)) {
    removeBridgeDirSync(bridgeDir);
    return {
      ok: true,
      stopped: false,
      pid,
      bridgeDir
    };
  }

  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid) && !(await pathExists(bridgeDir))) {
      return {
        ok: true,
        stopped: true,
        pid,
        bridgeDir
      };
    }
    await sleep(100);
  }

  if (isProcessAlive(pid)) {
    process.kill(pid, "SIGKILL");
  }
  removeBridgeDirSync(bridgeDir);
  return {
    ok: true,
    stopped: true,
    pid,
    bridgeDir
  };
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  stopBridgeServer()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
