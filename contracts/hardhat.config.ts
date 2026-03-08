import "dotenv/config";
import "@nomicfoundation/hardhat-toolbox";
import { HardhatUserConfig } from "hardhat/config";

const privateKey = process.env.PRIVATE_KEY;

const accounts = privateKey ? [privateKey] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.19",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  },
  networks: {
    cotiTestnet: {
      url: process.env.COTI_TESTNET_RPC_URL ?? "",
      accounts
    },
    cotiMainnet: {
      url: process.env.COTI_MAINNET_RPC_URL ?? "",
      accounts
    }
  }
};

export default config;
