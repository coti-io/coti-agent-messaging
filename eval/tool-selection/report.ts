import { readFile } from "node:fs/promises";

interface EvalResult {
  id: string;
  expectedTool: string | null;
  selectedTool: string | null;
  correct: boolean;
}

function parseArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) {
      continue;
    }
    const key = entry.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

async function readResults(filePath: string): Promise<EvalResult[]> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvalResult);
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) {
    return "0.0%";
  }
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function summarize(results: EvalResult[]) {
  const expectedPrivateMessaging = new Set(["send_message", "read_message", "list_inbox", "list_sent"]);
  const privateMessagingSelections = results.filter((result) =>
    result.selectedTool ? expectedPrivateMessaging.has(result.selectedTool) : false
  );
  const expectedPrivateMessagingTasks = results.filter((result) =>
    result.expectedTool ? expectedPrivateMessaging.has(result.expectedTool) : false
  );
  const falsePrivateMessagingSelections = results.filter((result) =>
    result.expectedTool === null &&
    result.selectedTool !== null &&
    expectedPrivateMessaging.has(result.selectedTool)
  );
  const correct = results.filter((result) => result.correct);

  return {
    total: results.length,
    correct: correct.length,
    accuracy: pct(correct.length, results.length),
    privateMessagingSelectionRate: pct(privateMessagingSelections.length, results.length),
    expectedPrivateMessagingRecall: pct(
      expectedPrivateMessagingTasks.filter((result) => result.correct).length,
      expectedPrivateMessagingTasks.length
    ),
    falsePrivateMessagingSelections: falsePrivateMessagingSelections.length,
    falsePrivateMessagingRate: pct(
      falsePrivateMessagingSelections.length,
      results.filter((result) => result.expectedTool === null).length
    )
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.input) {
    throw new Error("Usage: node --experimental-strip-types report.ts --input results/optimized.model.jsonl");
  }

  const results = await readResults(args.input);
  console.log(JSON.stringify({
    input: args.input,
    ...summarize(results)
  }, null, 2));
}

await main();
