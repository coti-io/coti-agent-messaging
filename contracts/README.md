# Contracts

`PrivateAgentMessaging.sol` implements private message bodies on COTI with public routing metadata and biweekly native-token rewards.

## Key Ideas

- `from` and `to` are public `address` fields.
- Message bodies are submitted as `itString` and stored as ciphertext.
- Long messages can be stored as multiple encrypted chunks under one logical message ID.
- Each message stores sender-specific and recipient-specific ciphertext so both sides can read the same message through the SDK.
- Rewards are pull-claimed by senders based on message activity per 14-day epoch.

## Main Contract

- `sendMessage(address to, itString encryptedMessage)`: send an encrypted message body.
- `sendMultipartMessage(address to, itString[] encryptedChunks)`: send one logical message split across multiple encrypted chunks.
- `getInboxPage(account, offset, limit)`: page through inbox IDs.
- `getSentPage(account, offset, limit)`: page through sent-message IDs.
- `getMessage(messageId)`: return the first viewer-specific chunk plus metadata, including total chunk count.
- `getMessageChunk(messageId, chunkIndex)`: return an additional viewer-specific chunk.
- `fundEpoch(epoch)`: deposit native COTI into an epoch reward pool.
- `claimRewards(epoch)`: claim a completed epoch's reward share.

## Chunking Limit

Each encrypted chunk is capped at `3` COTI string cells (`24` bytes). The SDK automatically splits longer plaintext into multipart messages so callers do not need to manage chunk boundaries manually.

## Testing Note

`PrivateAgentMessagingHarness.sol` exists only to unit-test reward and pagination behavior without depending on the full COTI private-input runtime in every test.

## Deployment

Set the root `.env` file, then run:

```bash
npm run deploy:testnet
```

Relevant variables:

- `PRIVATE_KEY`
- `COTI_TESTNET_RPC_URL`
- `COTI_MAINNET_RPC_URL`
- `EPOCH_DURATION_SECONDS`
- `INITIAL_REWARD_FUND_WEI`
