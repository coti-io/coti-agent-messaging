import "./load-env.js";

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
import {
  DEFAULT_REDDIT_INGESTION_MAX_DISCOVERY_THREAD_READS,
  DEFAULT_REDDIT_INGESTION_MAX_SEARCHES_PER_SUBREDDIT,
  DEFAULT_REDDIT_OPERATING_SEARCH_QUERIES
} from "./reddit-ingestion.js";
import { getDefaultRedditDiscoverySubredditNames } from "./reddit-outreach.js";
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

export type RedditControllerKind = "manual" | "browser" | "api" | "reddapi" | "unofficial";

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

export interface RedditReddapiRuntimeConfig {
  rapidApiKey?: string;
  proxy?: string;
  storageStatePath: string;
  rapidApiHost: string;
  bearerOverride?: string;
}

export interface RedditUnofficialRuntimeConfig {
  proxy?: string;
  storageStatePath: string;
  bearerOverride?: string;
  publicBaseUrl: string;
  oauthBaseUrl: string;
  userAgent: string;
}

export interface RedditControllerConfig {
  controller: RedditControllerKind;
  browserBridge: RedditBrowserBridgeConfig;
  api: RedditApiRuntimeConfig;
  reddapi: RedditReddapiRuntimeConfig;
  unofficial?: RedditUnofficialRuntimeConfig;
}

export interface RedditOperatingAgentConfig {
  targetSubreddits: string[];
  searchQueries: string[];
  ingestionListLimit: number;
  ingestionMaxOwnThreadReads: number;
  ingestionMaxDiscoveryThreadReads: number;
  ingestionOwnThreadCommentLimit: number;
  ingestionMaxSearchesPerSubreddit: number;
  maxActionsPerSession: number;
  maxActionsPerDay: number;
  minJitterMinutes: number;
  maxJitterMinutes: number;
  readController: "browser" | "api" | "auto" | "reddapi" | "unofficial";
  dryRunDefault: boolean;
  memoryPath: string;
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
  promptRotationStatePath?: string;
  llmDebugDir?: string;
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
  redditOperating?: RedditOperatingAgentConfig;
  coti?: {
    privateKey: string;
    aesKey: string;
    contractAddress: string;
    network: CotiNetwork;
    rpcUrl?: string;
  };
}

function getOutreachAgentRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const srcDir = path.dirname(currentFile);
  if (path.basename(path.dirname(srcDir)) === "dist") {
    return path.resolve(srcDir, "..", "..");
  }
  return path.resolve(srcDir, "..");
}

function getPackageRoot(): string {
  return getOutreachAgentRoot();
}

function resolveHomePath(relativePath: string): string {
  if (relativePath.startsWith("~/")) {
    const homeDir = process.env.HOME;
    if (!homeDir) {
      throw new Error("Cannot resolve '~' because HOME is not set.");
    }

    return path.join(homeDir, relativePath.slice(2));
  }

  if (path.isAbsolute(relativePath)) {
    return relativePath;
  }

  return relativePath;
}

