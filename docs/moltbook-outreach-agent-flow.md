# Moltbook Outreach Agent Flow

Detailed runtime note for how the Moltbook outreach agent actually works.

This doc is about the Moltbook venue flow in `outreach-agent/`.

## What It Is

This agent is a bounded social automation loop for promoting `coti-agent-messaging` on Moltbook without turning into low-signal spam.

Its job is not "post constantly" and it is not a generic autonomous research agent.

What it actually does:

- checks Moltbook activity on a heartbeat
- prioritizes replies on its own posts
- optionally upvotes and follows relevant accounts
- decides whether to comment on a relevant post
- creates a top-level post only when policy says the timing is justified
- lets the LLM choose one authored action from a bounded shortlist
- grounds that authored content in repo docs, retrieved repo snippets, recent authored history, and optional live COTI facts

## What It Is Not

Do not describe this thing sloppily.

It is not:

- a runtime built on the repo's MCP server
- a browser automation bot
- a fully unconstrained LLM agent
- a DM automation system
- a general captcha solver

More precise wording:

- it uses the Moltbook HTTP API for social actions
- it uses deterministic policy to bound what can happen
- it uses the LLM only for shortlist selection and final draft generation
- it can optionally use the SDK directly for live COTI facts
- it promotes the repo's MCP surface, but does not use that MCP server as its own execution backend

## Main Entry Points

CLI entrypoint:

- `outreach-agent/src/index.ts`

Important commands:

```bash
npm run build -w @coti-agent-messaging/outreach-agent

node outreach-agent/dist/src/index.js register --name YourAgentName --description "What you do"
node outreach-agent/dist/src/index.js status
node outreach-agent/dist/src/index.js delete-post --post-id POST_ID
node outreach-agent/dist/src/index.js facts
node outreach-agent/dist/src/index.js bridge-server
node outreach-agent/dist/src/index.js bridge-stop
node outreach-agent/dist/src/index.js heartbeat
```

The heartbeat command is the core runtime loop.

## Required And Optional Runtime Inputs

### Moltbook Auth

Required for authenticated operations:

```bash
MOLTBOOK_API_KEY=
```

Optional runtime config:

```bash
MOLTBOOK_BASE_URL=https://www.moltbook.com/api/v1
MOLTBOOK_DEFAULT_SUBMOLT=general
MOLTBOOK_CREDENTIALS_PATH=~/.config/moltbook/credentials.json
MOLTBOOK_STATE_PATH=/absolute/path/to/state.json
MOLTBOOK_HEARTBEAT_REPORT_PATH=/absolute/path/to/last-heartbeat.json
MOLTBOOK_DRY_RUN=false
MOLTBOOK_AUTO_VERIFY=true
```

### LLM Config

Direct provider path:

```bash
MOLTBOOK_LLM_API_KEY=
MOLTBOOK_LLM_MODEL=openai/gpt-4o-mini
MOLTBOOK_LLM_BASE_URL=https://openrouter.ai/api/v1
MOLTBOOK_LLM_TIMEOUT_MS=20000
MOLTBOOK_LLM_APP_NAME=outreach-agent
MOLTBOOK_LLM_SITE_URL=
```

Local bridge path:

```bash
MOLTBOOK_LLM_BRIDGE_URL=http://127.0.0.1:4318/json-completion
MOLTBOOK_LLM_BRIDGE_LABEL=local-bridge
MOLTBOOK_LLM_BRIDGE_TIMEOUT_MS=20000
MOLTBOOK_LLM_BRIDGE_AUTH_TOKEN=
```

Verification fallback can reuse the same model config or use dedicated `MOLTBOOK_VERIFY_LLM_*` or `MOLTBOOK_VERIFY_LLM_BRIDGE_*` values.

### Optional Live COTI Facts

Needed only if you want the outreach agent to include live contract-backed facts:

```bash
PRIVATE_KEY=0x...
AES_KEY=...
CONTRACT_ADDRESS=0x...
COTI_NETWORK=testnet
COTI_RPC_URL=
COTI_TESTNET_RPC_URL=https://testnet.coti.io/rpc
COTI_MAINNET_RPC_URL=https://mainnet.coti.io/rpc
```

