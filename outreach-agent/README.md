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
npm run build -w @coti-agent-messaging/outreach-agent
npm run deploy:rsync -w @coti-agent-messaging/outreach-agent

node outreach-agent/dist/src/index.js register --name YourAgentName --description "What you do"
node outreach-agent/dist/src/index.js status
node outreach-agent/dist/src/index.js engagements
node outreach-agent/dist/src/index.js delete-post --post-id POST_ID
node outreach-agent/dist/src/index.js facts
node outreach-agent/dist/src/index.js venue-config
node outreach-agent/dist/src/index.js reddit-targets
node outreach-agent/dist/src/index.js reddit-scan --input reddit-export.json --output .data/reddit-review-queue.json
node outreach-agent/dist/src/index.js reddit-evaluate --history .data/reddit-outbound-history.json
node outreach-agent/dist/src/index.js attribution-summary --refs .data/outreach-refs.json --events .data/attribution-events.json
node outreach-agent/dist/src/index.js bridge-server
node outreach-agent/dist/src/index.js bridge-stop
node outreach-agent/dist/src/index.js heartbeat
```

## Deploy To `grant`

The package includes `outreach-agent/deploy-rsync.sh`, which deploys a repo subset to the SSH config host `grant`, syncs a local env file, builds the outreach workspace on the server, and installs a `systemd` timer that runs one heartbeat every 5 minutes.

Default remote settings:

- SSH host alias: `grant`
- Deploy path: `/home/ubuntu/outreach-agent`
- Local env file to sync: `.env` at the repo root
- Timer unit: `moltbook-outreach-heartbeat.timer`

The deploy script also installs missing Ubuntu prerequisites when needed:

- `git`
- `nodejs`
- `npm`
- `util-linux` for `flock`

Required remote setup:

- an SSH config entry named `grant`
- passwordless `sudo` for the remote user

Run the deploy:

```bash
npm run deploy:rsync -w @coti-agent-messaging/outreach-agent
```

Optional deploy env vars:

```bash
export MOLTBOOK_OUTREACH_DEPLOY_PATH=/home/ubuntu/outreach-agent
export MOLTBOOK_OUTREACH_DEPLOY_ENV_FILE=/absolute/path/to/outreach-agent.env
export MOLTBOOK_OUTREACH_DEPLOY_DELETE=1
```

The deployed `systemd` service pins stable runtime files under `<deploy-path>/.runtime/`:

- `credentials.json`
- `state.json`
- `last-heartbeat.json`
- `heartbeat.lock`

Useful remote checks:

```bash
ssh grant 'sudo systemctl status moltbook-outreach-heartbeat.timer --no-pager'
ssh grant 'sudo systemctl list-timers moltbook-outreach-heartbeat.timer --all'
ssh grant 'sudo systemctl start moltbook-outreach-heartbeat.service'
ssh grant 'sudo journalctl -u moltbook-outreach-heartbeat.service -n 100 --no-pager'
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
MOLTBOOK_COMMENT_LIMIT_NEW_AGENT_PER_DAY=20
MOLTBOOK_COMMENT_LIMIT_ESTABLISHED_PER_DAY=50
MOLTBOOK_POST_LIMIT_NEW_AGENT_PER_DAY=
MOLTBOOK_POST_LIMIT_ESTABLISHED_PER_DAY=
MOLTBOOK_LLM_API_KEY=
MOLTBOOK_LLM_MODEL=openai/gpt-4o-mini
MOLTBOOK_LLM_BASE_URL=https://openrouter.ai/api/v1
MOLTBOOK_LLM_TIMEOUT_MS=20000
MOLTBOOK_LLM_APP_NAME=outreach-agent
MOLTBOOK_LLM_SITE_URL=
MOLTBOOK_VERIFY_LLM_API_KEY=
MOLTBOOK_VERIFY_LLM_MODEL=openai/gpt-4o-mini
MOLTBOOK_VERIFY_LLM_BASE_URL=https://openrouter.ai/api/v1
MOLTBOOK_VERIFY_LLM_TIMEOUT_MS=20000
```

Optional prompt profile and outreach attribution controls:

```bash
OUTREACH_AGENT_NAME=YourAgentName
OUTREACH_AGENT_VENUE=moltbook
OUTREACH_VENUE_ACCOUNT_ID=YourAgentName
OUTREACH_AGENT_ALLOWED_SURFACES=general
OUTREACH_AGENT_MODE=approved_autopost
OUTREACH_POLICY_PROFILE_ID=moltbook-default
OUTREACH_PROMPT_PROFILE_ID=default-technical-soft-cta
OUTREACH_PROMPT_PROFILE_PATH=/absolute/path/to/prompt-profile.json
OUTREACH_ATTRIBUTION_CAMPAIGN_ID=private_messaging
OUTREACH_ATTRIBUTION_DB_PATH=/absolute/path/to/outreach-attribution.sqlite
OUTREACH_TRACKING_BASE_URL=https://example.com/agent-messaging
OUTREACH_TRACKING_APPROVED_DOMAINS=example.com
```

When `OUTREACH_TRACKING_BASE_URL` is set, authored posts/comments/replies can use a tracked URL with `utm_source`, `utm_medium=outreach_agent`, `utm_campaign`, `utm_content`, and `ref`. The durable `ref` maps back to the venue, venue account, surface, prompt profile, full prompt parameters, message style, layout variant, candidate id, and generated content id. If `OUTREACH_ATTRIBUTION_DB_PATH` is set, the outreach agent also writes that ref into a shared SQLite database that the grant backend can read and append events to. Link shorteners and unapproved tracking domains are blocked.

`OUTREACH_AGENT_VENUE` is the venue provider id. Current values are `moltbook` for the heartbeat writer and `reddit` for the Reddit outreach runtime. Reddit can run in scan/draft-only, API-backed publish, or browser-bridge publish mode depending on controller config.

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
npm run build -w @coti-agent-messaging/outreach-agent
npm run bridge:start -w @coti-agent-messaging/outreach-agent
npm run bridge:stop -w @coti-agent-messaging/outreach-agent
```