export function resolveRedditMemoryPath(rawPath?: string): string {
  const agentRoot = getOutreachAgentRoot();
  const configured = rawPath?.trim();
  if (!configured) {
    return path.join(agentRoot, ".data", "reddit-memory.json");
  }
  if (path.isAbsolute(configured)) {
    return configured;
  }
  const normalized = configured.replace(/^outreach-agent[/\\]/, "").replace(/^\.\//, "");
  return path.resolve(agentRoot, normalized);
}

function defaultRedditBrowserBridgeDir(packageRoot: string): string {
  return path.join(packageRoot, ".bridge", "reddit-browser");
}

function defaultRedditMemoryPath(packageRoot: string): string {
  return path.join(packageRoot, ".data", "reddit-memory.json");
}

export function resolveRedditBrowserStorageStatePath(rawPath?: string): string {
  const agentRoot = getOutreachAgentRoot();
  const configured = rawPath?.trim();
  if (!configured) {
    return path.join(agentRoot, ".browser", "reddit-storage-state.json");
  }
  if (path.isAbsolute(configured)) {
    return configured;
  }
  const normalized = configured.replace(/^outreach-agent[/\\]/, "");
  return path.resolve(agentRoot, normalized);
}

function defaultPromptRotationStatePath(statePath: string): string {
  return path.join(path.dirname(statePath), "prompt-rotation.json");
}

function defaultLlmDebugDir(statePath: string): string {
  return path.join(path.dirname(statePath), "llm-debug");
}

function defaultAttributionDbPath(statePath: string): string {
  return path.join(path.dirname(statePath), "outreach-attribution.sqlite");
}

function defaultHeartbeatReportPath(statePath: string): string {
  return path.join(path.dirname(statePath), "last-heartbeat.json");
}

function defaultCredentialsPath(statePath: string, packageRoot: string): string {
  const defaultDevStatePath = path.join(packageRoot, ".data", "state.json");
  if (path.resolve(statePath) === path.resolve(defaultDevStatePath)) {
    return "~/.config/moltbook/credentials.json";
  }

  return path.join(path.dirname(statePath), "credentials.json");
}

export function resolveRuntimeDataDir(statePath: string): string {
  return path.dirname(statePath);
}

export {
  defaultAttributionDbPath,
  defaultHeartbeatReportPath,
  defaultLlmDebugDir,
  defaultPromptRotationStatePath
};

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

function parseNonNegativeNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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
  if (value === undefined) {
    return "reddapi";
  }
  if (value === "manual") {
    return "manual";
  }
  if (value === "browser" || value === "api" || value === "reddapi" || value === "unofficial") {
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
  return {
    ...(JSON.parse(raw) as PromptProfile),
    allowVariantOverrides: true
  };
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
  const runtimeDirOverride = getOptionalEnv("OUTREACH_RUNTIME_DIR");
  const defaultStatePath = runtimeDirOverride
    ? path.join(resolveHomePath(runtimeDirOverride), "state.json")
    : path.join(packageRoot, ".data", "state.json");
  const statePath = resolveHomePath(process.env.MOLTBOOK_STATE_PATH ?? defaultStatePath);
  const credentialsPath = resolveHomePath(
    process.env.MOLTBOOK_CREDENTIALS_PATH ?? defaultCredentialsPath(statePath, packageRoot)
  );
  const heartbeatReportPath = resolveHomePath(
    process.env.MOLTBOOK_HEARTBEAT_REPORT_PATH ?? defaultHeartbeatReportPath(statePath)
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
  const redditOperating = buildRedditOperatingAgentConfig(paths.packageRoot);

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
    promptRotationStatePath: resolveHomePath(
      getOptionalEnv("OUTREACH_PROMPT_ROTATION_STATE_PATH") ??
        defaultPromptRotationStatePath(paths.statePath)
    ),
    llmDebugDir: resolveHomePath(
      getOptionalEnv("MOLTBOOK_LLM_DEBUG_DIR") ?? defaultLlmDebugDir(paths.statePath)
    ),
    attributionCampaignId,
    attributionDbPath: resolveHomePath(
      getOptionalEnv("OUTREACH_ATTRIBUTION_DB_PATH") ?? defaultAttributionDbPath(paths.statePath)
    ),
    ctaBaseUrl:
      getOptionalEnv("OUTREACH_TRACKING_BASE_URL") ??
      getOptionalEnv("OUTREACH_CTA_BASE_URL") ??
      "https://agents.coti.io/pm",
    ctaApprovedDomains: (() => {
      const configured = parseCsv(
        process.env.OUTREACH_TRACKING_APPROVED_DOMAINS ??
          process.env.OUTREACH_CTA_APPROVED_DOMAINS
      );
      return configured.length > 0 ? configured : ["agents.coti.io"];
    })(),
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
    redditOperating,
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
    },
    reddapi: {
      rapidApiKey: getOptionalEnv("RAPIDAPI_REDDAPI_KEY"),
      proxy: getOptionalEnv("REDDAPI_PROXY"),
      storageStatePath: resolveRedditBrowserStorageStatePath(
        process.env.OUTREACH_REDDIT_BROWSER_STORAGE_STATE_PATH
      ),
      rapidApiHost: process.env.RAPIDAPI_REDDAPI_HOST?.trim() || "reddapi.p.rapidapi.com",
      bearerOverride: getOptionalEnv("REDDAPI_BEARER")
    },
    unofficial: {
      proxy: getOptionalEnv("OUTREACH_REDDIT_UNOFFICIAL_PROXY") ?? getOptionalEnv("REDDAPI_PROXY"),
      storageStatePath: resolveRedditBrowserStorageStatePath(
        process.env.OUTREACH_REDDIT_BROWSER_STORAGE_STATE_PATH
      ),
      bearerOverride: getOptionalEnv("OUTREACH_REDDIT_UNOFFICIAL_BEARER") ?? getOptionalEnv("REDDAPI_BEARER"),
      publicBaseUrl: process.env.OUTREACH_REDDIT_UNOFFICIAL_PUBLIC_BASE_URL?.trim() || "https://www.reddit.com",
      oauthBaseUrl: process.env.OUTREACH_REDDIT_UNOFFICIAL_OAUTH_BASE_URL?.trim() || "https://oauth.reddit.com",
      userAgent: process.env.OUTREACH_REDDIT_UNOFFICIAL_USER_AGENT?.trim() ||
        "coti-agent-messaging:reddit-unofficial-mvp:0.1"
    }
  };
}

