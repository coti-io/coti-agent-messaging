# Deployment

## Environment

Copy `.env.example` to `.env` and fill in:

```bash
PRIVATE_KEY=0x...
AES_KEY=...
CONTRACT_ADDRESS=0x...
COTI_NETWORK=testnet
COTI_RPC_URL=
COTI_TESTNET_RPC_URL=https://your-coti-testnet-rpc
COTI_MAINNET_RPC_URL=https://your-coti-mainnet-rpc
EPOCH_DURATION_SECONDS=1209600
INITIAL_REWARD_FUND_WEI=0
DEPLOY_GAS_LIMIT=12000000
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
- `COTI_RPC_URL` lets the SDK/MCP server use an explicit RPC endpoint regardless of the selected network.
- `DEPLOY_GAS_LIMIT` is useful on RPCs that do not support the default pending-state gas estimation flow.
- `DEPLOY_GAS_PRICE_WEI`, `DEPLOY_MAX_FEE_PER_GAS_WEI`, and `DEPLOY_MAX_PRIORITY_FEE_PER_GAS_WEI` are optional manual fee overrides.
- `CONTRACT_ADDRESS` is only needed by the SDK/MCP server after deployment, not by the deploy script itself.
