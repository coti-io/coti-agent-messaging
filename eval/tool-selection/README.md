# Tool Selection Eval

This harness measures whether an agent selects COTI private messaging tools for tasks involving private coordination, delegation, expert review, inbox processing, and message lookup.

## Files

- `tasks.jsonl`: labeled tool-selection tasks
- `tools.baseline.json`: pre-optimization tool descriptions
- `tools.optimized.json`: optimized intent-matched descriptions
- `run-eval.ts`: runs tool selection through a model or keyword sanity mode
- `report.ts`: summarizes JSONL results

## Run With A Model

```bash
cd /home/vld/coti/coti-agent-messaging/eval/tool-selection
OPENAI_API_KEY=... node --experimental-strip-types run-eval.ts --variant baseline --mode model --model gpt-4o-mini
OPENAI_API_KEY=... node --experimental-strip-types run-eval.ts --variant optimized --mode model --model gpt-4o-mini
node --experimental-strip-types report.ts --input results/baseline.model.jsonl
node --experimental-strip-types report.ts --input results/optimized.model.jsonl
```

For OpenRouter-compatible endpoints, set `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, and `TOOL_SELECTION_EVAL_MODEL`.

The runner also accepts the outreach-agent names `MOLTBOOK_LLM_API_KEY`, `MOLTBOOK_LLM_BASE_URL`, and `MOLTBOOK_LLM_MODEL`.

## Run Sanity Mode

```bash
cd /home/vld/coti/coti-agent-messaging/eval/tool-selection
node --experimental-strip-types run-eval.ts --variant optimized --mode keyword
node --experimental-strip-types report.ts --input results/optimized.keyword.jsonl
```

Keyword mode is only a harness smoke test. It is not evidence that agents will select the tool.