Without those values, the outreach agent still works, but fact grounding is docs-only.

## Runtime Architecture

The runtime is split into narrow modules on purpose:

- `src/index.ts`: CLI command dispatch
- `src/heartbeat.ts`: one full Moltbook heartbeat cycle
- `src/policy.ts`: deterministic action planning, cooldowns, and local memory shaping
- `src/llm-content.ts`: choose one write candidate and draft the final content
- `src/moltbook-api.ts`: typed Moltbook API client and verification handling
- `src/product-facts.ts`: grounded product claims from repo docs plus optional live COTI reads
- `src/repo-context.ts`: lightweight retrieval over `sdk/` and `contracts/`
- `src/llm-client.ts`: LLM provider abstraction
- `src/bridge-server.ts`: tiny local JSON bridge

That split matters because the agent is intentionally not a blob of prompt spaghetti.

## Full Heartbeat Flow

The `heartbeat` command runs one cycle, not an endless daemon loop.

Ordered runtime flow:

1. `src/index.ts` loads runtime config and calls `runHeartbeat(...)`.
2. `src/heartbeat.ts` builds `MoltbookApiClient` with auth, `autoVerify`, and optional verification LLM support.
3. The heartbeat loads four inputs in parallel:
   - Moltbook `/home`
   - current account/profile via `/agents/me`
   - product facts via `loadProductFacts(...)`
   - persisted local state from the state file
4. It fetches the explore feed.
5. It normalizes local state and creates a persistence helper.
6. It reconciles any `pendingWrites` left over from earlier partially successful writes.
7. It decides whether the agent should be treated as "new" for stricter cooldowns.
8. It calls `planHeartbeatActions(...)` to produce a deterministic list of candidate actions.
9. It executes non-authored actions directly when allowed, such as upvotes and follows.
10. It converts authored actions into a bounded shortlist of write candidates.
11. If any write candidates remain, it asks the LLM to choose exactly one candidate from that shortlist.
12. It asks the LLM to draft the final content for that chosen candidate only.
13. Before writing, it persists a `pendingWrite`.
14. It sends the actual Moltbook API write request.
15. On success, it recovers local state, removes the pending write, and records the result.
16. It writes a heartbeat report JSON summarizing what happened.

If several authored actions are possible, the agent still writes at most one authored action per heartbeat.

## Deterministic Policy Layer

The planning step in `src/policy.ts` is where most of the guardrails live.

Priority order:

1. reply to activity on the agent's own posts
2. mark pending DM inspection if there are direct-message requests
3. upvote relevant posts
4. follow relevant authors
5. comment on relevant posts
6. create a new outreach post only if nothing more urgent is waiting and cooldowns allow it

Important gating rules:

- replies/comments are blocked by comment cooldowns and daily comment limits
- new agents use stricter cooldowns than older ones
- top-level posts have their own cooldown
- already-upvoted posts are skipped
- already-followed agents are skipped
- duplicate pending write targets are skipped
- if nothing useful is available, the planner returns `noop`

Relevance is not magic. Post scoring is simple and lexical, based on terms such as:

- `private`
- `messaging`
- `agent`
- `mcp`
- `sdk`
- `integration`
- `reward`
- `coti`

If the planner cannot justify an action, it should do nothing. That is a feature, not a bug.

## Authored Action Selection

The most important design choice is that the LLM does not invent actions from scratch.

The actual flow in `src/llm-content.ts` is:

1. the deterministic planner produces a shortlist of write candidates
2. the runtime labels them as `A`, `B`, `C`, and so on
3. the LLM first chooses one candidate label
4. only after selection does the LLM draft the final title/body or reply/comment text

This matters because:

- policy determines the action envelope
- the model only chooses within that envelope
- the model only drafts one selected action

That is much safer than "ask the LLM what to do next" and hope it behaves.

## How Draft Grounding Works

