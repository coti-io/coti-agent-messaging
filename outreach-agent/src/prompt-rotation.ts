import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { readAttributionSummaryFromStore } from "./attribution-store.js";
import { buildMainLlmProvider, type MoltbookRuntimeConfig } from "./config.js";
import {
  buildSafePromptVariantCandidates,
  type PromptParameterSet,
  type PromptVariantCandidate,
  type OutreachActionType,
  type OutreachVenue
} from "./prompt-profile.js";

export interface PromptRotationHistoryEntry {
  id: string;
  venue: OutreachVenue;
  actionType: OutreachActionType;
  createdAt: string;
  status?: string;
  promptProfileId?: string;
  promptVariantId?: string;
  promptVariantLabel?: string;
  promptParameters?: Partial<PromptParameterSet>;
  layout?: PromptParameterSet["layout"];
  messageStyle?: PromptParameterSet["messageStyle"];
  technicalDepth?: PromptParameterSet["technicalDepth"];
  tone?: PromptParameterSet["tone"];
  creativity?: PromptParameterSet["creativity"];
  clickCount?: number;
  privateMessageCount?: number;
}

export interface PromptRotationState {
  currentPromptVariant?: string;
  actionsSinceRotation: number;
  rotateAfterActions: number;
  lastRotationAt?: string;
  lastSelectionRationale?: string;
}

export interface PromptRotationStore {
  generatedAt: string;
  state: PromptRotationState;
  history: PromptRotationHistoryEntry[];
}

export interface SelectedPromptVariant {
  variantId: string;
  label: string;
  parameterOverrides: Partial<PromptParameterSet>;
  rationale: string;
  actionsSinceRotation: number;
  rotateAfterActions: number;
  reusedExisting: boolean;
}

interface PromptVariantSelectionResponse {
  selectedVariantId?: string;
  rationale?: string;
}

const MAX_PROMPT_ROTATION_HISTORY = 500;
const MIN_ROTATION_WINDOW = 10;
const MAX_ROTATION_WINDOW = 20;

export function defaultPromptRotationStatePath(packageRoot: string): string {
  return path.join(packageRoot, ".data", "prompt-rotation.json");
}

export async function loadPromptRotationStore(filePath: string): Promise<PromptRotationStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PromptRotationStore>;
    return {
      generatedAt: parsed.generatedAt ?? new Date().toISOString(),
      state: normalizeRotationState(parsed.state),
      history: Array.isArray(parsed.history) ? parsed.history : []
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        generatedAt: new Date().toISOString(),
        state: normalizeRotationState(undefined),
        history: []
      };
    }
    throw error;
  }
}

export async function savePromptRotationStore(
  filePath: string,
  store: PromptRotationStore
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(
    tempPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        state: normalizeRotationState(store.state),
        history: store.history.slice(-MAX_PROMPT_ROTATION_HISTORY)
      },
      null,
      2
    ),
    "utf8"
  );
  await rename(tempPath, filePath);
}

