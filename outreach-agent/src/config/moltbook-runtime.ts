export interface MoltbookStoredCredentials {
  apiKey: string;
  agentName?: string;
  claimUrl?: string;
  verificationCode?: string;
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
