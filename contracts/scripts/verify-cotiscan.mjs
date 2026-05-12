import "dotenv/config";

import { createRequire } from "node:module";

import { AbiCoder } from "ethers";

const require = createRequire(import.meta.url);
const {
  PRIVATE_MESSAGING_CONTRACT,
  PRIVATE_MESSAGING_SOURCE,
  buildPrivateMessagingStandardJsonInput,
  loadPrivateMessagingArtifact
} = require("./private-messaging-artifact.cjs");

const DEFAULT_EPOCH_DURATION = 14 * 24 * 60 * 60;

const COTISCAN = {
  testnet: {
    apiUrl: "https://testnet.cotiscan.io/api",
    browserUrl: "https://testnet.cotiscan.io"
  },
  mainnet: {
    apiUrl: "https://mainnet.cotiscan.io/api",
    browserUrl: "https://mainnet.cotiscan.io"
  }
};

function readArg(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) {
    return process.argv[index + 1];
  }

  return undefined;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function requireValue(name, value) {
  if (!value) {
    throw new Error(`Missing ${name}. Pass --${name} or set ${name.toUpperCase()}.`);
  }

  return value;
}

function resolveNetwork() {
  const raw = readArg("network") ?? process.env.COTI_NETWORK ?? "testnet";
  if (raw !== "testnet" && raw !== "mainnet") {
    throw new Error("network must be testnet or mainnet.");
  }
  return raw;
}

function resolveConstructorArgs(epochDurationSeconds) {
  return AbiCoder.defaultAbiCoder()
    .encode(["uint256"], [BigInt(epochDurationSeconds)])
    .replace(/^0x/u, "");
}

function normalizeCompilerVersion(version) {
  const match = version.match(/^(\d+\.\d+\.\d+\+commit\.[0-9a-f]+)(?:\..*)?$/iu);
  return `v${match?.[1] ?? version}`;
}

async function submitVerification(input) {
  const body = new URLSearchParams({
    module: "contract",
    action: "verifysourcecode",
    contractaddress: input.address,
    sourceCode: JSON.stringify(input.standardJsonInput),
    codeformat: "solidity-standard-json-input",
    contractname: `${PRIVATE_MESSAGING_SOURCE}:${PRIVATE_MESSAGING_CONTRACT}`,
    compilerversion: normalizeCompilerVersion(input.compilerVersion),
    optimizationUsed: "1",
    runs: "10000",
    evmversion: "paris",
    licenseType: "3"
  });

  if (input.apiKey) {
    body.set("apikey", input.apiKey);
  }

  const response = await fetch(input.apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`COTIscan verification request failed with HTTP ${response.status}: ${text}`);
  }

  return parsed;
}

async function main() {
  const network = resolveNetwork();
  const address = requireValue(
    "address",
    readArg("address") ?? process.env.PRIVATE_MESSAGING_CONTRACT_ADDRESS
  );
  const epochDurationSeconds = Number(
    readArg("epoch-duration") ??
      process.env.EPOCH_DURATION_SECONDS ??
      DEFAULT_EPOCH_DURATION
  );

  if (!Number.isFinite(epochDurationSeconds) || epochDurationSeconds <= 0) {
    throw new Error("epoch-duration must be a positive integer.");
  }

  const chain = COTISCAN[network];
  const apiUrl =
    readArg("api-url") ??
    process.env.COTISCAN_API_URL ??
    process.env.COTI_BLOCKSCOUT_API_URL ??
    chain.apiUrl;
  const apiKey = readArg("api-key") ?? process.env.COTISCAN_API_KEY;
  const standardJsonInput = await buildPrivateMessagingStandardJsonInput();
  const artifact = await loadPrivateMessagingArtifact();
  const constructorArgs = resolveConstructorArgs(epochDurationSeconds);
  const dryRun = hasFlag("dry-run") || process.env.COTISCAN_DRY_RUN === "1";

  console.log("Submitting PrivateMessaging verification to COTIscan");
  console.log(`network: ${network}`);
  console.log(`address: ${address}`);
  console.log(`compiler: ${normalizeCompilerVersion(artifact.compilerVersion)}`);
  console.log(`constructor epochDurationSeconds: ${epochDurationSeconds}`);
  console.log(`contract URL: ${chain.browserUrl}/address/${address}`);

  if (dryRun) {
    console.log("dry run: verification payload built successfully; not submitting.");
    console.log(`sources: ${Object.keys(standardJsonInput.sources).length}`);
    console.log(`constructor args: ${constructorArgs}`);
    return;
  }

  const result = await submitVerification({
    address,
    apiUrl,
    apiKey,
    compilerVersion: artifact.compilerVersion,
    constructorArgs,
    standardJsonInput
  });

  console.log("verification response:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
