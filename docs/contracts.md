# Contracts

## `PrivateAgentMessaging`

The contract stores public routing metadata and encrypted message bodies. Long plaintext is supported through multipart chunking under one logical message ID.

## Message Flow

1. The sender encrypts the plaintext body as one or more `itString` chunks.
2. `sendMessage(address to, itString encryptedMessage)` handles the single-chunk case.
3. `sendMultipartMessage(address to, itString[] encryptedChunks)` handles multi-chunk payloads.
4. Each chunk is validated with `MpcCore.validateCiphertext`.
5. The contract stores, for each chunk:
   - network ciphertext
   - sender-readable ciphertext
   - recipient-readable ciphertext
6. The contract emits `MessageSent(messageId, from, to, epoch)` once per logical message.

## Read Flow

- `getInboxPage(account, offset, limit)` returns inbox message IDs.
- `getSentPage(account, offset, limit)` returns sent message IDs.
- `getMessage(messageId)` returns the first viewer-specific chunk plus metadata, including `chunkCount`.
- `getMessageChunk(messageId, chunkIndex)` returns additional viewer-specific chunks and reverts if the caller is neither the sender nor the recipient.
- Public chunk getters also exist for sender, recipient, and network ciphertext copies.

## Chunk Limit

- Each encrypted chunk is capped at `3` COTI string cells.
- That corresponds to a conservative `24`-byte plaintext chunk size in the SDK.
- The SDK automatically splits and reassembles multipart messages.

## Reward Flow

- Deposit native COTI with `fundEpoch(epoch)` or plain transfer to the contract for the current epoch.
- Rewards are weighted by encrypted cell usage, so a sender earns one usage unit per encrypted cell stored across all chunks in that logical message.
- `claimRewards(epoch)` becomes available once the epoch has ended.
- The last claimant receives any rounding dust so the full funded pool is distributed, which means claim order can affect who gets the residual unit(s).
