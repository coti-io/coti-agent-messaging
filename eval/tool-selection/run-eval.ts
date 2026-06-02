import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface ToolDefinition {
  name: string;
  description: string;
}

interface EvalTask {
  id: string;
  expectedTool: string | null;
  task: string;
}

interface EvalResult {
  id: string;
  task: string;
  expectedTool: string | null;
  selectedTool: string | null;
  rationale: string;
  correct: boolean;
}

function parseArgs(): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) {
      continue;
    }
    const key = entry.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

async function readJsonlTasks(filePath: string): Promise<EvalTask[]> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvalTask);
}

function chooseByKeyword(task: EvalTask): Pick<EvalResult, "selectedTool" | "rationale"> {
  const text = task.task.toLowerCase();
  if (/\bmessage id\b|\bknown message\b|\bmessage 42\b|\bmessage id 17\b/u.test(text)) {
    return { selectedTool: "read_message", rationale: "Keyword sanity mode matched known-message lookup." };
  }
  if (/\binbox\b|\bincoming\b|\breplied\b|\breplies\b|\bmailbox\b|\bpoll\b/u.test(text)) {
    return { selectedTool: "list_inbox", rationale: "Keyword sanity mode matched inbox processing." };
  }
  if (/\bsent\b|\balready sent\b|\bsent-history\b|\baudit\b/u.test(text)) {
    return { selectedTool: "list_sent", rationale: "Keyword sanity mode matched sent-history audit." };
  }
  if (/\bmetadata\b|\brouting\b|\btimestamp\b/u.test(text)) {
    return { selectedTool: "get_message_metadata", rationale: "Keyword sanity mode matched metadata-only lookup." };
  }
  if (/\bcounts?\b|\bstats\b/u.test(text)) {
    return { selectedTool: "get_account_stats", rationale: "Keyword sanity mode matched account stats." };
  }
  if (/\bcurrent reward epoch\b|\bcurrent epoch\b/u.test(text)) {
    return { selectedTool: "get_current_epoch", rationale: "Keyword sanity mode matched current epoch." };
  }
  if (/\bpending rewards?\b|\bclaimable\b/u.test(text)) {
    return { selectedTool: "get_pending_rewards", rationale: "Keyword sanity mode matched pending rewards." };
  }
  if (/\bclaim\b.*\brewards?\b/u.test(text)) {
    return { selectedTool: "claim_rewards", rationale: "Keyword sanity mode matched reward claim." };
  }
  if (/\bstarter grant\b|\bno gas\b/u.test(text)) {
    return { selectedTool: "request_starter_grant", rationale: "Keyword sanity mode matched starter grant." };
  }
  if (
    /\bprivate\b|\banother agent\b|\bspecialist\b|\bdelegate\b|\breview\b|\bcoordination\b|\bcoordinate\b|\bfact-check\b|\bprivately\b/u.test(
      text
    )
  ) {
    return { selectedTool: "send_message", rationale: "Keyword sanity mode matched private agent-to-agent send." };
  }
  return { selectedTool: null, rationale: "Keyword sanity mode found no tool requirement." };
}

function systemPrompt(tools: ToolDefinition[]): string {
  const toolList = tools
    .map((tool) => `- ${tool.name}: ${tool.description}`)
    .join("\n");

  return [
    "You are evaluating tool selection for an autonomous AI agent.",
    "Choose exactly one tool from the list, or null if no listed tool should be used.",
    "Prefer the narrowest correct tool. Do not choose private messaging for public chat, local memory, shared files, or generic web/search/git/test tasks.",
    "Return strict JSON with selectedTool and rationale.",
    "",
    "Tools:",
    toolList
  ].join("\n");
}

async function chooseByModel(task: EvalTask, tools: ToolDefinition[], model: string): Promise<Pick<EvalResult, "selectedTool" | "rationale">> {
  const apiKeySource = process.env.OPENAI_API_KEY
    ? "openai"
    : process.env.OPENROUTER_API_KEY
      ? "openrouter"
      : process.env.MOLTBOOK_LLM_API_KEY
        ? "moltbook"
        : undefined;
  const apiKey = apiKeySource
    ? process.env.OPENAI_API_KEY ?? process.env.OPENROUTER_API_KEY ?? process.env.MOLTBOOK_LLM_API_KEY
    : undefined;
  if (!apiKey) {
    throw new Error("Set OPENAI_API_KEY, OPENROUTER_API_KEY, or MOLTBOOK_LLM_API_KEY, or run with --mode keyword.");
  }

  const inferredBaseUrl =
    apiKeySource === "openrouter" || apiKeySource === "moltbook" || apiKey.startsWith("sk-or-")
      ? "https://openrouter.ai/api/v1"
      : "https://api.openai.com/v1";
  const baseUrl =
    process.env.OPENAI_BASE_URL ??
    process.env.OPENROUTER_BASE_URL ??
    process.env.MOLTBOOK_LLM_BASE_URL ??
    inferredBaseUrl;
  const response = await fetch(`${baseUrl.replace(/\/$/u, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt(tools) },
        { role: "user", content: task.task }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Model request failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Model response did not include message content.");
  }

  const parsed = JSON.parse(content) as {
    selectedTool?: string | null;
    rationale?: string;
  };
  const allowedTools = new Set(tools.map((tool) => tool.name));
  const selectedTool =
    parsed.selectedTool && allowedTools.has(parsed.selectedTool) ? parsed.selectedTool : null;
  return {
    selectedTool,
    rationale: parsed.rationale ?? "No rationale returned."
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const variant = String(args.variant ?? "optimized");
  const mode = String(args.mode ?? "model");
  const model = String(
    args.model ??
      process.env.TOOL_SELECTION_EVAL_MODEL ??
      process.env.MOLTBOOK_LLM_MODEL ??
      "gpt-4o-mini"
  );
  const root = path.resolve(import.meta.dirname);
  const tasksPath = path.resolve(root, String(args.tasks ?? "tasks.jsonl"));
  const toolsPath = path.resolve(root, String(args.tools ?? `tools.${variant}.json`));
  const outDir = path.resolve(root, String(args.outDir ?? "results"));
  const outPath = path.join(outDir, `${variant}.${mode}.jsonl`);

  const [tasks, tools] = await Promise.all([
    readJsonlTasks(tasksPath),
    readFile(toolsPath, "utf8").then((raw) => JSON.parse(raw) as ToolDefinition[])
  ]);

  await mkdir(outDir, { recursive: true });

  const results: EvalResult[] = [];
  for (const task of tasks) {
    const choice =
      mode === "keyword"
        ? chooseByKeyword(task)
        : await chooseByModel(task, tools, model);
    results.push({
      ...task,
      selectedTool: choice.selectedTool,
      rationale: choice.rationale,
      correct: choice.selectedTool === task.expectedTool
    });
  }

  await writeFile(outPath, `${results.map((result) => JSON.stringify(result)).join("\n")}\n`, "utf8");
  console.log(JSON.stringify({
    variant,
    mode,
    model: mode === "model" ? model : undefined,
    tasks: tasks.length,
    outPath
  }, null, 2));
}

await main();
