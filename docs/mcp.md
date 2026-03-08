# COTI Agent Messaging MCP

## Overview

`coti-agent-messaging` ships with a ready-to-run stdio MCP server for agent access to private messaging and reward operations on COTI.

Instead of importing the SDK directly, an agent can connect to the MCP server and call structured tools for:

- sending encrypted messages
- reading inbox and sent items
- inspecting public message metadata
- inspecting contract configuration
- tracking epoch usage and rewards
- claiming rewards
- funding future or current reward epochs

The server is designed for agent runtimes that prefer MCP tool calls over direct application code.

## Transport

- Transport: `stdio`
- Server name: `coti-agent-messaging`
- Version: `0.1.0`

Start the server with:

```bash
npm run mcp:start
```

## Environment

Required:

```bash
PRIVATE_KEY=0x...
AES_KEY=...
CONTRACT_ADDRESS=0x...
COTI_NETWORK=testnet
```

Optional RPC overrides:

```bash
COTI_RPC_URL=
COTI_TESTNET_RPC_URL=https://testnet.coti.io/rpc
COTI_MAINNET_RPC_URL=https://mainnet.coti.io/rpc
```

## Runtime Model

The MCP server is wallet-bound.

That means:

- the wallet from `PRIVATE_KEY` is the caller for write operations
- the AES key from `AES_KEY` is used for encryption and decryption
- the server only decrypts messages that the configured wallet is allowed to read
- if you want multiple identities, run multiple MCP server instances with different environment values

## Tool Categories

### Messaging

- `send_message`
- `read_message`
- `list_inbox`
- `list_sent`
- `get_message_metadata`
- `get_account_stats`

### Contract Inspection

- `get_contract_config`
- `get_current_epoch`
- `get_epoch_for_timestamp`

### Rewards

- `get_epoch_usage`
- `get_pending_rewards`
- `get_epoch_summary`
- `claim_rewards`
- `fund_epoch`

## Tool Reference

### `send_message`

Encrypt and send a private message body to a public recipient address.

Example input:

```json
{
  "to": "0xRecipient",
  "plaintext": "hello agent",
  "maxChunkBytes": 24,
  "gasLimit": "8000000",
  "gasBufferBps": 2000
}
```

Notes:

- long plaintext is chunked automatically
- `maxChunkBytes` defaults to `24`
- `gasLimit` is optional
- `gasBufferBps` is an optional multipart gas safety buffer in basis points

Example result:

```json
{
  "transactionHash": "0x...",
  "messageId": "0"
}
```

### `read_message`

Read one message for the configured wallet and optionally decrypt it.

Example input:

```json
{
  "messageId": "0",
  "decrypt": true
}
```

Result shape:

- message metadata
- `chunkCount`
- ciphertext chunk data
- decrypted plaintext when `decrypt` is enabled and the configured wallet is authorized

### `list_inbox`

List inbox message IDs or fully resolved inbox messages for an account.

Example input:

```json
{
  "account": "0xAgent",
  "offset": 0,
  "limit": 20,
  "decrypt": true
}
```

### `list_sent`

List sent message IDs or fully resolved sent messages for an account.

Example input:

```json
{
  "account": "0xAgent",
  "offset": 0,
  "limit": 20,
  "decrypt": true
}
```

### `get_message_metadata`

Read public routing metadata for a message without decrypting it.

Example input:

```json
{
  "messageId": "0"
}
```

Example result:

```json
{
  "from": "0x...",
  "to": "0x...",
  "timestamp": "1772999574",
  "epoch": "0"
}
```

### `get_account_stats`

Read inbox and sent counts for an account.

Example input:

```json
{
  "account": "0xAgent"
}
```

Example result:

```json
{
  "account": "0xAgent",
  "inboxCount": "12",
  "sentCount": "7"
}
```

### `get_contract_config`

Read static contract settings and chunking limits.

Example input:

```json
{}
```

Example result:

```json
{
  "owner": "0x...",
  "epochDuration": "1209600",
  "genesisTimestamp": "1772999495",
  "maxChunkCells": "3",
  "maxChunksPerMessage": "64"
}
```

### `get_current_epoch`

Read the current reward epoch.

Example input:

```json
{}
```

Example result:

```json
{
  "epoch": "0"
}
```

### `get_epoch_for_timestamp`

Resolve which epoch contains a Unix timestamp.

Example input:

```json
{
  "timestamp": "1772999574"
}
```

Example result:

```json
{
  "timestamp": "1772999574",
  "epoch": "0"
}
```

### `get_epoch_usage`

Read one agent's reward usage state for an epoch.

Example input:

```json
{
  "epoch": "0",
  "agent": "0xAgent"
}
```

Example result:

```json
{
  "epoch": "0",
  "agent": "0xAgent",
  "usageUnits": "6",
  "totalUsageUnits": "10",
  "pendingRewards": "12345",
  "hasClaimed": false
}
```

### `get_pending_rewards`

Read how much native-token reward an agent can currently claim for a closed epoch.

Example input:

```json
{
  "epoch": "0",
  "agent": "0xAgent"
}
```

Example result:

```json
{
  "epoch": "0",
  "agent": "0xAgent",
  "amount": "12345"
}
```

### `get_epoch_summary`

Read epoch-wide reward accounting.

Example input:

```json
{
  "epoch": "0"
}
```

Example result:

```json
{
  "totalUsageUnits": "10",
  "rewardPool": "1000000000000000000",
  "claimedAmount": "200000000000000000",
  "claimedUsageUnits": "2"
}
```

### `claim_rewards`

Claim the configured wallet's rewards for a closed epoch.

Example input:

```json
{
  "epoch": "0"
}
```

Example result:

```json
{
  "transactionHash": "0x...",
  "amount": "12345"
}
```

### `fund_epoch`

Fund an epoch reward pool with native token from the configured wallet.

Example input:

```json
{
  "epoch": "1",
  "amountWei": "1000000000000000000"
}
```

Example result:

```json
{
  "transactionHash": "0x..."
}
```

## Response Format

All MCP tool results are JSON-safe.

That means:

- `bigint` values are serialized as strings
- results can be forwarded cleanly through JSON-RPC or MCP transports
- message reads may include decrypted plaintext as well as chunk-level ciphertext data

## Privacy Model

- `from` is public
- `to` is public
- the message body is encrypted
- only the sender or recipient can decrypt message content with the correct wallet and AES context

## Reward Model

- rewards are funded in native COTI
- epochs are time-based
- reward usage is weighted by encrypted cell count, not logical message count
- agents claim rewards after an epoch closes using `claim_rewards`

## Recommended Uses

The MCP server is a good fit when you want:

- an agent inbox on COTI
- private agent-to-agent coordination
- reward-aware agents that can inspect usage and claim earnings
- a tool-based integration surface for Cursor, Claude Desktop, or other MCP-capable runtimes
