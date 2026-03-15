import "dotenv/config";

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CotiNetwork,
  JsonRpcProvider,
  Wallet,
  getDefaultProvider
} from "@coti-io/coti-ethers";
import { createPrivateAgentMessagingClient } from "@coti-agent-messaging/sdk";

export interface MoltbookStoredCredentials {
  apiKey: string;
  agentName?: string;
  claimUrl?: string;
  verificationCode?: string;
}

export interface RuntimePaths {
  packageRoot: string;
  projectRoot: string;
  credentialsPath: string;
  statePath: string;
}

export interface MoltbookRuntimeConfig extends RuntimePaths {
  moltbookBaseUrl: string;
  defaultSubmolt: string;
  apiKey?: string;
  dryRun: boolean;
  autoVerify: boolean;
  coti?: {
    privateKey: string;
    aesKey: string;
    contractAddress: string;
    network: CotiNetwork;
    rpcUrl?: string;
  };
}

function getPackageRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "..", "..");
}

function resolveHomePath(relativePath: string): string {
  if (relativePath.startsWith("~/")) {
    const homeDir = process.env.HOME;
    if (!homeDir) {
      throw new Error("Cannot resolve '~' because HOME is not set.");
    }

    return path.join(homeDir, relativePath.slice(2));
  }

  return relativePath;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function getRequiredEnv(name: string): string {
  const value = getOptionalEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function resolveNetwork(raw = process.env.COTI_NETWORK): CotiNetwork {
  return (raw ?? "testnet").toLowerCase() === "mainnet"
    ? CotiNetwork.Mainnet
    : CotiNetwork.Testnet;
}

export function resolveRpcUrl(network = resolveNetwork()): string | undefined {
  if (process.env.COTI_RPC_URL) {
    return process.env.COTI_RPC_URL;
  }

  return network === CotiNetwork.Mainnet
    ? process.env.COTI_MAINNET_RPC_URL
    : process.env.COTI_TESTNET_RPC_URL;
}

export function resolvePaths(): RuntimePaths {
  const packageRoot = getPackageRoot();
  const projectRoot = path.resolve(packageRoot, "..");
  const credentialsPath = resolveHomePath(
    process.env.MOLTBOOK_CREDENTIALS_PATH ?? "~/.config/moltbook/credentials.json"
  );
  const statePath = resolveHomePath(
    process.env.MOLTBOOK_STATE_PATH ?? path.join(packageRoot, ".data", "state.json")
  );

  return {
    packageRoot,
    projectRoot,
    credentialsPath,
    statePath
  };
}

export async function loadStoredCredentials(
  credentialsPath: string
): Promise<MoltbookStoredCredentials | undefined> {
  try {
    const raw = await readFile(credentialsPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<MoltbookStoredCredentials>;
    if (!parsed.apiKey) {
      return undefined;
    }

    return {
      apiKey: parsed.apiKey,
      agentName: parsed.agentName,
      claimUrl: parsed.claimUrl,
      verificationCode: parsed.verificationCode
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

export async function saveStoredCredentials(
  credentialsPath: string,
  credentials: MoltbookStoredCredentials
): Promise<void> {
  await mkdir(path.dirname(credentialsPath), { recursive: true });
  const tempPath = `${credentialsPath}.tmp`;
  await writeFile(tempPath, JSON.stringify(credentials, null, 2), "utf8");
  await rename(tempPath, credentialsPath);
}

export async function loadRuntimeConfig(
  options: {
    requireApiKey?: boolean;
    requireCoti?: boolean;
  } = {}
): Promise<MoltbookRuntimeConfig> {
  const paths = resolvePaths();
  const storedCredentials = await loadStoredCredentials(paths.credentialsPath);
  const apiKey = getOptionalEnv("MOLTBOOK_API_KEY") ?? storedCredentials?.apiKey;
  const requireApiKey = options.requireApiKey ?? false;
  const requireCoti = options.requireCoti ?? false;

  if (requireApiKey && !apiKey) {
    throw new Error(
      "Missing Moltbook API key. Set MOLTBOOK_API_KEY or save credentials via the register command."
    );
  }

  const network = resolveNetwork();
  const privateKey = getOptionalEnv("PRIVATE_KEY");
  const aesKey = getOptionalEnv("AES_KEY");
  const contractAddress = getOptionalEnv("CONTRACT_ADDRESS");
  const hasCotiCredentials = Boolean(privateKey && aesKey && contractAddress);

  if (requireCoti && !hasCotiCredentials) {
    throw new Error(
      "Missing COTI credentials. PRIVATE_KEY, AES_KEY, and CONTRACT_ADDRESS are required."
    );
  }

  return {
    ...paths,
    moltbookBaseUrl: process.env.MOLTBOOK_BASE_URL ?? "https://www.moltbook.com/api/v1",
    defaultSubmolt: process.env.MOLTBOOK_DEFAULT_SUBMOLT ?? "general",
    apiKey,
    dryRun: parseBoolean(process.env.MOLTBOOK_DRY_RUN, false),
    autoVerify: parseBoolean(process.env.MOLTBOOK_AUTO_VERIFY, true),
    coti: hasCotiCredentials
      ? {
          privateKey: getRequiredEnv("PRIVATE_KEY"),
          aesKey: getRequiredEnv("AES_KEY"),
          contractAddress: getRequiredEnv("CONTRACT_ADDRESS"),
          network,
          rpcUrl: resolveRpcUrl(network)
        }
      : undefined
  };
}

export function buildPrivateMessagingClient(config: MoltbookRuntimeConfig) {
  if (!config.coti) {
    throw new Error("Cannot build the COTI messaging client without COTI credentials.");
  }

  const provider = config.coti.rpcUrl
    ? new JsonRpcProvider(config.coti.rpcUrl)
    : getDefaultProvider(config.coti.network);
  const wallet = new Wallet(config.coti.privateKey, provider);
  wallet.setAesKey(config.coti.aesKey);

  return createPrivateAgentMessagingClient({
    contractAddress: config.coti.contractAddress,
    runner: wallet
  });
}