export async function selectPromptVariant(input: {
  config: MoltbookRuntimeConfig;
  venue: OutreachVenue;
  actionType: OutreachActionType;
  fetchImpl?: typeof fetch;
  rng?: () => number;
}): Promise<SelectedPromptVariant> {
  const statePath = input.config.promptRotationStatePath ?? defaultPromptRotationStatePath(input.config.packageRoot);
  const store = await loadPromptRotationStore(statePath);
  const candidates = buildSafePromptVariantCandidates({
    venue: input.venue,
    actionType: input.actionType
  });
  const currentCandidate = candidates.find((candidate) => candidate.id === store.state.currentPromptVariant);
  const shouldRotate = !currentCandidate || store.state.actionsSinceRotation >= store.state.rotateAfterActions;
  if (!shouldRotate && currentCandidate) {
    return {
      variantId: currentCandidate.id,
      label: currentCandidate.label,
      parameterOverrides: currentCandidate.parameters,
      rationale: store.state.lastSelectionRationale ?? "Reusing the current prompt variant until the rotation window is met.",
      actionsSinceRotation: store.state.actionsSinceRotation,
      rotateAfterActions: store.state.rotateAfterActions,
      reusedExisting: true
    };
  }

  const selected = await chooseNextVariant({
    config: input.config,
    venue: input.venue,
    actionType: input.actionType,
    history: store.history,
    candidates,
    fetchImpl: input.fetchImpl
  });
  const nextState: PromptRotationState = {
    currentPromptVariant: selected.id,
    actionsSinceRotation: 0,
    rotateAfterActions: chooseRotationWindow(input.rng ?? Math.random),
    lastRotationAt: new Date().toISOString(),
    lastSelectionRationale: selected.rationale
  };
  return {
    variantId: selected.id,
    label: selected.label,
    parameterOverrides: selected.parameters,
    rationale: selected.rationale,
    actionsSinceRotation: nextState.actionsSinceRotation,
    rotateAfterActions: nextState.rotateAfterActions,
    reusedExisting: false
  };
}

export async function recordPromptRotationAction(input: {
  config: MoltbookRuntimeConfig;
  entry: PromptRotationHistoryEntry;
  selection?: Pick<SelectedPromptVariant, "variantId" | "rationale" | "rotateAfterActions" | "reusedExisting">;
  rng?: () => number;
}): Promise<void> {
  const statePath = input.config.promptRotationStatePath ?? defaultPromptRotationStatePath(input.config.packageRoot);
  const store = await loadPromptRotationStore(statePath);
  const nextHistory = [
    ...store.history.filter((entry) => entry.id !== input.entry.id),
    input.entry
  ].slice(-MAX_PROMPT_ROTATION_HISTORY);
  const selection = input.selection;
  const isRotation = Boolean(selection && !selection.reusedExisting);
  const nextState = normalizeRotationState(
    isRotation
      ? {
          currentPromptVariant: input.entry.promptVariantId ?? selection?.variantId ?? store.state.currentPromptVariant,
          actionsSinceRotation: 1,
          rotateAfterActions: selection?.rotateAfterActions ?? chooseRotationWindow(input.rng ?? Math.random),
          lastRotationAt: new Date().toISOString(),
          lastSelectionRationale: selection?.rationale ?? store.state.lastSelectionRationale
        }
      : {
          ...store.state,
          currentPromptVariant: input.entry.promptVariantId ?? store.state.currentPromptVariant,
          actionsSinceRotation: store.state.actionsSinceRotation + 1,
          lastSelectionRationale: selection?.rationale ?? store.state.lastSelectionRationale
        }
  );
  await savePromptRotationStore(statePath, {
    generatedAt: new Date().toISOString(),
    state: nextState,
    history: nextHistory
  });
}

export function chooseRotationWindow(rng: () => number): number {
  return MIN_ROTATION_WINDOW + Math.floor(Math.min(0.999, Math.max(0, rng())) * (MAX_ROTATION_WINDOW - MIN_ROTATION_WINDOW + 1));
}

function normalizeRotationState(state: Partial<PromptRotationState> | undefined): PromptRotationState {
  return {
    currentPromptVariant: state?.currentPromptVariant,
    actionsSinceRotation: Math.max(0, state?.actionsSinceRotation ?? 0),
    rotateAfterActions: clampRotationWindow(state?.rotateAfterActions),
    lastRotationAt: state?.lastRotationAt,
    lastSelectionRationale: state?.lastSelectionRationale
  };
}

function clampRotationWindow(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return MIN_ROTATION_WINDOW;
  }
  return Math.min(MAX_ROTATION_WINDOW, Math.max(MIN_ROTATION_WINDOW, Math.floor(value)));
}

