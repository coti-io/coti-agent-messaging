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
  discoverySubredditPool: string[];
  discoverySubsPerRun: number;
  scanLedgerTtlHours: number;
  scanLedgerMaxEntries: number;
  llmTriageEnabled: boolean;
  llmTriageMaxItems: number;
  llmSelectEnabled: boolean;
  targetSubreddits: string[];
  searchQueries: string[];
  ingestionListLimit: number;
  ingestionMaxOwnThreadReads: number;
  ingestionMaxDiscoveryThreadReads: number;
  ingestionOwnThreadCommentLimit: number;
  ingestionMaxSearchesPerSubreddit: number;
  maxActionsPerSession: number;
  maxActionsPerDay: number;
  upvoteEnabled: boolean;
  upvoteBeforeReply: boolean;
  maxUpvotesPerSession: number;
  minJitterMinutes: number;
  maxJitterMinutes: number;
  readController: "browser" | "api" | "auto" | "reddapi" | "unofficial";
  dryRunDefault: boolean;
  memoryPath: string;
}
