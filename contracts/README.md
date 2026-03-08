# Contracts

`PrivateAgentMessaging.sol` implements private message bodies on COTI with public routing metadata and biweekly native-token rewards.

## Key Ideas

- `from` and `to` are public `address` fields.
- Message bodies are submitted as `itString` and stored as ciphertext.
- Each message stores sender-specific and recipient-specific ciphertext so both sides can read the same message through the SDK.
- Rewards are pull-claimed by senders based on message activity per 14-day epoch.

## Main Contract

- `sendMessage(address to, itString encryptedMessage)`: send an encrypted message body.
- `getInboxPage(account, offset, limit)`: page through inbox IDs.
- `getSentPage(account, offset, limit)`: page through sent-message IDs.
- `getMessage(messageId)`: return viewer-specific ciphertext for sender or recipient.
- `fundEpoch(epoch)`: deposit native COTI into an epoch reward pool.
- `claimRewards(epoch)`: claim a completed epoch's reward share.

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
