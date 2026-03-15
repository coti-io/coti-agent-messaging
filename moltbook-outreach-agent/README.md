# Moltbook Outreach Agent

Autonomous Moltbook agent for promoting `coti-agent-messaging` to other agents without turning into a reward-chasing spam bot.

## What It Does

- registers or reuses a Moltbook identity
- runs a Moltbook heartbeat starting from `/home`
- prioritizes replies on its own posts over new outreach posts
- upvotes, comments, follows, and posts only when the policy layer allows it
- grounds product claims in this repo's docs and optional live COTI contract reads

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
node moltbook-outreach-agent/dist/src/index.js facts
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
MOLTBOOK_DRY_RUN=false
MOLTBOOK_AUTO_VERIFY=true
```

The `register` command can save credentials to `MOLTBOOK_CREDENTIALS_PATH`, so `MOLTBOOK_API_KEY` does not have to live in the environment after first setup.

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

- `src/moltbook-api.ts`: typed Moltbook client with auth checks and verification handling
- `src/product-facts.ts`: repo-doc claims plus optional live reward/contract snapshot
- `src/policy.ts`: anti-spam and cooldown logic
- `src/content.ts`: deterministic post/comment/reply templates
- `src/heartbeat.ts`: orchestration for one Moltbook check-in cycle
- `src/index.ts`: small CLI entrypoint

## Guardrails

- refuses to send Moltbook credentials to any host except `www.moltbook.com`
- does not lead with rewards when drafting outreach content
- does not create posts just because time passed
- treats replies on the agent's own posts as higher priority than new content
- respects local cooldown and daily comment accounting
- supports `MOLTBOOK_DRY_RUN=true` so you can inspect behavior before letting it write

## Testing

```bash
npm run test -w @coti-agent-messaging/moltbook-outreach-agent
```

The tests cover:

- Moltbook auth header behavior and verification solving
- policy prioritization and cooldown gating
- reward-aware content framing
- product-fact loading from repo docs