Or through the CLI:

```bash
node outreach-agent/dist/src/index.js bridge-server
node outreach-agent/dist/src/index.js bridge-stop
```

The included server writes each request to `requests/<id>.json` inside `MOLTBOOK_LLM_BRIDGE_SERVER_DIR`, waits for a matching `responses/<id>.json`, and returns that JSON as the model result.

By default, the bundled bridge server stores its scratch files under `outreach-agent/.bridge/llm-bridge`.

If Moltbook's verification challenges are too garbled for the deterministic parser, verification now reuses the main LLM config by default. You only need `MOLTBOOK_VERIFY_LLM_*` if you want a separate model, key, or endpoint for captcha solving.

Verification can also use its own bridge endpoint through `MOLTBOOK_VERIFY_LLM_BRIDGE_*`. If omitted, verification falls back to the main injected provider, then the main bridge, then the HTTP/OpenRouter config.

The included bridge server itself is configured with:

```bash
MOLTBOOK_LLM_BRIDGE_SERVER_HOST=127.0.0.1
MOLTBOOK_LLM_BRIDGE_SERVER_PORT=4318
MOLTBOOK_LLM_BRIDGE_SERVER_PATH=/json-completion
MOLTBOOK_LLM_BRIDGE_SERVER_DIR=./outreach-agent/.bridge/llm-bridge
MOLTBOOK_LLM_BRIDGE_SERVER_AUTH_TOKEN=
MOLTBOOK_LLM_BRIDGE_SERVER_RESPONSE_TIMEOUT_MS=300000
MOLTBOOK_LLM_BRIDGE_SERVER_POLL_INTERVAL_MS=500
```

Each heartbeat also writes a JSON report to `MOLTBOOK_HEARTBEAT_REPORT_PATH` or, by default, next to the state file as `last-heartbeat.json`. It includes performed actions, skipped actions, planned actions, write candidates, any reconciled pending writes, the selected write decision, engagement counts, and captured errors.

The state file tracks outbound Moltbook engagement by action type: posts, top-level comments, replies, upvotes, and follows. Use `engagements` to print last 2 hours, last day, last week, and all-time totals. This is local agent activity tracking, not received engagement such as impressions or third-party likes.

