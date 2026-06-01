import { buildMainLlmProvider, type MoltbookRuntimeConfig } from "./config.js";
import {
  candidateAllowed,
  type ActionBundleDecision,
  type ActionCandidateSource,
  type ConstrainedActionCandidate
} from "./action-planning.js";
import type { RedditPlannerResult, RedditPlannedAction } from "./reddit-policy.js";

interface RedditBundleSelectionResponse {
  selectedCandidateId: string;
  rationale?: string;
}

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

export async function chooseRedditActionBundleWithLlm(input: {
  config: MoltbookRuntimeConfig;
  candidates: readonly ConstrainedActionCandidate[];
  maxActions?: number;
  fetchImpl?: typeof fetch;
}): Promise<ActionBundleDecision> {
  const maxActions = input.maxActions ?? 1;
  const fallback = chooseRedditActionBundle(input.candidates, maxActions);
  const allowed = input.candidates.filter((candidate) => candidateAllowed(candidate));
  if (allowed.length === 0) {
    return fallback;
  }
  if (allowed.length === 1) {
    return chooseRedditActionBundle(allowed, maxActions);
  }

  const llmProvider = buildMainLlmProvider(input.config, input.fetchImpl);
  if (!llmProvider) {
    return fallback;
  }

  try {
    const response = await llmProvider.createJsonCompletion<RedditBundleSelectionResponse>([
      {
        role: "system",
        content: [
          "You choose the single best Reddit outreach action for this heartbeat.",
          "Pick the candidate where a public technical reply adds the most value.",
          "Prefer direct replies to our comments, then own-thread follow-ups, then high-signal discovery threads.",
          "Avoid low-signal, hostile, or off-topic threads.",
          'Return strict JSON: { selectedCandidateId, rationale }. selectedCandidateId must match one candidate id exactly.'
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            candidates: allowed.map((candidate) => ({
              id: candidate.id,
              type: candidate.type,
              source: candidate.source,
              score: candidate.score,
              subreddit: candidate.surface,
              title: candidate.title,
              summary: candidate.summary?.slice(0, 400),
              reason: candidate.reason
            }))
          },
          null,
          2
        )
      }
    ]);

    const selected = allowed.find((candidate) => candidate.id === response.selectedCandidateId);
    if (!selected) {
      return fallback;
    }

    const deferred = allowed
      .map((candidate) => candidate.id)
      .filter((candidateId) => candidateId !== selected.id);
    return {
      selectedCandidateIds: [selected.id],
      selectedWriteCandidateId: selected.id,
      selectedNoContentCandidateIds: [],
      deferredCandidateIds: deferred,
      rationale:
        response.rationale?.trim() ||
        `LLM selected ${selected.type} on r/${selected.surface} as the best reply target.`,
      strategy: "llm"
    };
  } catch {
    return fallback;
  }
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
