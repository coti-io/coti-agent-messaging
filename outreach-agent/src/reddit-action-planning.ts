import {
  candidateAllowed,
  type ActionBundleDecision,
  type ActionCandidateSource,
  type ConstrainedActionCandidate
} from "./action-planning.js";
import type { RedditPlannerResult, RedditPlannedAction } from "./reddit-policy.js";

export function buildRedditActionCandidates(
  planner: RedditPlannerResult
): ConstrainedActionCandidate[] {
  return planner.plannedCandidates.map((planned) => {
    const constraints = planned.item.gates.map((gate) => ({
      id: gate.id,
      passed: gate.passed,
      severity: gate.severity,
      reason: gate.reason
    }));
    return {
      id: planned.item.id,
      venue: "reddit",
      type: planned.type === "reply_to_comment" ? "reply_to_activity" : "comment_on_post",
      source: inferRedditCandidateSource(planned),
      score: planned.score,
      needsContent: true,
      reason: planned.reason,
      surface: planned.item.source.subreddit,
      targetId: planned.item.source.id,
      title: planned.item.source.title,
      summary: planned.item.source.body,
      raw: planned,
      constraints,
      allowed: constraints.every((constraint) => constraint.passed || constraint.severity !== "block")
    };
  });
}

export function chooseRedditActionBundle(
  candidates: readonly ConstrainedActionCandidate[],
  maxActions = 1
): ActionBundleDecision {
  const allowed = candidates
    .filter((candidate) => candidateAllowed(candidate))
    .sort((left, right) => right.score - left.score);
  const selected = allowed.slice(0, Math.max(0, Math.min(1, maxActions)));
  return {
    selectedCandidateIds: selected.map((candidate) => candidate.id),
    selectedWriteCandidateId: selected[0]?.id,
    selectedNoContentCandidateIds: [],
    deferredCandidateIds: allowed
      .map((candidate) => candidate.id)
      .filter((candidateId) => !selected.some((candidate) => candidate.id === candidateId)),
    rationale: selected[0]
      ? `Selected ${selected[0].type} from ${selected[0].source} as the single safe Reddit action for this run.`
      : "No legal Reddit action candidate survived filtering.",
    strategy: "deterministic_fallback"
  };
}

export function plannedRedditActionFromCandidate(
  candidate: ConstrainedActionCandidate
): RedditPlannedAction {
  return candidate.raw as RedditPlannedAction;
}

function inferRedditCandidateSource(planned: RedditPlannedAction): ActionCandidateSource {
  const source = planned.item.source;
  if (source.onOwnThread) {
    return source.kind === "comment" ? "own_thread" : "activity_reply";
  }
  if (source.kind === "comment") {
    return (source.commentCount ?? 0) >= 10 || (source.score ?? 0) >= 8 ? "hot_thread" : "explore_feed";
  }
  return (source.commentCount ?? 0) >= 10 || (source.score ?? 0) >= 8 ? "hot_thread" : "explore_feed";
}
