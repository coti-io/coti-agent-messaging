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
import { createPrivateMessagingClient } from "@coti-io/coti-sdk-private-messaging";
import {
  createBridgeJsonLlmProvider,
  createHttpJsonLlmProvider,
  type BridgeLlmClientConfig,
  type ChatClientConfig,
  type JsonLlmProvider
} from "./llm-client.js";
import type { PromptProfile } from "./prompt-profile.js";
import type { OutreachAgentConfig, OutreachAgentMode, OutreachVenueId } from "./venue.js";

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
  heartbeatReportPath: string;
  agentId?: string;
}

export interface MoltbookOutreachPolicyConfig {
  commentLimitNewAgentPerDay: number;
  commentLimitEstablishedPerDay: number;
  postLimitNewAgentPerDay?: number;
  postLimitEstablishedPerDay?: number;
  followMinPostScore?: number;
  followMaxPerHeartbeat?: number;
  followFromCommentAuthors?: boolean;
  followCommentMinScore?: number;
}

export type RedditControllerKind = "manual" | "browser" | "api";

export interface RedditBrowserBridgeConfig {
  bridgeDir: string;
  responseTimeoutMs: number;
  pollIntervalMs: number;
}

export interface RedditApiRuntimeConfig {
  accessToken?: string;
  userAgent?: string;
  baseUrl: string;
}

export interface RedditControllerConfig {
  controller: RedditControllerKind;
  browserBridge: RedditBrowserBridgeConfig;
  api: RedditApiRuntimeConfig;
}