async function chooseNextVariant(input: {
  config: MoltbookRuntimeConfig;
  venue: OutreachVenue;
  actionType: OutreachActionType;
  history: readonly PromptRotationHistoryEntry[];
  candidates: readonly PromptVariantCandidate[];
  fetchImpl?: typeof fetch;
}): Promise<PromptVariantCandidate & { rationale: string }> {
  const llmProvider = buildMainLlmProvider(input.config, input.fetchImpl);
  const recentHistory = input.history.slice(-20);
  const attributionSummary = input.config.attributionDbPath
    ? await readAttributionSummaryFromStore(input.config.attributionDbPath, {
        campaignId: input.config.attributionCampaignId
      }).catch(() => undefined)
    : undefined;

  if (llmProvider) {
    try {
      const response = await llmProvider.createJsonCompletion<PromptVariantSelectionResponse>([
        {
          role: "system",
          content: [
            "You choose the next safe content-writing prompt variant.",
            "Pick only from the provided variant ids.",
            "Prefer variants that improved usefulness or avoided weak outcomes recently.",
            "Reddit must stay non-promotional, no-link, no-CTA.",
            "Return strict JSON with keys: selectedVariantId, rationale."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              venue: input.venue,
              actionType: input.actionType,
              recentHistory: recentHistory.map((entry) => ({
                venue: entry.venue,
                actionType: entry.actionType,
                promptVariantId: entry.promptVariantId,
                promptProfileId: entry.promptProfileId,
                status: entry.status,
                layout: entry.layout,
                messageStyle: entry.messageStyle,
                technicalDepth: entry.technicalDepth,
                tone: entry.tone,
                creativity: entry.creativity,
                clickCount: entry.clickCount ?? 0,
                privateMessageCount: entry.privateMessageCount ?? 0,
                createdAt: entry.createdAt
              })),
              attributionGroups: attributionSummary?.groups
                .filter((group) => group.venue === input.venue)
                .slice(0, 8)
                .map((group) => ({
                  promptProfileId: group.promptProfileId,
                  messageStyle: group.messageStyle,
                  layout: group.layout,
                  clicks: group.clicks,
                  privateMessagesReceived: group.privateMessagesReceived,
                  skillUsages: group.skillUsages
                })),
              candidates: input.candidates.map((candidate) => ({
                id: candidate.id,
                label: candidate.label,
                parameters: candidate.parameters
              }))
            },
            null,
            2
          )
        }
      ]);
      const match = input.candidates.find((candidate) => candidate.id === response.selectedVariantId);
      if (match) {
        return {
          ...match,
          rationale: response.rationale?.trim() || `Selected ${match.id} from recent cross-venue prompt history.`
        };
      }
    } catch {
      // Deterministic fallback below.
    }
  }

  return fallbackVariantChoice(input.candidates, recentHistory);
}

function fallbackVariantChoice(
  candidates: readonly PromptVariantCandidate[],
  history: readonly PromptRotationHistoryEntry[]
): PromptVariantCandidate & { rationale: string } {
  const variantScores = new Map<string, number>();
  for (const entry of history) {
    if (!entry.promptVariantId) {
      continue;
    }
    const score =
      (entry.clickCount ?? 0) * 2 +
      (entry.privateMessageCount ?? 0) * 3 +
      (entry.status === "posted" || entry.status === "replied" || entry.status === "commented" ? 1 : 0) -
      (entry.status === "removed" || entry.status === "mod_warning" || entry.status === "spam_accusation" ? 3 : 0);
    variantScores.set(entry.promptVariantId, (variantScores.get(entry.promptVariantId) ?? 0) + score);
  }
  const selected =
    [...candidates].sort((left, right) => {
      const delta = (variantScores.get(right.id) ?? 0) - (variantScores.get(left.id) ?? 0);
      return delta !== 0 ? delta : left.id.localeCompare(right.id);
    })[0] ?? candidates[0];
  return {
    ...selected,
    rationale: `Used deterministic fallback based on recent cross-venue outcomes and safe defaults; chose ${selected.id}.`
  };
}
