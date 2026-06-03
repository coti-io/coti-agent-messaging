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

The package includes `outreach-agent/deploy-rsync.sh`, which deploys a repo subset to the SSH config host `grant`, syncs a local env file, copies `outreach-agent/.browser/reddit-storage-state.json` when present, builds the outreach workspace on the server, and installs a `systemd` timer that runs one heartbeat every 5 minutes.

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
export MOLTBOOK_OUTREACH_DEPLOY_REDDIT_STORAGE_STATE=/absolute/path/to/reddit-storage-state.json
export MOLTBOOK_OUTREACH_DEPLOY_DELETE=1
```

The deployed `systemd` service only needs to pin `MOLTBOOK_STATE_PATH` under `<deploy-path>/.runtime/state.json`. The agent derives the other runtime files from that directory:

- `credentials.json`
- `last-heartbeat.json`
- `prompt-rotation.json`
- `llm-debug/`
- `outreach-attribution.sqlite`
- `heartbeat.lock`

Useful remote checks:

```bash
ssh grant 'sudo systemctl status moltbook-outreach-heartbeat.timer --no-pager'
ssh grant 'sudo systemctl list-timers moltbook-outreach-heartbeat.timer --all'
ssh grant 'sudo systemctl start moltbook-outreach-heartbeat.service'
ssh grant 'sudo journalctl -u moltbook-outreach-heartbeat.service -n 100 --no-pager'
```

## Environment

CLI commands load env from the monorepo root `.env`, then `outreach-agent/.env`, then legacy `moltbook-outreach-agent/.env`, then `process.cwd()/.env` (later files override). That keeps `npm run … -w @coti-agent-messaging/outreach-agent` working when secrets live at the repo root. Set `DOTENV_CONFIG_PATH` to load one file only.

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
# Optional overrides. Defaults derive from MOLTBOOK_STATE_PATH:
# OUTREACH_ATTRIBUTION_DB_PATH=/absolute/path/to/outreach-attribution.sqlite
# OUTREACH_PROMPT_ROTATION_STATE_PATH=/absolute/path/to/prompt-rotation.json
# MOLTBOOK_LLM_DEBUG_DIR=/absolute/path/to/llm-debug
# OUTREACH_RUNTIME_DIR=/absolute/path/to/runtime
OUTREACH_TRACKING_BASE_URL=https://example.com/agent-messaging
OUTREACH_TRACKING_APPROVED_DOMAINS=example.com
```