The state file also tracks `pendingWrites` for posts/comments/replies that may have landed remotely before a local failure finished. Later heartbeats reconcile those against profile recents, exact post comment trees, and Moltbook search results before planning new authored actions. If a pending write stays unreconciled long enough, it expires instead of blocking that target forever.

### Reddit Outreach Assistant

The Reddit workflow is still an autonomous agent. It monitors approved subreddits, scores relevant threads, keeps the existing non-promotional review queue artifact, and can execute normalized Reddit actions through either an API-backed or browser-bridge controller.

Useful commands:

```bash
npm run build -w @coti-agent-messaging/outreach-agent
npm run reddit:targets -w @coti-agent-messaging/outreach-agent
npm run reddit:scan -w @coti-agent-messaging/outreach-agent -- --input reddit-export.json --output outreach-agent/.data/reddit-review-queue.json
npm run reddit:evaluate -w @coti-agent-messaging/outreach-agent -- --history outreach-agent/.data/reddit-outbound-history.json
npm run reddit:publish -w @coti-agent-messaging/outreach-agent -- --input outreach-agent/.data/reddit-action.json
npm run reddit:login -w @coti-agent-messaging/outreach-agent
npm run reddit:browser-worker -w @coti-agent-messaging/outreach-agent
npm run reddit:browser:install:deps -w @coti-agent-messaging/outreach-agent
npm run reddit:session:dry-run -w @coti-agent-messaging/outreach-agent
npm run reddit:session:local -w @coti-agent-messaging/outreach-agent
npm run reddit:docker:build -w @coti-agent-messaging/outreach-agent
npm run reddit:docker:worker -w @coti-agent-messaging/outreach-agent
npm run reddit:docker:session:dry-run -w @coti-agent-messaging/outreach-agent
npm run reddit:docker:session:local -w @coti-agent-messaging/outreach-agent
```

For live read-only monitoring through Reddit OAuth:

```bash
REDDIT_ACCESS_TOKEN=
REDDIT_USER_AGENT=coti-agent-messaging/0.1.0 by YOUR_REDDIT_USERNAME
REDDIT_BASE_URL=https://oauth.reddit.com
```

Reddit execution is now controller-selected from config:

```bash
OUTREACH_AGENT_VENUE=reddit
OUTREACH_AGENT_MODE=approved_autopost
OUTREACH_AGENT_ALLOWED_SURFACES=AI_Agents,LocalLLaMA
OUTREACH_REDDIT_CONTROLLER=manual # or browser or api
OUTREACH_REDDIT_READ_CONTROLLER=auto # or browser or api
OUTREACH_REDDIT_TARGET_SUBREDDITS=sales,SaaS,CustomerSuccess,DigitalMarketing
```

Controller behavior:

- `manual`: keeps the autonomous scan/draft-only workflow and rejects publish attempts because the controller is configured not to publish
- `api`: submits `create_post`, `comment_on_post`, and `reply_to_comment` through Reddit OAuth using `REDDIT_ACCESS_TOKEN` and `REDDIT_USER_AGENT`
- `browser`: writes publish requests into `outreach-agent/.bridge/reddit-browser/requests` and waits for a matching response file in `responses`; the bundled `reddit-browser-worker` command fulfills those requests through Playwright and returns remote ids/URLs

`reddit-session` is the autonomous operating loop. In dry-run mode it reads Reddit state, ranks candidate comments/posts, drafts a validated zero-marketing reply, writes memory, and prints a decision report without publishing. In local live mode it publishes at most one reply/comment through the selected controller, then records the outcome in `OUTREACH_REDDIT_MEMORY_PATH`.

Operating-agent config:

```bash
OUTREACH_REDDIT_READ_CONTROLLER=auto
OUTREACH_REDDIT_TARGET_SUBREDDITS=sales,SaaS,CustomerSuccess,DigitalMarketing
OUTREACH_REDDIT_SEARCH_QUERIES=CRM messy data,sales handoff broken,manual workflow,customer success workflow,automation failed,duplicate CRM records,SaaS ops process,marketing ops data quality
OUTREACH_REDDIT_MAX_ACTIONS_PER_SESSION=1
OUTREACH_REDDIT_MAX_ACTIONS_PER_DAY=4
OUTREACH_REDDIT_MIN_JITTER_MINUTES=18
OUTREACH_REDDIT_MAX_JITTER_MINUTES=67
OUTREACH_REDDIT_SESSION_DRY_RUN=true
OUTREACH_REDDIT_MEMORY_PATH=.data/reddit-memory.json
```

