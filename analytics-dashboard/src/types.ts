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
  cotiNetwork: "mainnet" | "testnet";
  cotiRpcUrl: string;
  contractAddress?: string;
  contractDeployBlock?: number;
  cotiBlockscoutApiUrl?: string;
  cotiCacheTtlMs: number;
}
