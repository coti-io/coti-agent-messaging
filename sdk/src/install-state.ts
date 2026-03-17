import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

interface PersistedInstallState {
  installId: string;
}

function resolveHomePath(relativePath: string): string {
  if (relativePath.startsWith("~/")) {
    const homeDir = process.env.HOME;
    if (!homeDir) {
      throw new Error("Cannot resolve '~' because HOME is not set.");
    }

    return path.join(homeDir, relativePath.slice(2));
  }

  return relativePath;
}

export function resolveInstallIdPath(explicitPath?: string): string {
  return resolveHomePath(
    explicitPath ??
      process.env.STARTER_GRANT_INSTALL_ID_PATH ??
      "~/.config/coti-agent-messaging/install-state.json"
  );
}

export async function getOrCreateInstallId(explicitPath?: string): Promise<string> {
  const installIdPath = resolveInstallIdPath(explicitPath);

  try {
    const raw = await readFile(installIdPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedInstallState>;
    if (parsed.installId && parsed.installId.length > 0) {
      return parsed.installId;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const installId = randomUUID();
  await mkdir(path.dirname(installIdPath), { recursive: true });
  const tempPath = `${installIdPath}.tmp`;
  await writeFile(tempPath, JSON.stringify({ installId }, null, 2), "utf8");
  await rename(tempPath, installIdPath);
  return installId;
}
