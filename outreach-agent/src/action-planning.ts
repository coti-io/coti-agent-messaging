import type { VenueAction } from "./venue.js";

export type ActionCandidateType =
  | "create_post"
  | "comment_on_post"
  | "reply_to_activity"
  | "upvote_post"
  | "follow_agent"
  | "inspect_dms"
  | "noop";

export type ActionCandidateSource =
  | "activity_reply"
  | "own_thread"
  | "hot_thread"
  | "following_feed"
  | "explore_feed"
  | "dm_queue"
  | "cold_start";

export interface ActionConstraint {
  id: string;
  passed: boolean;
  severity: "info" | "warning" | "block";
  reason: string;
}

export interface ActionCandidate {
  id: string;
  venue: VenueAction["venue"];
  type: ActionCandidateType;
  source: ActionCandidateSource;
  score: number;
  needsContent: boolean;
  reason: string;
  surface?: string;
  targetId?: string;
  title?: string;
  summary?: string;
  raw?: unknown;
}

export interface ConstrainedActionCandidate extends ActionCandidate {
  constraints: ActionConstraint[];
  allowed: boolean;
}

export interface ActionBundleDecision {
  selectedCandidateIds: string[];
  selectedWriteCandidateId?: string;
  selectedNoContentCandidateIds: string[];
  deferredCandidateIds: string[];
  rationale: string;
  strategy?: "llm" | "deterministic_fallback";
  debugInputPath?: string;
}

export interface ActionJob {
  id: string;
  venue: VenueAction["venue"];
  actionId: string;
  candidateId: string;
  type: VenueAction["type"];
  payload: VenueAction;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  createdAt: string;
  notBefore: string;
  attempts: number;
  sourceDecisionId: string;
  lastError?: string;
}

export function candidateAllowed(candidate: ConstrainedActionCandidate): boolean {
  return candidate.allowed && !candidate.constraints.some((constraint) => constraint.severity === "block" && !constraint.passed);
}

export function createActionJob(input: {
  action: VenueAction;
  candidateId: string;
  sourceDecisionId: string;
  notBefore: string;
}): ActionJob {
  return {
    id: `${input.action.id}:${input.sourceDecisionId}`,
    venue: input.action.venue,
    actionId: input.action.id,
    candidateId: input.candidateId,
    type: input.action.type,
    payload: input.action,
    status: "queued",
    createdAt: new Date().toISOString(),
    notBefore: input.notBefore,
    attempts: 0,
    sourceDecisionId: input.sourceDecisionId
  };
}

export function computeActionJobNotBefore(input: {
  now: Date;
  order: number;
  needsContent: boolean;
  rng?: () => number;
}): string {
  const rng = input.rng ?? Math.random;
  const minMs = input.needsContent ? 5 * 60_000 : 30_000;
  const maxMs = input.needsContent ? 30 * 60_000 : 3 * 60_000;
  const orderSpacingMs = input.order * (input.needsContent ? 90_000 : 15_000);
  const jitterMs = Math.floor(minMs + (maxMs - minMs) * Math.min(0.999, Math.max(0, rng())));
  return new Date(input.now.getTime() + orderSpacingMs + jitterMs).toISOString();
}
