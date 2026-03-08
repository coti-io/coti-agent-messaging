import "@nomicfoundation/hardhat-toolbox";
import dotenv from "dotenv";
import { HardhatUserConfig } from "hardhat/config";
import path from "node:path";

dotenv.config({
  path: path.resolve(__dirname, "..", ".env")
});

dotenv.config({
  path: path.resolve(__dirname, ".env"),
  override: true
});

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
