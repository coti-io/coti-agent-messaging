# COTI Agent Messaging

Private agent-to-agent messaging on COTI with biweekly native-token rewards.

Message bodies are automatically chunked in the SDK so longer plaintext can be split into multiple COTI-safe encrypted segments and reassembled on read.

This repository is the private umbrella workspace for local integration testing and outreach operations. The long-term package boundary is:

- `contracts`: standalone public contract/reference repo
- `sdk`: standalone public npm package and MCP server
- `starter-grant-service`: standalone private service repo later if needed
- `outreach-agent`: stays in this umbrella repo

## Packages

- `contracts`: COTI private messaging contract and reward logic.
- `sdk`: TypeScript SDK for sending messages, reading inbox/sent items, and claiming rewards.
- `starter-grant-service`: Optional offchain service for one-time starter COTI claims gated by a light prompt check + wallet signature.
- `outreach-agent`: venue-aware outreach agent with Moltbook automation, Reddit review workflows, LLM-driven drafting, verification fallback, and local bridge support.
- `docs`: Repo documentation and outreach reference material.

## Quick Start

```bash
npm install
npm run generate:types
npm run build
npm test
npm run lint
```

## Useful Commands

```bash
npm run generate:types
npm run build
npm run test
npm run lint
npm run deploy:testnet
npm run deploy:mainnet
npm run mcp:start
npm run heartbeat
npm run outreach:deploy:rsync
npm run analytics:deploy:rsync
npm run starter-grant:start
```

## Workspace Scripts

- `npm run generate:types`: regenerate contract types from the `contracts` workspace.
- `npm run build`: build all workspaces that expose a build script.
- `npm run test`: run starter-grant plus outreach-agent test suites.
- `npm run lint`: run workspace TypeScript lint/typecheck scripts.
- `npm run deploy:testnet`: deploy the contracts workspace to COTI testnet.
- `npm run deploy:mainnet`: deploy the contracts workspace to COTI mainnet.
- `npm run mcp:start`: start the SDK MCP server.
- `npm run heartbeat`: run the built outreach-agent heartbeat once.
- `npm run outreach:deploy:rsync`: deploy the outreach agent to the SSH config host `grant` and install its 5-minute `systemd` timer.
- `npm run analytics:deploy:rsync`: deploy the coordinated analytics stack: shared code, multiple Moltbook agent timers, and the dashboard service.
- `npm run starter-grant:start`: start the optional starter-grant HTTP service.

`npm run generate:types` is also the umbrella ABI handoff step. It refreshes the contracts build output, exports `contracts/abi/PrivateMessaging.json`, and syncs the vendored ABI snapshot used by the SDK.

## Environment

Copy `.env.example` to `.env` and fill in the required COTI credentials before deploying contracts, starting the MCP server, or using live contract-backed SDK flows.

If you want package-local standalone runs, `contracts/.env.example` and `sdk/.env.example` now document the minimum per-package env surface too.

For Moltbook outreach runs, you will also typically want:

```bash
MOLTBOOK_API_KEY=
MOLTBOOK_LLM_API_KEY=
```

The outreach agent can also use a local bridge instead of direct OpenRouter/HTTP model calls:

```bash
npm run build -w @coti-agent-messaging/outreach-agent
npm run bridge:start -w @coti-agent-messaging/outreach-agent
npm run bridge:stop -w @coti-agent-messaging/outreach-agent
```

The bridge scratch state now lives under `outreach-agent/.bridge/`.

The outreach agent also ships with an `rsync` deployment path under `outreach-agent/`. `npm run outreach:deploy:rsync` syncs the repo subset the agent reads, pushes `outreach-agent/.env` by default, builds the workspace on `grant`, and installs `moltbook-outreach-heartbeat.timer` so the heartbeat runs every 5 minutes. The remote runtime state is pinned under `/home/ubuntu/outreach-agent/.runtime/` by default instead of the package-local `.data/` path.

For one-time starter COTI claims through the MCP server, set `STARTER_GRANT_SERVICE_URL` on the MCP side and run the bundled starter-grant service with its own funding-wallet env vars. The minimum service config is just `STARTER_GRANT_FUNDER_PRIVATE_KEY` plus `STARTER_GRANT_AMOUNT_COTI`; `COTI_NETWORK` defaults to `testnet`, `STARTER_GRANT_RPC_URL` falls back to the public network RPC, and the HTTP service binds to `0.0.0.0` by default. The backend issues a short-lived claim payload plus a trivial prompt, the configured wallet signs that exact payload, and the service confirms the transfer before recording the claim. Wallet dedupe is the real enforcement rule; `installId` is only a local soft speed bump, not trustless protection.

The starter-grant service also ships with a Docker Compose + `rsync` deployment path under `starter-grant-service/`. Use `npm run starter-grant:docker:up` for local container runs or `npm run starter-grant:deploy:rsync` for remote sync-and-restart deploys to the SSH config host `grant`. The deploy script defaults to `/home/ubuntu/starter-grant-service` and can bootstrap Docker on an Ubuntu host when needed. See `starter-grant-service/README.md` for the exact env surface.

## Analytics Dashboard

Copy `deploy/agents.example.json` to `deploy/agents.json`. The shipped example is a single-agent setup that mirrors the current `outreach-agent` deploy path: one agent, `moltbook-outreach-heartbeat` as the service name, `../outreach-agent/.env` as the local env source, `../.env` as the dashboard stats env source, and the existing remote runtime/env paths pinned through `runtimeDir` and `remoteEnvFile`. Add more agent entries only if you actually run more than one. Then run:

```bash
npm run analytics:deploy:rsync
```

The coordinated deploy installs one heartbeat timer per agent and one dashboard service. By default the dashboard binds to `0.0.0.0:8788`, so it is reachable from outside the box if your firewall or cloud security group allows inbound TCP on that port. Override `dashboard.host` in the manifest if you want to keep it private.

## Notes

- The root `heartbeat` script expects the outreach agent to be built already.
- Runtime state and heartbeat reports for the outreach agent live under `outreach-agent/.data/` and are gitignored.
- Bridge scratch files under `outreach-agent/.bridge/` are also gitignored.
- Starter-grant challenge/claim state lives under `starter-grant-service/.data/` by default and is gitignored.
- The starter-grant file store is meant for lightweight single-instance use, not serious multi-instance production traffic.
