import { existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
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
  for (const envPath of resolveOutreachEnvFilePaths(input)) {
    // Do not clobber variables already set on the process (e.g. live/soak batch scripts).
    loadDotenv({ path: envPath, override: false });
  }
}

loadOutreachEnv();