export function getRedditControllerConfig(config: Pick<MoltbookRuntimeConfig, "packageRoot" | "reddit">): RedditControllerConfig {
  return config.reddit ?? buildRedditControllerConfig(config.packageRoot);
}

export function resolveRedditSearchQueries(raw?: string): string[] {
  const configured = parseCsv(raw);
  return configured.length > 0 ? configured : [...DEFAULT_REDDIT_OPERATING_SEARCH_QUERIES];
}

export function buildRedditOperatingAgentConfig(packageRoot: string): RedditOperatingAgentConfig {
  const configuredSubreddits = parseCsv(process.env.OUTREACH_REDDIT_TARGET_SUBREDDITS);
  return {
    targetSubreddits:
      configuredSubreddits.length > 0
        ? configuredSubreddits
        : getDefaultRedditDiscoverySubredditNames(),
    searchQueries: resolveRedditSearchQueries(process.env.OUTREACH_REDDIT_SEARCH_QUERIES),
    ingestionListLimit: parseNumber(process.env.OUTREACH_REDDIT_INGESTION_LIST_LIMIT, 5),
    ingestionMaxOwnThreadReads: parseNonNegativeNumber(
      process.env.OUTREACH_REDDIT_INGESTION_MAX_OWN_THREAD_READS,
      25
    ),
    ingestionMaxDiscoveryThreadReads: parseNumber(
      process.env.OUTREACH_REDDIT_INGESTION_MAX_DISCOVERY_THREAD_READS,
      DEFAULT_REDDIT_INGESTION_MAX_DISCOVERY_THREAD_READS
    ),
    ingestionOwnThreadCommentLimit: parseNumber(
      process.env.OUTREACH_REDDIT_INGESTION_OWN_THREAD_COMMENT_LIMIT,
      100
    ),
    ingestionMaxSearchesPerSubreddit: parseNumber(
      process.env.OUTREACH_REDDIT_INGESTION_MAX_SEARCHES_PER_SUBREDDIT,
      DEFAULT_REDDIT_INGESTION_MAX_SEARCHES_PER_SUBREDDIT
    ),
    maxActionsPerSession: parseNumber(process.env.OUTREACH_REDDIT_MAX_ACTIONS_PER_SESSION, 1),
    maxActionsPerDay: parseNumber(process.env.OUTREACH_REDDIT_MAX_ACTIONS_PER_DAY, 4),
    minJitterMinutes: parseNumber(process.env.OUTREACH_REDDIT_MIN_JITTER_MINUTES, 18),
    maxJitterMinutes: parseNumber(process.env.OUTREACH_REDDIT_MAX_JITTER_MINUTES, 67),
    readController: parseRedditReadController(process.env.OUTREACH_REDDIT_READ_CONTROLLER),
    dryRunDefault: parseBoolean(process.env.OUTREACH_REDDIT_SESSION_DRY_RUN, true),
    memoryPath: resolveRedditMemoryPath(process.env.OUTREACH_REDDIT_MEMORY_PATH)
  };
}

export function getRedditOperatingAgentConfig(
  config: Pick<MoltbookRuntimeConfig, "packageRoot" | "redditOperating">
): RedditOperatingAgentConfig {
  return config.redditOperating ?? buildRedditOperatingAgentConfig(config.packageRoot);
}

function parseRedditReadController(value: string | undefined): RedditOperatingAgentConfig["readController"] {
  if (value === undefined) {
    return "reddapi";
  }
  if (value === "auto") {
    return "auto";
  }
  if (value === "browser" || value === "api" || value === "reddapi" || value === "unofficial") {
    return value;
  }
  throw new Error(`Invalid OUTREACH_REDDIT_READ_CONTROLLER: ${value}`);
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