export interface MoltbookRuntimeConfig extends RuntimePaths {
  agent?: OutreachAgentConfig;
  moltbookBaseUrl: string;
  defaultSubmolt: string;
  apiKey?: string;
  dryRun: boolean;
  autoVerify: boolean;
  policy?: MoltbookOutreachPolicyConfig;
  forceWriteMode?: "create_post" | "comment_on_post" | "reply_to_activity";
  promptProfileId?: string;
  promptProfile?: PromptProfile;
  attributionCampaignId?: string;
  attributionDbPath?: string;
  ctaBaseUrl?: string;
  ctaApprovedDomains?: string[];
  llm?: ChatClientConfig;
  verificationLlm?: ChatClientConfig;
  llmBridge?: BridgeLlmClientConfig;
  verificationLlmBridge?: BridgeLlmClientConfig;
  llmProvider?: JsonLlmProvider;
  verificationLlmProvider?: JsonLlmProvider;
  reddit?: RedditControllerConfig;
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

function defaultRedditBrowserBridgeDir(packageRoot: string): string {
  return path.join(packageRoot, ".bridge", "reddit-browser");
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseForceWriteMode(
  value: string | undefined
): MoltbookRuntimeConfig["forceWriteMode"] {
  if (
    value === "create_post" ||
    value === "comment_on_post" ||
    value === "reply_to_activity"
  ) {
    return value;
  }

  return undefined;
}

function parseRedditController(value: string | undefined): RedditControllerKind {
  if (value === undefined || value === "manual") {
    return "manual";
  }
  if (value === "browser" || value === "api") {
    return value;
  }

  throw new Error(`Invalid OUTREACH_REDDIT_CONTROLLER: ${value}`);
}

function parseOutreachMode(value: string | undefined, fallback: OutreachAgentMode): OutreachAgentMode {
  if (value === undefined) {
    return fallback;
  }
  if (value === "read_only" || value === "human_review" || value === "approved_autopost") {
    return value;
  }

  throw new Error(`Invalid OUTREACH_AGENT_MODE: ${value}`);
}

function parseOutreachVenue(value: string | undefined, fallback?: OutreachVenueId): OutreachVenueId {
  const venue = value ?? fallback;
  if (!venue) {
    throw new Error("Missing outreach venue. Set OUTREACH_AGENT_VENUE.");
  }
  if (!/^[a-z][a-z0-9_-]{1,40}$/u.test(venue)) {
    throw new Error(`Invalid OUTREACH_AGENT_VENUE: ${venue}`);
  }

  return venue as OutreachVenueId;
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

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function loadPromptProfile(profilePath: string | undefined): Promise<PromptProfile | undefined> {
  if (!profilePath) {
    return undefined;
  }

  const raw = await readFile(resolveHomePath(profilePath), "utf8");
  return JSON.parse(raw) as PromptProfile;
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
  const defaultStatePath = path.join(packageRoot, ".data", "state.json");
  const statePath = resolveHomePath(process.env.MOLTBOOK_STATE_PATH ?? defaultStatePath);
  const heartbeatReportPath = resolveHomePath(
    process.env.MOLTBOOK_HEARTBEAT_REPORT_PATH ??
      path.join(path.dirname(statePath), "last-heartbeat.json")
  );

  return {
    packageRoot,
    projectRoot,
    credentialsPath,
    statePath,
    heartbeatReportPath,
    agentId: getOptionalEnv("MOLTBOOK_AGENT_ID")
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
    requireVenue?: boolean;
  } = {}
): Promise<MoltbookRuntimeConfig> {
  const paths = resolvePaths();
  const storedCredentials = await loadStoredCredentials(paths.credentialsPath);
  const apiKey = getOptionalEnv("MOLTBOOK_API_KEY") ?? storedCredentials?.apiKey;
  const requireApiKey = options.requireApiKey ?? false;
  const requireCoti = options.requireCoti ?? false;
  const venue = parseOutreachVenue(
    getOptionalEnv("OUTREACH_AGENT_VENUE"),
    options.requireVenue ? undefined : "moltbook"
  );
  const allowedSurfaces = parseCsv(process.env.OUTREACH_AGENT_ALLOWED_SURFACES);
  const promptProfileId = getOptionalEnv("OUTREACH_PROMPT_PROFILE_ID");
  const attributionCampaignId = process.env.OUTREACH_ATTRIBUTION_CAMPAIGN_ID ?? "private_messaging";

  if (requireApiKey && !apiKey) {
    throw new Error(
      "Missing Moltbook API key. Set MOLTBOOK_API_KEY or save credentials via the register command."
    );
  }

  const network = resolveNetwork();
  const privateKey = getOptionalEnv("PRIVATE_KEY");
  const aesKey = getOptionalEnv("AES_KEY");
  const contractAddress = getOptionalEnv("CONTRACT_ADDRESS");
  const llmApiKey = getOptionalEnv("MOLTBOOK_LLM_API_KEY") ?? getOptionalEnv("OPENROUTER_API_KEY");
  const hasCotiCredentials = Boolean(privateKey && aesKey && contractAddress);
  const promptProfile = await loadPromptProfile(getOptionalEnv("OUTREACH_PROMPT_PROFILE_PATH"));

  if (requireCoti && !hasCotiCredentials) {
    throw new Error(
      "Missing COTI credentials. PRIVATE_KEY, AES_KEY, and CONTRACT_ADDRESS are required."
    );
  }

  const llm = llmApiKey
    ? {
        apiKey: llmApiKey,
        baseUrl:
          process.env.MOLTBOOK_LLM_BASE_URL ??
          process.env.OPENROUTER_BASE_URL ??
          "https://openrouter.ai/api/v1",
        model:
          process.env.MOLTBOOK_LLM_MODEL ??
          process.env.OPENROUTER_MODEL ??
          "openai/gpt-4o-mini",
        timeoutMs: parseNumber(process.env.MOLTBOOK_LLM_TIMEOUT_MS, 20_000),
        appName: process.env.MOLTBOOK_LLM_APP_NAME ?? "outreach-agent",
        siteUrl: process.env.MOLTBOOK_LLM_SITE_URL
      }
    : undefined;
  const llmBridgeUrl = getOptionalEnv("MOLTBOOK_LLM_BRIDGE_URL");
  const llmBridge = llmBridgeUrl
    ? {
        url: llmBridgeUrl,
        timeoutMs: parseNumber(process.env.MOLTBOOK_LLM_BRIDGE_TIMEOUT_MS, llm?.timeoutMs ?? 20_000),
        label: process.env.MOLTBOOK_LLM_BRIDGE_LABEL ?? "local-bridge",
        authToken: getOptionalEnv("MOLTBOOK_LLM_BRIDGE_AUTH_TOKEN")
      }
    : undefined;
  const verificationLlmApiKey = getOptionalEnv("MOLTBOOK_VERIFY_LLM_API_KEY") ?? llm?.apiKey;
  const verificationLlmBridgeUrl = getOptionalEnv("MOLTBOOK_VERIFY_LLM_BRIDGE_URL") ?? llmBridge?.url;
  const reddit = buildRedditControllerConfig(paths.packageRoot);

  return {
    ...paths,
    agent: {
      agentName: getOptionalEnv("OUTREACH_AGENT_NAME") ?? storedCredentials?.agentName,
      venue,
      venueAccountId: getOptionalEnv("OUTREACH_VENUE_ACCOUNT_ID") ?? paths.agentId ?? storedCredentials?.agentName,
      allowedSurfaces:
        allowedSurfaces.length > 0
          ? allowedSurfaces
          : venue === "moltbook"
            ? [process.env.MOLTBOOK_DEFAULT_SUBMOLT ?? "general"]
            : [],
      mode: parseOutreachMode(
        process.env.OUTREACH_AGENT_MODE,
        venue === "reddit" ? "human_review" : "approved_autopost"
      ),
      policyProfileId: getOptionalEnv("OUTREACH_POLICY_PROFILE_ID"),
      promptProfileId,
      attributionCampaignId
    },
    moltbookBaseUrl: process.env.MOLTBOOK_BASE_URL ?? "https://www.moltbook.com/api/v1",
    defaultSubmolt: process.env.MOLTBOOK_DEFAULT_SUBMOLT ?? "general",
    apiKey,
    dryRun: parseBoolean(process.env.MOLTBOOK_DRY_RUN, false),
    autoVerify: parseBoolean(process.env.MOLTBOOK_AUTO_VERIFY, true),
    policy: {
      commentLimitNewAgentPerDay: parseNumber(
        process.env.MOLTBOOK_COMMENT_LIMIT_NEW_AGENT_PER_DAY,
        20
      ),
      commentLimitEstablishedPerDay: parseNumber(
        process.env.MOLTBOOK_COMMENT_LIMIT_ESTABLISHED_PER_DAY,
        50
      ),
      postLimitNewAgentPerDay: parseOptionalNumber(process.env.MOLTBOOK_POST_LIMIT_NEW_AGENT_PER_DAY),
      postLimitEstablishedPerDay: parseOptionalNumber(
        process.env.MOLTBOOK_POST_LIMIT_ESTABLISHED_PER_DAY
      ),
      followMinPostScore: parseOptionalNumber(process.env.MOLTBOOK_FOLLOW_MIN_POST_SCORE),
      followMaxPerHeartbeat: parseOptionalNumber(process.env.MOLTBOOK_FOLLOW_MAX_PER_HEARTBEAT),
      followFromCommentAuthors: process.env.MOLTBOOK_FOLLOW_FROM_COMMENT_AUTHORS === undefined
        ? undefined
        : parseBoolean(process.env.MOLTBOOK_FOLLOW_FROM_COMMENT_AUTHORS, true),
      followCommentMinScore: parseOptionalNumber(process.env.MOLTBOOK_FOLLOW_COMMENT_MIN_SCORE)
    },
    forceWriteMode: parseForceWriteMode(process.env.MOLTBOOK_FORCE_WRITE_MODE),
    promptProfileId,
    promptProfile,
    attributionCampaignId,
    attributionDbPath: getOptionalEnv("OUTREACH_ATTRIBUTION_DB_PATH"),
    ctaBaseUrl:
      getOptionalEnv("OUTREACH_TRACKING_BASE_URL") ?? getOptionalEnv("OUTREACH_CTA_BASE_URL"),
    ctaApprovedDomains: parseCsv(
      process.env.OUTREACH_TRACKING_APPROVED_DOMAINS ??
        process.env.OUTREACH_CTA_APPROVED_DOMAINS
    ),
    llm,
    llmBridge,
    verificationLlm: verificationLlmApiKey
      ? {
          apiKey: verificationLlmApiKey,
          baseUrl:
            process.env.MOLTBOOK_VERIFY_LLM_BASE_URL ??
            llm?.baseUrl ??
            "https://openrouter.ai/api/v1",
          model:
            process.env.MOLTBOOK_VERIFY_LLM_MODEL ??
            llm?.model ??
            "openai/gpt-4o-mini",
          timeoutMs: parseNumber(
            process.env.MOLTBOOK_VERIFY_LLM_TIMEOUT_MS,
            llm?.timeoutMs ?? 10_000
          )
        }
      : undefined,
    verificationLlmBridge: verificationLlmBridgeUrl
      ? {
          url: verificationLlmBridgeUrl,
          timeoutMs: parseNumber(
            process.env.MOLTBOOK_VERIFY_LLM_BRIDGE_TIMEOUT_MS,
            llmBridge?.timeoutMs ?? llm?.timeoutMs ?? 10_000
          ),
          label:
            process.env.MOLTBOOK_VERIFY_LLM_BRIDGE_LABEL ??
            llmBridge?.label ??
            "local-bridge",
          authToken:
            getOptionalEnv("MOLTBOOK_VERIFY_LLM_BRIDGE_AUTH_TOKEN") ?? llmBridge?.authToken
        }
      : undefined,
    reddit,
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

export function buildRedditControllerConfig(packageRoot: string): RedditControllerConfig {
  return {
    controller: parseRedditController(getOptionalEnv("OUTREACH_REDDIT_CONTROLLER")),
    browserBridge: {
      bridgeDir: resolveHomePath(
        process.env.OUTREACH_REDDIT_BROWSER_BRIDGE_DIR ?? defaultRedditBrowserBridgeDir(packageRoot)
      ),
      responseTimeoutMs: parseNumber(process.env.OUTREACH_REDDIT_BROWSER_RESPONSE_TIMEOUT_MS, 300_000),
      pollIntervalMs: parseNumber(process.env.OUTREACH_REDDIT_BROWSER_POLL_INTERVAL_MS, 500)
    },
    api: {
      accessToken: getOptionalEnv("REDDIT_ACCESS_TOKEN"),
      userAgent: getOptionalEnv("REDDIT_USER_AGENT"),
      baseUrl: process.env.REDDIT_BASE_URL ?? "https://oauth.reddit.com"
    }
  };
}

export function getRedditControllerConfig(config: Pick<MoltbookRuntimeConfig, "packageRoot" | "reddit">): RedditControllerConfig {
  return config.reddit ?? buildRedditControllerConfig(config.packageRoot);
}

export function getOutreachAgentConfig(config: MoltbookRuntimeConfig): OutreachAgentConfig {
  return config.agent ?? {
    agentName: config.agentId,
    venue: "moltbook",
    venueAccountId: config.agentId,
    allowedSurfaces: [config.defaultSubmolt],
    mode: "approved_autopost",
    promptProfileId: config.promptProfileId,
    attributionCampaignId: config.attributionCampaignId
  };
}

export function buildMainLlmProvider(
  config: MoltbookRuntimeConfig,
  fetchImpl?: typeof fetch
): JsonLlmProvider | undefined {
  if (config.llmProvider) {
    return config.llmProvider;
  }

  if (config.llmBridge) {
    return createBridgeJsonLlmProvider(config.llmBridge, fetchImpl);
  }

  if (config.llm) {
    return createHttpJsonLlmProvider(config.llm, fetchImpl);
  }

  return undefined;
}

export function buildVerificationLlmProvider(
  config: MoltbookRuntimeConfig,
  fetchImpl?: typeof fetch
): JsonLlmProvider | undefined {
  if (config.verificationLlmProvider) {
    return config.verificationLlmProvider;
  }

  if (config.llmProvider) {
    return config.llmProvider;
  }

  if (config.verificationLlmBridge) {
    return createBridgeJsonLlmProvider(config.verificationLlmBridge, fetchImpl);
  }

  if (config.llmBridge) {
    return createBridgeJsonLlmProvider(config.llmBridge, fetchImpl);
  }

  if (config.verificationLlm) {
    return createHttpJsonLlmProvider(config.verificationLlm, fetchImpl);
  }

  if (config.llm) {
    return createHttpJsonLlmProvider(config.llm, fetchImpl);
  }

  return undefined;
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

  return createPrivateMessagingClient({
    contractAddress: config.coti.contractAddress,
    runner: wallet
  });
}