When `OUTREACH_TRACKING_BASE_URL` is set (default: `https://agents.coti.io/pm`), authored posts/comments/replies can use a tracked URL with `utm_source`, `utm_medium=outreach_agent`, `utm_campaign`, `utm_content`, and `ref`. The durable `ref` maps back to the venue, venue account, surface, prompt profile, full prompt parameters, message style, layout variant, candidate id, and generated content id. By default the outreach agent also writes that ref into `<state-dir>/outreach-attribution.sqlite`, which the grant backend can read and append events to. Link shorteners and unapproved tracking domains are blocked.

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
npm run reddit:login:grant -w @coti-agent-messaging/outreach-agent
npm run reddit:browser-worker -w @coti-agent-messaging/outreach-agent
npm run reddit:browser:install:deps -w @coti-agent-messaging/outreach-agent
npm run reddit:session:dry-run -w @coti-agent-messaging/outreach-agent
npm run reddit:session -w @coti-agent-messaging/outreach-agent
npm run reddit:heartbeat -w @coti-agent-messaging/outreach-agent
npm run reddit:executor -w @coti-agent-messaging/outreach-agent
npm run reddit:docker:build -w @coti-agent-messaging/outreach-agent
npm run reddit:docker:worker -w @coti-agent-messaging/outreach-agent
npm run reddit:docker:session:dry-run -w @coti-agent-messaging/outreach-agent
npm run reddit:docker:session -w @coti-agent-messaging/outreach-agent
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
OUTREACH_REDDIT_CONTROLLER=reddapi # or browser, api, manual
OUTREACH_REDDIT_READ_CONTROLLER=reddapi # or browser, api, auto
OUTREACH_REDDIT_TARGET_SUBREDDITS=sales,SaaS,CustomerSuccess,DigitalMarketing
```

Controller behavior:

- `reddapi` (default): reads threads via ReddAPI scrape/search endpoints and publishes comments through ReddAPI using `token_v2` from `outreach-agent/.browser/reddit-storage-state.json`, `RAPIDAPI_REDDAPI_KEY`, and `REDDAPI_PROXY`
- `manual`: keeps the autonomous scan/draft-only workflow and rejects publish attempts because the controller is configured not to publish
- `api`: submits `create_post`, `comment_on_post`, and `reply_to_comment` through Reddit OAuth using `REDDIT_ACCESS_TOKEN` and `REDDIT_USER_AGENT`
- `browser`: writes publish requests into `outreach-agent/.bridge/reddit-browser/requests` and waits for a matching response file in `responses`; the bundled `reddit-browser-worker` command fulfills those requests through Playwright and returns remote ids/URLs

`reddit-session` remains the convenience single-command loop for local/manual use. For Grant or any anti-bot deployment, use the split runtime instead:

- `reddit-heartbeat`: ingest + decide + queue a delayed write
- `reddit-executor`: execute queued Reddit writes only after `notBefore`

When `OUTREACH_RUNTIME_DIR` is set, the Reddit runtime writes its Grant-friendly artifacts into that directory:

- `state.json`
- `last-heartbeat.json`
- `reddit-memory.json`
- `prompt-rotation.json`

That keeps analytics discovery compatible without faking a Moltbook runtime.

Operating-agent config:

```bash
OUTREACH_REDDIT_READ_CONTROLLER=auto
# Full pool (~50 subs in code when unset); 5 random subs sampled per heartbeat:
OUTREACH_REDDIT_TARGET_SUBREDDITS=AI_Agents,LocalLLaMA,LangChain,mcp,ethdev
OUTREACH_REDDIT_DISCOVERY_SUBS_PER_RUN=5
OUTREACH_REDDIT_SCAN_LEDGER_TTL_HOURS=48
OUTREACH_REDDIT_SEARCH_QUERIES=AI agent messaging,MCP agent communication,private agent channel,agent coordination encrypted,agent to agent messaging,LLM agent inbox
OUTREACH_REDDIT_INGESTION_MAX_SEARCHES_PER_SUBREDDIT=1
OUTREACH_REDDIT_MAX_ACTIONS_PER_SESSION=1
OUTREACH_REDDIT_MAX_ACTIONS_PER_DAY=4
OUTREACH_REDDIT_MIN_JITTER_MINUTES=18
OUTREACH_REDDIT_MAX_JITTER_MINUTES=67
OUTREACH_REDDIT_SESSION_DRY_RUN=true
OUTREACH_REDDIT_MEMORY_PATH=.data/reddit-memory.json
OUTREACH_REDDIT_INGESTION_MAX_DISCOVERY_THREAD_READS=4
```

For Grant, prefer:

```bash
OUTREACH_RUNTIME_DIR=/home/ubuntu/coti-agent-messaging/runtime/reddit-unofficial-api
OUTREACH_REDDIT_CONTROLLER=unofficial
OUTREACH_REDDIT_READ_CONTROLLER=unofficial
OUTREACH_REDDIT_SESSION_DRY_RUN=false
```

Then run the split services instead of `reddit-session`:

```bash
npm run reddit:heartbeat -w @coti-agent-messaging/outreach-agent
npm run reddit:executor -w @coti-agent-messaging/outreach-agent
```

The repo manifest `deploy/agents.json` now includes a dedicated analytics/deploy entry for `reddit-unofficial-api` / `Reddit Outreach`. Deploy that stack with:

```bash
npm run analytics:deploy:rsync
```

Discovery samples **5 random subs per heartbeat** from the configured pool (default ~50 in code). Own-thread participation is always re-checked for new comments/replies.

`reddit-memory.json` now includes a **scan ledger**: seen post/comment IDs are filtered in `snapshotsToSourceItems` before planner gates/LLM, so cold threads are not re-reviewed every run. Cold scrapes are skipped for 48h when comment count is unchanged.

List/search use **weighted random pagination** (page 0 ~55%, page 1 ~30%, page 2 ~15%) on the unofficial reader.

By default the agent also runs **one subreddit search per sampled sub** using agent-messaging queries (`OUTREACH_REDDIT_SEARCH_QUERIES`). Cold discovery threads must match agent/MCP/private-messaging topics **or** reach relevance `>= 6`. Rhetorical title-only questions (e.g. “Anyone else …?”) no longer count as help intent.

**LLM triage + selection (Option B, on by default):** before regex gates, the top `OUTREACH_REDDIT_LLM_TRIAGE_MAX_ITEMS` (default 25) source items per active sub get batch-classified (`worthPublicReply`, topical fit, hostility). Survivors feed `planRedditAction`; when multiple write candidates exist, `OUTREACH_REDDIT_LLM_SELECT=true` asks the LLM to pick one instead of score-only ranking. Disable with `OUTREACH_REDDIT_LLM_TRIAGE=false` / `OUTREACH_REDDIT_LLM_SELECT=false`.

**Upvotes (unofficial controller):** when `OUTREACH_REDDIT_UPVOTE_ENABLED=true` (default), the heartbeat upvotes the selected reply target (`t1_` comment or `t3_` post) before drafting. Deduped via `upvotedThingIds` in `reddit-memory.json`. Probe: `npm run reddit:unofficial:vote-probe -- --post-id POST_ID`.

Duplicate safety: drafts are compared to prior outbound text (including dry-runs) and to other comments on the same ingested thread.

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

`reddit:login:grant` does the same login bootstrap and then immediately syncs the refreshed `reddit-storage-state.json` to `grant`. By default it pushes to both:

- `/home/ubuntu/outreach-agent/outreach-agent/.browser/reddit-storage-state.json`
- `/home/ubuntu/coti-agent-messaging/repo/outreach-agent/.browser/reddit-storage-state.json`

Override those targets with:

```bash
export MOLTBOOK_OUTREACH_REMOTE_REDDIT_STORAGE_STATE_PATH=/custom/remote/path/reddit-storage-state.json
export MOLTBOOK_ANALYTICS_REMOTE_REDDIT_STORAGE_STATE_PATH=/custom/analytics/path/reddit-storage-state.json
```

Reddit blocks headless browser automation ("network security"). Browser login and `reddit:browser-worker` default to a visible Playwright window; set `OUTREACH_REDDIT_BROWSER_HEADLESS=true` or `OUTREACH_REDDIT_BROWSER_LOGIN_HEADLESS=true` only if you explicitly want headless. On WSL, set `DISPLAY=:0` so the browser can open on your Windows desktop.

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

### ReddAPI write probe (RapidAPI)

ReddAPI read endpoints work from anywhere. **Write** endpoints (`/api/comment`) require a publicly reachable HTTP proxy URL in the request body; ReddAPI’s servers connect to that proxy when posting to Reddit.

1. Set `RAPIDAPI_REDDAPI_KEY` in the repo-root `.env`.
2. Bootstrap an authenticated Squid proxy on `grant` (reddit destinations only):

```bash
npm run reddit:reddapi-proxy:grant -w @coti-agent-messaging/outreach-agent
```

Copy the printed `REDDAPI_PROXY=...` line into `.env`.

3. Open inbound **TCP 3128** on the EC2 security group (`launch-wizard-3` on instance `i-0540b41e7bcfe96ce`). Without this, ReddAPI returns `Proxy Connection timed out`.
4. Run the probe (bearer from `.browser/reddit-storage-state.json` unless `REDDAPI_BEARER` is set):

```bash
REDDAPI_POST_URL='https://www.reddit.com/r/.../comments/.../.../' \
REDDAPI_COMMENT_TEXT='[reddapi probe] safe to ignore.' \
npm run reddit:reddapi-probe -w @coti-agent-messaging/outreach-agent
```

3. Only after dry-run output looks sane, try one live action:

```bash
npm run reddit:docker:session -w @coti-agent-messaging/outreach-agent
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
