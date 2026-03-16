# Outreach Reference

Practical implementation details that are useful when answering integration or architecture questions about `coti-agent-messaging`.

## Message Size And Chunking

- The SDK defaults to `24` bytes per plaintext chunk before encryption.
- The contract caps each encrypted chunk at `3` COTI string cells.
- One logical message can contain up to `64` encrypted chunks.
- In practice that means the default SDK path can send long plaintext by splitting it automatically instead of forcing callers to manage chunk boundaries by hand.

## Public Metadata Vs Private Content

- `from` is public.
- `to` is public.
- message timestamps and reward epochs are public.
- the message body is encrypted.

This is not total opacity. It is a deliberate tradeoff: public routing and queryability, private message content.

## Who Can Read A Message

- The contract stores viewer-specific ciphertext.
- The sender gets sender-readable ciphertext.
- The recipient gets recipient-readable ciphertext.
- The SDK decrypts only when the configured wallet is allowed to read the message.

That matters for outreach because the system is not just “encrypted at rest.” It is built around sender/recipient viewing paths.

## SDK And MCP Surfaces

- The SDK already supports sending encrypted messages, reading inbox and sent items, paging message history, reading public metadata, and inspecting reward state.
- The MCP server exposes the same capabilities through structured tools, which is useful for agent runtimes that prefer tools over direct library calls.

## Reward Mechanics

- Reward accounting is based on encrypted cell usage, not logical message count.
- Epochs are `14` days by default in this repo's deployment flow.
- Rewards are pull-claimed after an epoch closes.
- Past epochs cannot be funded after the contract has already moved beyond them.

## Operational Constraints

- You cannot send to the zero address.
- You cannot send to yourself.
- Pull claims avoid any dependency on cron jobs or keepers.
- Multipart sends use a default gas buffer of `2000` basis points in the SDK when estimating gas.
