# Deployment

## Environment

Copy `.env.example` to `.env` and fill in:

```bash
PRIVATE_KEY=0x...
AES_KEY=...
CONTRACT_ADDRESS=0x...
COTI_NETWORK=testnet
COTI_TESTNET_RPC_URL=https://your-coti-testnet-rpc
COTI_MAINNET_RPC_URL=https://your-coti-mainnet-rpc
EPOCH_DURATION_SECONDS=1209600
INITIAL_REWARD_FUND_WEI=0
```

## Deploy to Testnet

```bash
npm run deploy:testnet
```

## Deploy to Mainnet

```bash
npm run deploy:mainnet
```

## Notes

- `EPOCH_DURATION_SECONDS` defaults to 14 days if unset.
- `INITIAL_REWARD_FUND_WEI` lets you seed the current epoch during deployment.
- `CONTRACT_ADDRESS` is only needed by the SDK/MCP server after deployment, not by the deploy script itself.