Browser worker setup:

```bash
npm install -w @coti-agent-messaging/outreach-agent
npx playwright install chromium
OUTREACH_REDDIT_BROWSER_STORAGE_STATE_PATH=.browser/reddit-storage-state.json
npm run reddit:login -w @coti-agent-messaging/outreach-agent
OUTREACH_AGENT_VENUE=reddit
OUTREACH_AGENT_MODE=approved_autopost
OUTREACH_REDDIT_CONTROLLER=browser
OUTREACH_REDDIT_BROWSER_STORAGE_STATE_PATH=.browser/reddit-storage-state.json
npm run reddit:browser-worker -w @coti-agent-messaging/outreach-agent
```

`reddit:login` opens a visible Playwright browser, lets you log in manually, checks `/api/me.json` to confirm the session is authenticated, and saves the Playwright storage state to the configured path. Copy that file to the server if you want the browser worker there to reuse the same session.

Reddit blocks headless browser automation ("network security"). Run the worker with a visible browser (`OUTREACH_REDDIT_BROWSER_HEADLESS=false`, or use `npm run outreach:reddit:browser-worker:local` from the repo root). On WSL, set `DISPLAY=:0` so the browser can open on your Windows desktop.

Comment/reply publish uses `old.reddit.com` forms (reliable) and verifies the comment appears before reporting success.

The worker uses that stored Playwright browser session. If Reddit redirects to login, shows a challenge, or changes the editor UI enough that submission cannot be completed, the worker fails loudly and writes a typed error response instead of trying to sneak around it.

Recommended split for real use:

1. Do the one-time login bootstrap on a host with a working browser:

```bash
npm run reddit:browser:install:deps -w @coti-agent-messaging/outreach-agent
OUTREACH_REDDIT_BROWSER_STORAGE_STATE_PATH=.browser/reddit-storage-state.json \
npm run reddit:login -w @coti-agent-messaging/outreach-agent
```

2. Run the worker and sessions in Docker using that saved session file:

```bash
npm run reddit:docker:build -w @coti-agent-messaging/outreach-agent
npm run reddit:docker:worker -w @coti-agent-messaging/outreach-agent
npm run reddit:docker:session:dry-run -w @coti-agent-messaging/outreach-agent
```

`reddit:docker:build` intentionally builds only the shared `coti-agent-messaging/outreach-agent:local` image once through the `reddit-browser-worker` service. The session services reuse that same image instead of asking Docker to export the same image three times in parallel.

3. Only after dry-run output looks sane, try one live action:

```bash
npm run reddit:docker:session:local -w @coti-agent-messaging/outreach-agent
```

The Docker setup mounts `outreach-agent/.browser`, `outreach-agent/.bridge`, and `outreach-agent/.data` into the container. That means the host-generated Playwright `storageState.json` is reused by the containerized worker without ever putting Reddit credentials into environment variables.

Example `reddit-publish` input:

```json
{
  "id": "reply:thread-1:comment-9",
  "venue": "reddit",
  "type": "reply_to_comment",
  "candidateId": "comment-9",
  "content": "Use a small transport interface and keep policy logic above it."
}
```

Guardrails:

- first replies/comments must not mention COTI, product names, owned links, CTAs, demos, or DM prompts
- product/tool discussion is allowed only after explicit user interest
- every target subreddit must have a registry entry before draft generation
- the review queue remains available as an artifact in `manual` mode, but it is not the definition of the runtime
- daily activity is capped by subreddit and globally
- outcome evaluation triggers kill reasons for bans, repeated mod removals, spam accusations, or first-reply promotion violations

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
npm run test -w @coti-agent-messaging/outreach-agent
```

The tests cover:

- Moltbook auth header behavior and verification solving
- LLM fallback behavior, pending-write reconciliation, and heartbeat orchestration with mocked model responses
- prompt parity between injected and HTTP providers, plus local bridge provider behavior
- policy prioritization and cooldown gating
- product-fact loading from repo docs
