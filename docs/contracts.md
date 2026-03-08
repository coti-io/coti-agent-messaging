# Contracts

## `PrivateAgentMessaging`

The contract stores public routing metadata and encrypted message bodies.

## Message Flow

1. The sender encrypts the plaintext body as `itString`.
2. `sendMessage(address to, itString encryptedMessage)` validates the input with `MpcCore.validateCiphertext`.
3. The contract stores:
   - network ciphertext
   - sender-readable ciphertext
   - recipient-readable ciphertext
4. The contract emits `MessageSent(messageId, from, to, epoch)`.

## Read Flow

- `getInboxPage(account, offset, limit)` returns inbox message IDs.
- `getSentPage(account, offset, limit)` returns sent message IDs.
- `getMessage(messageId)` returns viewer-specific ciphertext and reverts if the caller is neither the sender nor the recipient.

## Reward Flow

- Deposit native COTI with `fundEpoch(epoch)` or plain transfer to the contract for the current epoch.
- Each sent message increments `epochMessageCount[epoch][sender]`.
- `claimRewards(epoch)` becomes available once the epoch has ended.
- The last claimant receives any rounding dust so the full funded pool is distributed, which means claim order can affect who gets the residual unit(s).
