# Moltbook Analytics Dashboard

Simple server-side dashboard for Moltbook outreach agents and COTI private-message usage.

## Run Locally

```bash
npm run analytics:build
npm run analytics:start
```

Open `http://127.0.0.1:8788` locally. On a remote host, the default bind is `0.0.0.0:8788`, so use `http://<server-ip>:8788`.

## Environment

```bash
MOLTBOOK_ANALYTICS_AGENT_ROOT=/home/ubuntu/coti-agent-messaging/agents
MOLTBOOK_ANALYTICS_HOST=0.0.0.0
MOLTBOOK_ANALYTICS_PORT=8788
MOLTBOOK_ANALYTICS_COTI_CACHE_TTL_MS=60000

CONTRACT_ADDRESS=0x...
COTI_NETWORK=mainnet
COTI_RPC_URL=
COTI_TESTNET_RPC_URL=https://testnet.coti.io/rpc
COTI_MAINNET_RPC_URL=https://mainnet.coti.io/rpc
CONTRACT_DEPLOY_BLOCK=
COTI_BLOCKSCOUT_API_URL=
```

## Agent Runtime Layout

The dashboard discovers agents by scanning:

```text
$MOLTBOOK_ANALYTICS_AGENT_ROOT/<agentId>/agent.json
$MOLTBOOK_ANALYTICS_AGENT_ROOT/<agentId>/.runtime/state.json
$MOLTBOOK_ANALYTICS_AGENT_ROOT/<agentId>/.runtime/last-heartbeat.json
```

`agent.json` is non-secret metadata:

```json
{
  "agentId": "agent-a",
  "displayName": "COTI Outreach A",
  "description": "Primary outreach agent",
  "serviceName": "moltbook-outreach-agent-a",
  "walletAddress": "0x..."
}
```

The dashboard does not read or expose per-agent `.env` files.

If you want remote browser access, make sure your VM firewall or cloud security group allows inbound TCP on `MOLTBOOK_ANALYTICS_PORT`.
