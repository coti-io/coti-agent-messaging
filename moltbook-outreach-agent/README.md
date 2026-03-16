# Moltbook Outreach Agent

Autonomous Moltbook agent for promoting `coti-agent-messaging` to other agents without turning into a reward-chasing spam bot.

## What It Does

- registers or reuses a Moltbook identity
- runs a Moltbook heartbeat starting from `/home`
- prioritizes replies on its own posts over new outreach posts
- upvotes, comments, follows, and posts only when the policy layer allows it
- uses an LLM to choose one authored action from a bounded shortlist and draft the final copy
- grounds that draft in repo context from `sdk/`, `contracts/`, repo docs, recent authored history, and optional live COTI contract reads

## Core Pitch

The agent is designed to push three messages in the right order:

1. private message bodies are useful for high-value agent coordination
2. the stack is easy to integrate through the SDK or MCP surface
3. funded reward epochs are a bonus for real usage, not the headline

## Commands

```bash
npm run build -w @coti-agent-messaging/moltbook-outreach-agent

node moltbook-outreach-agent/dist/src/index.js register --name YourAgentName --description "What you do"
node moltbook-outreach-agent/dist/src/index.js status
node moltbook-outreach-agent/dist/src/index.js delete-post --post-id POST_ID
node moltbook-outreach-agent/dist/src/index.js facts
node moltbook-outreach-agent/dist/src/index.js bridge-server
node moltbook-outreach-agent/dist/src/index.js bridge-stop
node moltbook-outreach-agent/dist/src/index.js heartbeat
```

## Environment

### Moltbook

Required for authenticated operations:

```bash
MOLTBOOK_API_KEY=
```

Optional:

```bash
MOLTBOOK_BASE_URL=https://www.moltbook.com/api/v1
MOLTBOOK_DEFAULT_SUBMOLT=general
MOLTBOOK_CREDENTIALS_PATH=~/.config/moltbook/credentials.json
MOLTBOOK_STATE_PATH=/absolute/path/to/state.json
MOLTBOOK_HEARTBEAT_REPORT_PATH=/absolute/path/to/last-heartbeat.json
MOLTBOOK_DRY_RUN=false
MOLTBOOK_AUTO_VERIFY=true
MOLTBOOK_LLM_API_KEY=
MOLTBOOK_LLM_MODEL=openai/gpt-4o-mini
MOLTBOOK_LLM_BASE_URL=https://openrouter.ai/api/v1
MOLTBOOK_LLM_TIMEOUT_MS=20000
MOLTBOOK_LLM_APP_NAME=moltbook-outreach-agent
MOLTBOOK_LLM_SITE_URL=
MOLTBOOK_VERIFY_LLM_API_KEY=
MOLTBOOK_VERIFY_LLM_MODEL=openai/gpt-4o-mini
MOLTBOOK_VERIFY_LLM_BASE_URL=https://openrouter.ai/api/v1
MOLTBOOK_VERIFY_LLM_TIMEOUT_MS=20000
```

The `register` command can save credentials to `MOLTBOOK_CREDENTIALS_PATH`, so `MOLTBOOK_API_KEY` does not have to live in the environment after first setup.

`MOLTBOOK_LLM_API_KEY` or `OPENROUTER_API_KEY` enables the main content-generation model. The heartbeat uses it to choose among bounded write candidates and draft the final post, comment, or reply.

If your provider lives outside the Node process, you can point the agent at a tiny local bridge instead of OpenRouter:

```bash
MOLTBOOK_LLM_BRIDGE_URL=http://127.0.0.1:4318/json-completion
MOLTBOOK_LLM_BRIDGE_LABEL=local-bridge
MOLTBOOK_LLM_BRIDGE_TIMEOUT_MS=20000
MOLTBOOK_LLM_BRIDGE_AUTH_TOKEN=
```

The bridge receives the exact same `messages` array the OpenRouter path would receive. It should accept `POST` JSON shaped like `{ "messages": [...] }` and return either a direct JSON result object or `{ "result": ... }`.

If you just need a crude local endpoint for manual or external-process handling, the package also ships a tiny bridge server:

```bash
npm run build -w @coti-agent-messaging/moltbook-outreach-agent
npm run bridge:start -w @coti-agent-messaging/moltbook-outreach-agent
npm run bridge:stop -w @coti-agent-messaging/moltbook-outreach-agent
```

Or through the CLI:

```bash
node moltbook-outreach-agent/dist/src/index.js bridge-server
node moltbook-outreach-agent/dist/src/index.js bridge-stop
```

The included server writes each request to `requests/<id>.json` inside `MOLTBOOK_LLM_BRIDGE_SERVER_DIR`, waits for a matching `responses/<id>.json`, and returns that JSON as the model result.

By default, the bundled bridge server stores its scratch files under `moltbook-outreach-agent/.bridge/llm-bridge`.

If Moltbook's verification challenges are too garbled for the deterministic parser, verification now reuses the main LLM config by default. You only need `MOLTBOOK_VERIFY_LLM_*` if you want a separate model, key, or endpoint for captcha solving.

Verification can also use its own bridge endpoint through `MOLTBOOK_VERIFY_LLM_BRIDGE_*`. If omitted, verification falls back to the main injected provider, then the main bridge, then the HTTP/OpenRouter config.

The included bridge server itself is configured with:

```bash
MOLTBOOK_LLM_BRIDGE_SERVER_HOST=127.0.0.1
MOLTBOOK_LLM_BRIDGE_SERVER_PORT=4318
MOLTBOOK_LLM_BRIDGE_SERVER_PATH=/json-completion
MOLTBOOK_LLM_BRIDGE_SERVER_DIR=./moltbook-outreach-agent/.bridge/llm-bridge
MOLTBOOK_LLM_BRIDGE_SERVER_AUTH_TOKEN=
MOLTBOOK_LLM_BRIDGE_SERVER_RESPONSE_TIMEOUT_MS=300000
MOLTBOOK_LLM_BRIDGE_SERVER_POLL_INTERVAL_MS=500
```

Each heartbeat also writes a JSON report to `MOLTBOOK_HEARTBEAT_REPORT_PATH` or, by default, next to the state file as `last-heartbeat.json`. It includes performed actions, skipped actions, planned actions, write candidates, any reconciled pending writes, the selected write decision, and captured errors.

The state file also tracks `pendingWrites` for posts/comments/replies that may have landed remotely before a local failure finished. Later heartbeats reconcile those against profile recents, exact post comment trees, and Moltbook search results before planning new authored actions. If a pending write stays unreconciled long enough, it expires instead of blocking that target forever.

### COTI

Optional, but needed if you want live contract-backed facts:

```bash
PRIVATE_KEY=0x...
AES_KEY=...
CONTRACT_ADDRESS=0x...
COTI_NETWORK=testnet
COTI_RPC_URL=
COTI_TESTNET_RPC_URL=https://testnet.coti.io/rpc
COTI_MAINNET_RPC_URL=https://mainnet.coti.io/rpc
```

## Runtime Model

The runtime is split into a few narrow modules:

- `src/llm-client.ts`: shared OpenAI-compatible/OpenRouter client plus local bridge provider
- `src/llm-content.ts`: LLM shortlist selection and post/comment/reply drafting
- `src/repo-context.ts`: hybrid `sdk/` and `contracts/` summary plus lexical snippet retrieval
- `src/moltbook-api.ts`: typed Moltbook client with auth checks and verification handling
- `src/product-facts.ts`: repo-doc claims plus optional live reward/contract snapshot
- `src/policy.ts`: anti-spam, cooldown logic, and persisted recent authored history
- `src/heartbeat.ts`: orchestration for one Moltbook check-in cycle plus layered pending-write reconciliation and expiration
- `src/index.ts`: small CLI entrypoint

## Guardrails

- refuses to send Moltbook credentials to any host except `www.moltbook.com`
- does not lead with rewards when drafting outreach content
- does not create posts just because time passed
- treats replies on the agent's own posts as higher priority than new content
- respects local cooldown and daily comment accounting
- keeps candidate selection bounded by deterministic policy before handing the shortlist to the LLM
- supports `MOLTBOOK_DRY_RUN=true` so you can inspect behavior before letting it write
- persists uncertain authored writes before verification/network completion so later heartbeats can reconcile them instead of blindly retrying

## Testing

```bash
npm run test -w @coti-agent-messaging/moltbook-outreach-agent
```

The tests cover:

- Moltbook auth header behavior and verification solving
- LLM fallback behavior, pending-write reconciliation, and heartbeat orchestration with mocked model responses
- prompt parity between injected and HTTP providers, plus local bridge provider behavior
- policy prioritization and cooldown gating
- product-fact loading from repo docs
