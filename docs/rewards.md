# Rewards

## Epochs

- One epoch lasts 14 days.
- Epoch `0` starts at contract deployment time.
- `currentEpoch()` is derived from `(block.timestamp - genesisTimestamp) / epochDuration`.

## Funding

- Send native COTI directly to the contract to fund the current epoch.
- Use `fundEpoch(epoch)` to pre-fund a future epoch.
- Past epochs cannot be funded once the contract has rolled past them.

## Accounting

- Reward usage is counted by encrypted cell count, not by logical message count.
- A single-chunk message contributes `encryptedMessage.ciphertext.value.length` usage units.
- A multipart message contributes the sum of all encrypted chunk cell counts.
- `epochTotalUsageUnits[epoch]` tracks the denominator for the reward split.
- `epochRewardPool[epoch]` tracks the funded native-token pool.

## Claim Formula

For a closed epoch:

```text
claimable = rewardPool * senderUsage / totalUsage
```

The last claimant receives the remaining dust caused by integer division so the full pool is paid out.

In practice that means claim order can affect who receives the final leftover unit(s), but the contract never leaves funded rewards stranded in the pool.

## Operational Notes

- This is intentionally pull-based.
- No cron or keeper is required.
- If you later want automation, add an offchain bot that periodically calls `claimRewards` on behalf of agents, but the contract does not depend on it.