The agent does not draft from vibes alone.

The draft step combines four grounding layers:

1. `product-facts.ts` loads product claims from:
   - `docs/overview.md`
   - `docs/mcp.md`
   - `docs/rewards.md`
   - `docs/outreach-reference.md`
2. `repo-context.ts` retrieves lightweight repo summaries/snippets from `sdk/` and `contracts/`
3. local state contributes recent authored history so the model avoids repeating itself
4. optional live COTI reads contribute current epoch, contract config, wallet address, and pending rewards

Important nuance:

- the outreach agent talks about the MCP/SDK product surface
- the outreach agent itself uses Moltbook APIs for execution
- optional live facts come from the SDK directly, not from the MCP server

If someone says "the outreach agent runs on MCP," that is lazy and wrong.

## Writing Style Constraints

The LLM prompts are deliberately restrictive.

Behavior enforced in `src/llm-content.ts`:

- sound like a technical realist, not a marketer
- prefer direct tradeoffs over slogans
- do not lead with rewards unless the target is explicitly discussing rewards
- use at most two concrete product claims unless the thread demands more
- avoid repeating recent authored phrasing
- keep replies and comments compact
- require a title for top-level posts
- reject replies/comments that use doc-style inline code formatting
- reject drafts that are too short, too long, or too similar to recent authored history

The tone is intentionally sharper than polite corporate sludge. Good.

## Pending Write Reconciliation

This is one of the least obvious but most important behaviors.

Before performing a write, the heartbeat stores a `pendingWrite` in local state. That exists because the remote write may succeed even if the local process crashes or loses the response.

On later heartbeats, `src/heartbeat.ts` tries to reconcile unresolved pending writes in this order:

1. inspect the agent profile's recent posts/comments
2. inspect the exact target comment thread when relevant
3. search Moltbook as a fallback

If a match is found:

- local state is recovered as if the write succeeded
- the pending entry is removed

If no match is found:

- a reconciliation miss counter increments
- after too many misses, the pending write expires

This is sane defensive engineering. Blind retries would be trash.

## Moltbook Verification Handling

The Moltbook client can hit verification challenges on write operations.

Current behavior:

- deterministic parsing/solving is attempted first
- if that fails and verification LLM support is configured, the agent falls back to the verification model
- the challenge flow is about solving Moltbook's verification prompts, not a general browser captcha system

Do not oversell this. "Auto-verification fallback" is accurate. "Universal captcha solver" is fantasy.

## State And Report Files

Local state tracks:

- first seen / last heartbeat timestamps
- post and comment cooldown memory
- daily comment counters
- upvoted posts
- followed agents
- replied comment ids
- created post fingerprints
- recent generated artifacts
- pending writes

By default these files live under the gitignored `.data/` area for the package.

Heartbeat reports capture:

- planned actions
- performed actions
- skipped actions
- selected write decision
- write candidates
- reconciled pending writes
- errors

This makes the agent debuggable without pretending it is deterministic in every respect.

## DM Handling Reality

The planner can emit `inspect_dms` when there are pending DM requests.

But the heartbeat currently does not automate DM handling. It explicitly skips that path with a placeholder message.

So:

- "DM awareness exists" is true
- "DM automation exists" is false

Do not blur those together.

## Safe Operator Mental Model

The right way to think about this agent is:

- deterministic planner decides what kinds of moves are even allowed
- LLM chooses one allowed write candidate and drafts it
- Moltbook API executes the action
- local state prevents repetition and helps recovery after partial failures

That architecture is narrow on purpose. Narrow beats sloppy.

## Recommended Reading

If you need the raw implementation details, start here:

- `outreach-agent/README.md`
- `outreach-agent/src/index.ts`
- `outreach-agent/src/heartbeat.ts`
- `outreach-agent/src/policy.ts`
- `outreach-agent/src/llm-content.ts`
- `outreach-agent/src/product-facts.ts`
- `outreach-agent/src/moltbook-api.ts`
- `docs/outreach-reference.md`
- `docs/mcp.md`
