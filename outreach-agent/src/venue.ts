import type { AttributionVenue } from "./outreach-attribution.js";

export type OutreachVenueId = AttributionVenue;
export type OutreachAgentMode = "read_only" | "human_review" | "approved_autopost";

export interface OutreachAgentConfig {
  agentName?: string;
  venue: OutreachVenueId;
  venueAccountId?: string;
  allowedSurfaces: string[];
  mode: OutreachAgentMode;
  policyProfileId?: string;
  promptProfileId?: string;
  attributionCampaignId?: string;
}

export interface VenuePolicy {
  id: string;
  venue: OutreachVenueId;
  mode: OutreachAgentMode;
  allowedSurfaces: string[];
  allowsAutopublish: boolean;
  allowsPrivateMessages: boolean;
  allowsTrackedLinks: boolean;
  firstTouchPromotionAllowed: boolean;
}

export interface VenueCandidate {
  id: string;
  venue: OutreachVenueId;
  surface?: string;
  kind: "post" | "comment" | "reply" | "thread" | "review_item";
  title?: string;
  body?: string;
  author?: string;
  url?: string;
  score?: number;
  raw?: unknown;
}

export interface VenueAction {
  id: string;
  venue: OutreachVenueId;
  type:
    | "create_post"
    | "comment_on_post"
    | "reply_to_comment"
    | "upvote_post"
    | "follow_account"
    | "review_only"
    | "ignore";
  candidateId?: string;
  surface?: string;
  content?: string;
  title?: string;
  parentId?: string;
  raw?: unknown;
}

export interface VenueOutcome {
  id: string;
  venue: OutreachVenueId;
  actionId?: string;
  candidateId?: string;
  type:
    | "drafted"
    | "posted"
    | "clicked"
    | "replied"
    | "private_message_received"
    | "removed"
    | "mod_warning"
    | "spam_accusation"
    | "ignored";
  occurredAt: string;
  raw?: unknown;
}

export interface VenueProvider {
  readonly id: OutreachVenueId;
  readonly mode: OutreachAgentMode;
  readonly policy: VenuePolicy;
  listCandidates(): Promise<VenueCandidate[]>;
  publishAction(action: VenueAction): Promise<VenueOutcome>;
  fetchOutcomes?(): Promise<VenueOutcome[]>;
}

export function assertCanPublish(provider: Pick<VenueProvider, "mode" | "id">): void {
  if (provider.mode !== "approved_autopost") {
    throw new Error(`Venue ${provider.id} is not configured for autopublish.`);
  }
}
