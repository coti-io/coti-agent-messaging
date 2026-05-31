import { existsSync, readFileSync } from "node:fs";
import { parse as parseDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

function outreachAgentRootFromModule(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const moduleDir = path.dirname(currentFile);
  if (path.basename(path.dirname(moduleDir)) === "dist") {
    return path.resolve(moduleDir, "..", "..");
  }
  return path.resolve(moduleDir, "..");
}

/** Env files loaded in order; later files override earlier keys (dotenv override). */
export function resolveOutreachEnvFilePaths(input?: {
  packageRoot?: string;
  cwd?: string;
}): string[] {
  if (process.env.DOTENV_CONFIG_PATH) {
    return [process.env.DOTENV_CONFIG_PATH];
  }

  const packageRoot = input?.packageRoot ?? outreachAgentRootFromModule();
  const projectRoot = path.resolve(packageRoot, "..");
  const cwd = input?.cwd ?? process.cwd();
  const ordered: string[] = [];

  const pushUnique = (candidate: string) => {
    const resolved = path.resolve(candidate);
    if (!ordered.includes(resolved)) {
      ordered.push(resolved);
    }
  };

  pushUnique(path.join(projectRoot, ".env"));
  pushUnique(path.join(projectRoot, "moltbook-outreach-agent", ".env"));
  pushUnique(path.join(packageRoot, ".env"));
  pushUnique(path.join(cwd, ".env"));

  return ordered.filter((envPath) => existsSync(envPath));
}

export function loadOutreachEnv(input?: Parameters<typeof resolveOutreachEnvFilePaths>[0]): void {
  const preExistingKeys = new Set(Object.keys(process.env));
  for (const envPath of resolveOutreachEnvFilePaths(input)) {
    const parsed = parseDotenv(readFileSync(envPath));
    for (const [key, value] of Object.entries(parsed)) {
      // Later env files override earlier loaded files, but never clobber
      // variables already set by the parent process.
      if (!preExistingKeys.has(key)) {
        process.env[key] = value;
      }
    }
  }
}

loadOutreachEnv();
