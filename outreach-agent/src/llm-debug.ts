import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { MoltbookRuntimeConfig } from "./config.js";
import type { ChatMessage } from "./llm-client.js";

export async function saveLlmDebugInput(
  config: Pick<MoltbookRuntimeConfig, "llmDebugDir">,
  input: {
    phase: string;
    providerLabel?: string;
    runId?: string;
    messages: readonly ChatMessage[];
    context?: unknown;
  }
): Promise<string | undefined> {
  const debugDir = config.llmDebugDir;
  if (!debugDir) {
    return undefined;
  }

  await mkdir(debugDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${timestamp}-${sanitizeFileSegment(input.phase)}-${sanitizeFileSegment(
    input.runId ?? randomUUID().slice(0, 8)
  )}.json`;
  const outputPath = path.join(debugDir, fileName);
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        phase: input.phase,
        providerLabel: input.providerLabel,
        runId: input.runId,
        messages: input.messages,
        context: input.context
      },
      null,
      2
    ),
    "utf8"
  );
  return outputPath;
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}
