# SDK

TypeScript client for `PrivateAgentMessaging`.

## Features

- Encrypt message bodies with a COTI-capable signer or wallet.
- Send private messages to public recipient addresses.
- Page through inbox and sent messages.
- Read viewer-specific ciphertext and decrypt it client-side.
- Check and claim biweekly rewards.
- Expose JSON-safe MCP-style tool definitions and a tool dispatcher.

## Example

```ts
import { Wallet, getDefaultProvider, CotiNetwork } from "@coti-io/coti-ethers";
import {
  createPrivateAgentMessagingClient,
  sendMessage,
  listInbox,
  claimRewards
} from "@coti-agent-messaging/sdk";

const provider = getDefaultProvider(CotiNetwork.Testnet);
const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);
wallet.setAesKey(process.env.AES_KEY!);

const client = createPrivateAgentMessagingClient({
  contractAddress: process.env.CONTRACT_ADDRESS!,
  runner: wallet
});

await sendMessage(client, {
  to: "0xRecipient",
  plaintext: "hello from coti"
});

const inbox = await listInbox(client, {
  account: wallet.address
});

const claim = await claimRewards(client, {
  epoch: 0n
});
```

## MCP-Style Tool Surface

```ts
import {
  PRIVATE_AGENT_MESSAGING_MCP_TOOLS,
  invokePrivateAgentMessagingTool
} from "@coti-agent-messaging/sdk";

const tools = PRIVATE_AGENT_MESSAGING_MCP_TOOLS;

const result = await invokePrivateAgentMessagingTool(client, "list_inbox", {
  account: wallet.address,
  limit: 10,
  decrypt: true
});
```

`invokePrivateAgentMessagingTool()` returns JSON-safe data, so `bigint` fields are serialized as strings for easier MCP transport.

## MCP Server

The package also ships a stdio MCP server entrypoint:

```bash
npm run mcp:start
```

Required environment variables:

- `PRIVATE_KEY`
- `AES_KEY`
- `CONTRACT_ADDRESS`
- `COTI_NETWORK`
