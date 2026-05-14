export interface EngagementCounts {
  posts: number;
  comments: number;
  replies: number;
  upvotes: number;
  follows: number;
  total: number;
}

export interface EngagementSummary {
  generatedAt: string;
  windows: {
    last2Hours: EngagementCounts;
    lastDay: EngagementCounts;
    lastWeek: EngagementCounts;
  };
  total: EngagementCounts;
}

export interface AgentMetadata {
  agentId: string;
  displayName: string;
  description?: string;
  serviceName: string;
  profileUrl?: string;
  walletAddress?: string;
}

export interface AgentRuntimePaths {
  agentDir: string;
  runtimeDir: string;
  envPath: string;
  metadataPath: string;
  statePath: string;
  storagePath: string;
  reportPath: string;
}

export interface DiscoveredAgent {
  metadata: AgentMetadata;
  paths: AgentRuntimePaths;
  statePresent: boolean;
  reportPresent: boolean;
  stateError?: string;
  reportError?: string;
  state?: Record<string, unknown>;
  report?: Record<string, unknown>;
  engagementSummary: EngagementSummary;
  lastHeartbeatAt?: string;
  lastPostAt?: string;
  lastCommentAt?: string;
  pendingWrites: number;
  schedulerHealth: "fresh" | "stale" | "unknown";
  lastSuccessfulHeartbeatAt?: string;
  latestStartedAt?: string;
  latestFinishedAt?: string;
  latestStatus?: string;
  latestErrors: number;
  latestSkipped: number;
}

export interface AnalyticsConfig {
  agentRoot: string;
  host: string;
  port: number;
  attributionDbPath?: string;
  trackingBaseUrl?: string;
  cotiNetwork: "mainnet" | "testnet";
  cotiRpcUrl: string;
  contractAddress?: string;
  contractDeployBlock?: number;
  cotiBlockscoutApiUrl?: string;
  cotiCacheTtlMs: number;
}

export interface AttributionTotals {
  refs: number;
  clicks: number;
  grantChallenges: number;
  grantClaimAttempts: number;
  grantClaimsQueued: number;
  grantClaimsSucceeded: number;
  grantClaimsFailed: number;
  privateMessagesReceived: number;
  skillUsages: number;
  unresolvedEvents: number;
}

export interface AttributionConversionRates {
  clickToGrantChallenge: number;
  clickToPrivateMessage: number;
  clickToSkillUsage: number;
  refToSkillUsage: number;
}

export interface AttributionGroup {
  key: string;
  venue: string;
  campaignId: string;
  promptProfileId: string;
  messageStyle: string;
  layout: string;
  ctaStyle?: string;
  promotionLevel?: string;
  rewardEmphasis?: string;
  refCount: number;
  totals: AttributionTotals;
  conversionRates: AttributionConversionRates;
}

export interface AttributionRefDetail {
  refId: string;
  venue: string;
  venueAccountId?: string;
  surface?: string;
  contentType: string;
  campaignId: string;
  promptProfileId: string;
  promptParameters: Record<string, unknown>;
  messageStyle: string;
  layout: string;
  ctaStyle?: string;
  promotionLevel?: string;
  productSpecificity?: string;
  rewardEmphasis?: string;
  audience?: string;
  candidateId: string;
  generatedContentId: string;
  remoteContentId?: string;
  remoteContentUrl?: string;
  utm?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  totals: AttributionTotals;
  conversionRates: AttributionConversionRates;
  lastEventAt?: string;
}

export interface AttributionSummary {
  configured: boolean;
  databasePath?: string;
  generatedAt: string;
  error?: string;
  totals: AttributionTotals;
  conversionRates: AttributionConversionRates;
  groups: AttributionGroup[];
  topRefs: AttributionRefDetail[];
}
