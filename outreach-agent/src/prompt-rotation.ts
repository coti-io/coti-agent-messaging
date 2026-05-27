import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  defaultPromptRotationStatePath as defaultPromptRotationStatePathForState
} from "./config.js";

import { readAttributionSummaryFromStore } from "./attribution-store.js";
import { buildMainLlmProvider, type MoltbookRuntimeConfig } from "./config.js";
import { saveLlmDebugInput } from "./llm-debug.js";
import {
  buildSafePromptVariantCandidates,
  type PromptParameterSet,
  type PromptVariantCandidate,
  type OutreachActionType,
  type OutreachVenue
} from "./prompt-profile.js";

export type PromptRotationSelectionSource = "llm" | "deterministic_fallback";
export type PromptRotationAuditEventType =
  | "selected"
  | "published"
  | "recovered"
  | "failed"
  | "abandoned";
export type PromptRotationScopeKey = `${OutreachVenue}:${OutreachActionType}`;

export interface PromptRotationHistoryEntry {
  id: string;
  venue: OutreachVenue;
  actionType: OutreachActionType;
  scopeKey?: PromptRotationScopeKey;
  createdAt: string;
  status?: string;
  eventType?: PromptRotationAuditEventType;
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
  grantClaimCount?: number;
  privateMessageCount?: number;
  selectionSource?: PromptRotationSelectionSource;
  reusedExisting?: boolean;
  rotateAfterActions?: number;
  actionsSinceRotation?: number;
  selectionRationale?: string;
  correlationId?: string;
  debugInputPath?: string;
}

export interface PromptRotationBucketState {
  scopeKey: PromptRotationScopeKey;
  currentPromptVariant?: string;
  currentPromptLabel?: string;
  actionsSinceRotation: number;
  rotateAfterActions: number;
  lastRotationAt?: string;
  lastSelectionRationale?: string;
  lastSelectionSource?: PromptRotationSelectionSource;
  lastSelectedAt?: string;
  lastActionAt?: string;
  lastPublishedAt?: string;
}

export interface PromptRotationState {
  currentScopeKey?: PromptRotationScopeKey;
  currentPromptVariant?: string;
  currentPromptLabel?: string;
  actionsSinceRotation: number;
  rotateAfterActions: number;
  lastRotationAt?: string;
  lastSelectionRationale?: string;
  lastSelectionSource?: PromptRotationSelectionSource;
  lastSelectedAt?: string;
  lastActionAt?: string;
  buckets: Partial<Record<PromptRotationScopeKey, PromptRotationBucketState>>;
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
  scopeKey: PromptRotationScopeKey;
  selectionSource: PromptRotationSelectionSource;
  selectedAt: string;
  selectionDebugPath?: string;
  actionsSinceRotation: number;
  rotateAfterActions: number;
  reusedExisting: boolean;
}

export interface PromptRotationAuditEvent {
  id: string;
  eventType: PromptRotationAuditEventType;
  occurredAt: string;
  venue: OutreachVenue;
  actionType: OutreachActionType;
  scopeKey: PromptRotationScopeKey;
  promptProfileId?: string;
  promptVariantId?: string;
  promptVariantLabel?: string;
  promptParameters?: Partial<PromptParameterSet>;
  layout?: PromptParameterSet["layout"];
  messageStyle?: PromptParameterSet["messageStyle"];
  technicalDepth?: PromptParameterSet["technicalDepth"];
  tone?: PromptParameterSet["tone"];
  creativity?: PromptParameterSet["creativity"];
  rotateAfterActions?: number;
  actionsSinceRotation?: number;
  selectionRationale?: string;
  selectionSource?: PromptRotationSelectionSource;
  reusedExisting?: boolean;
  correlationId?: string;
  status?: string;
  debugInputPath?: string;
  countTowardsRotation: boolean;
}

export interface PromptRotationDebugSnapshot {
  statePath: string;
  auditPath: string;
  currentScopeKey?: PromptRotationScopeKey;
  currentScope?: PromptRotationBucketState;
  buckets: PromptRotationBucketState[];
  recentHistory: PromptRotationHistoryEntry[];
}

interface PromptVariantSelectionResponse {
  selectedVariantId?: string;
  rationale?: string;
}

interface PromptVariantSelectionResult extends PromptVariantCandidate {
  rationale: string;
  selectionSource: PromptRotationSelectionSource;
  debugInputPath?: string;
}

const MAX_PROMPT_ROTATION_HISTORY = 500;
const MIN_ROTATION_WINDOW = 10;
const MAX_ROTATION_WINDOW = 20;
const MAX_VARIANT_AGE_MS = 12 * 60 * 60 * 1_000;
const HISTORY_CONTEXT_LIMIT = 20;

export function defaultPromptRotationStatePath(statePathOrPackageRoot: string): string {
  if (statePathOrPackageRoot.endsWith("state.json")) {
    return defaultPromptRotationStatePathForState(statePathOrPackageRoot);
  }

  return path.join(statePathOrPackageRoot, ".data", "prompt-rotation.json");
}

export function defaultPromptRotationAuditPath(rotationStatePath: string): string {
  const parsed = path.parse(rotationStatePath);
  return path.join(parsed.dir, `${parsed.name}.audit.jsonl`);
}

export async function loadPromptRotationStore(filePath: string): Promise<PromptRotationStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PromptRotationStore>;
    const history = Array.isArray(parsed.history)
      ? parsed.history.map((entry) => normalizeHistoryEntry(entry))
      : [];
    return {
      generatedAt: parsed.generatedAt ?? new Date().toISOString(),
      state: normalizeRotationState(parsed.state, history),
      history
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        generatedAt: new Date().toISOString(),
        state: normalizeRotationState(undefined, []),
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
        state: normalizeRotationState(store.state, store.history),
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
  const statePath =
    input.config.promptRotationStatePath ??
      defaultPromptRotationStatePath(input.config.statePath ?? input.config.packageRoot);
  const store = await loadPromptRotationStore(statePath);
  const scopeKey = buildPromptRotationScopeKey(input.venue, input.actionType);
  const bucket = getBucketState(store.state, scopeKey);
  const candidates = buildSafePromptVariantCandidates({
    venue: input.venue,
    actionType: input.actionType
  });
  const currentCandidate = candidates.find((candidate) => candidate.id === bucket.currentPromptVariant);
  const selectedAt = new Date().toISOString();
  const shouldRotate =
    !currentCandidate ||
    bucket.actionsSinceRotation >= bucket.rotateAfterActions ||
    isBucketRotationStale(bucket, selectedAt);

  if (!shouldRotate && currentCandidate) {
    const nextState = setBucketState(
      store.state,
      normalizeBucketState({
        ...bucket,
        currentPromptVariant: currentCandidate.id,
        currentPromptLabel: currentCandidate.label,
        lastSelectedAt: selectedAt
      }),
      store.history
    );
    await savePromptRotationStore(statePath, {
      generatedAt: selectedAt,
      state: nextState,
      history: store.history
    });
    const selection: SelectedPromptVariant = {
      variantId: currentCandidate.id,
      label: currentCandidate.label,
      parameterOverrides: currentCandidate.parameters,
      rationale:
        bucket.lastSelectionRationale ?? "Reusing the current prompt variant until the rotation window is met.",
      scopeKey,
      selectionSource: bucket.lastSelectionSource ?? "deterministic_fallback",
      selectedAt,
      actionsSinceRotation: bucket.actionsSinceRotation,
      rotateAfterActions: bucket.rotateAfterActions,
      reusedExisting: true
    };
    await appendPromptRotationAuditEvent(statePath, {
      id: `selection:${scopeKey}:${randomUUID()}`,
      eventType: "selected",
      occurredAt: selectedAt,
      venue: input.venue,
      actionType: input.actionType,
      scopeKey,
      promptVariantId: selection.variantId,
      promptVariantLabel: selection.label,
      rotateAfterActions: selection.rotateAfterActions,
      actionsSinceRotation: selection.actionsSinceRotation,
      selectionRationale: selection.rationale,
      selectionSource: selection.selectionSource,
      reusedExisting: true,
      countTowardsRotation: false
    });
    return selection;
  }

  const selected = await chooseNextVariant({
    config: input.config,
    venue: input.venue,
    actionType: input.actionType,
    scopeKey,
    history: store.history,
    candidates,
    fetchImpl: input.fetchImpl
  });
  const rotateAfterActions = chooseRotationWindow(input.rng ?? Math.random);
  const nextState = setBucketState(
    store.state,
    normalizeBucketState({
      ...bucket,
      scopeKey,
      currentPromptVariant: selected.id,
      currentPromptLabel: selected.label,
      actionsSinceRotation: 0,
      rotateAfterActions,
      lastRotationAt: selectedAt,
      lastSelectionRationale: selected.rationale,
      lastSelectionSource: selected.selectionSource,
      lastSelectedAt: selectedAt
    }),
    store.history
  );
  await savePromptRotationStore(statePath, {
    generatedAt: selectedAt,
    state: nextState,
    history: store.history
  });
  await appendPromptRotationAuditEvent(statePath, {
    id: `selection:${scopeKey}:${randomUUID()}`,
    eventType: "selected",
    occurredAt: selectedAt,
    venue: input.venue,
    actionType: input.actionType,
    scopeKey,
    promptVariantId: selected.id,
    promptVariantLabel: selected.label,
    rotateAfterActions,
    actionsSinceRotation: 0,
    selectionRationale: selected.rationale,
    selectionSource: selected.selectionSource,
    reusedExisting: false,
    debugInputPath: selected.debugInputPath,
    countTowardsRotation: false
  });
  return {
    variantId: selected.id,
    label: selected.label,
    parameterOverrides: selected.parameters,
    rationale: selected.rationale,
    scopeKey,
    selectionSource: selected.selectionSource,
    selectedAt,
    selectionDebugPath: selected.debugInputPath,
    actionsSinceRotation: 0,
    rotateAfterActions,
    reusedExisting: false
  };
}

export async function recordPromptRotationAction(input: {
  config: MoltbookRuntimeConfig;
  entry: PromptRotationHistoryEntry;
  selection?: Partial<
    Pick<
      SelectedPromptVariant,
      | "variantId"
      | "label"
      | "rationale"
      | "rotateAfterActions"
      | "reusedExisting"
      | "selectionSource"
      | "selectedAt"
      | "selectionDebugPath"
    >
  >;
  rng?: () => number;
  eventType?: PromptRotationAuditEventType;
  countTowardsRotation?: boolean;
}): Promise<void> {
  const statePath =
    input.config.promptRotationStatePath ??
      defaultPromptRotationStatePath(input.config.statePath ?? input.config.packageRoot);
  const store = await loadPromptRotationStore(statePath);
  const entry = normalizeHistoryEntry(input.entry);
  const scopeKey = entry.scopeKey ?? buildPromptRotationScopeKey(entry.venue, entry.actionType);
  const bucket = getBucketState(store.state, scopeKey);
  const selection = input.selection;
  const eventType = input.eventType ?? "published";
  const countTowardsRotation =
    input.countTowardsRotation ?? (eventType === "published" || eventType === "recovered");
  const nextVariantId = entry.promptVariantId ?? selection?.variantId ?? bucket.currentPromptVariant;
  const nextVariantLabel = entry.promptVariantLabel ?? selection?.label ?? bucket.currentPromptLabel;
  const rotateAfterActions =
    selection?.rotateAfterActions ??
    entry.rotateAfterActions ??
    bucket.rotateAfterActions ??
    chooseRotationWindow(input.rng ?? Math.random);
  const selectionSource =
    entry.selectionSource ?? selection?.selectionSource ?? bucket.lastSelectionSource;
  const variantChanged = Boolean(nextVariantId && nextVariantId !== bucket.currentPromptVariant);
  const nextActionsSinceRotation = countTowardsRotation
    ? variantChanged || (selection && !selection.reusedExisting) || !bucket.currentPromptVariant
      ? 1
      : bucket.actionsSinceRotation + 1
    : bucket.actionsSinceRotation;
  const nextBucket = normalizeBucketState({
    ...bucket,
    scopeKey,
    currentPromptVariant: nextVariantId,
    currentPromptLabel: nextVariantLabel,
    actionsSinceRotation: nextActionsSinceRotation,
    rotateAfterActions,
    lastRotationAt:
      countTowardsRotation && (variantChanged || (selection && !selection.reusedExisting))
        ? entry.createdAt
        : bucket.lastRotationAt,
    lastSelectionRationale: selection?.rationale ?? entry.selectionRationale ?? bucket.lastSelectionRationale,
    lastSelectionSource: selectionSource,
    lastSelectedAt: selection?.selectedAt ?? bucket.lastSelectedAt,
    lastActionAt: entry.createdAt,
    lastPublishedAt: countTowardsRotation ? entry.createdAt : bucket.lastPublishedAt
  });
  const nextHistory = countTowardsRotation
    ? [
        ...store.history.filter((historyEntry) => historyEntry.id !== entry.id),
        {
          ...entry,
          scopeKey,
          eventType,
          promptVariantId: nextVariantId,
          promptVariantLabel: nextVariantLabel,
          selectionSource,
          reusedExisting: selection?.reusedExisting,
          rotateAfterActions,
          actionsSinceRotation: nextBucket.actionsSinceRotation,
          selectionRationale:
            selection?.rationale ?? entry.selectionRationale ?? nextBucket.lastSelectionRationale,
          debugInputPath: selection?.selectionDebugPath ?? entry.debugInputPath
        }
      ].slice(-MAX_PROMPT_ROTATION_HISTORY)
    : store.history;
  const nextState = setBucketState(store.state, nextBucket, nextHistory);
  await savePromptRotationStore(statePath, {
    generatedAt: new Date().toISOString(),
    state: nextState,
    history: nextHistory
  });
  await appendPromptRotationAuditEvent(statePath, {
    id: `${eventType}:${scopeKey}:${entry.id}`,
    eventType,
    occurredAt: entry.createdAt,
    venue: entry.venue,
    actionType: entry.actionType,
    scopeKey,
    promptProfileId: entry.promptProfileId,
    promptVariantId: nextVariantId,
    promptVariantLabel: nextVariantLabel,
    promptParameters: entry.promptParameters,
    layout: entry.layout,
    messageStyle: entry.messageStyle,
    technicalDepth: entry.technicalDepth,
    tone: entry.tone,
    creativity: entry.creativity,
    rotateAfterActions,
    actionsSinceRotation: nextBucket.actionsSinceRotation,
    selectionRationale: selection?.rationale ?? entry.selectionRationale,
    selectionSource,
    reusedExisting: selection?.reusedExisting,
    correlationId: entry.correlationId,
    status: entry.status,
    debugInputPath: selection?.selectionDebugPath ?? entry.debugInputPath,
    countTowardsRotation
  });
}

export async function readPromptRotationDebugSnapshot(
  config: Pick<MoltbookRuntimeConfig, "promptRotationStatePath" | "packageRoot" | "statePath">
): Promise<PromptRotationDebugSnapshot> {
  const statePath =
    config.promptRotationStatePath ??
      defaultPromptRotationStatePath(config.statePath ?? config.packageRoot);
  const store = await loadPromptRotationStore(statePath);
  return {
    statePath,
    auditPath: defaultPromptRotationAuditPath(statePath),
    currentScopeKey: store.state.currentScopeKey,
    currentScope:
      store.state.currentScopeKey === undefined
        ? undefined
        : store.state.buckets[store.state.currentScopeKey],
    buckets: Object.values(store.state.buckets)
      .filter((bucket): bucket is PromptRotationBucketState => Boolean(bucket))
      .sort((left, right) => left.scopeKey.localeCompare(right.scopeKey)),
    recentHistory: store.history.slice(-10)
  };
}

export function chooseRotationWindow(rng: () => number): number {
  return MIN_ROTATION_WINDOW + Math.floor(Math.min(0.999, Math.max(0, rng())) * (MAX_ROTATION_WINDOW - MIN_ROTATION_WINDOW + 1));
}

export function buildPromptRotationScopeKey(
  venue: OutreachVenue,
  actionType: OutreachActionType
): PromptRotationScopeKey {
  return `${venue}:${actionType}`;
}

function normalizeRotationState(
  state: Partial<PromptRotationState> | undefined,
  history: readonly PromptRotationHistoryEntry[]
): PromptRotationState {
  const historyBuckets = rebuildBucketsFromHistory(history);
  const explicitBuckets = normalizeBucketRecord(state?.buckets);
  const mergedBuckets = {
    ...historyBuckets,
    ...explicitBuckets
  };
  const currentScopeKey =
    normalizeScopeKey(state?.currentScopeKey) ??
    mostRecentHistoryEntry(history)?.scopeKey ??
    (Object.keys(mergedBuckets)[0] as PromptRotationScopeKey | undefined);
  const currentBucket =
    currentScopeKey === undefined ? undefined : mergedBuckets[currentScopeKey];
  return {
    currentScopeKey,
    currentPromptVariant: state?.currentPromptVariant ?? currentBucket?.currentPromptVariant,
    currentPromptLabel: state?.currentPromptLabel ?? currentBucket?.currentPromptLabel,
    actionsSinceRotation: Math.max(0, state?.actionsSinceRotation ?? currentBucket?.actionsSinceRotation ?? 0),
    rotateAfterActions: clampRotationWindow(
      state?.rotateAfterActions ?? currentBucket?.rotateAfterActions
    ),
    lastRotationAt: state?.lastRotationAt ?? currentBucket?.lastRotationAt,
    lastSelectionRationale:
      state?.lastSelectionRationale ?? currentBucket?.lastSelectionRationale,
    lastSelectionSource:
      state?.lastSelectionSource ?? currentBucket?.lastSelectionSource,
    lastSelectedAt: state?.lastSelectedAt ?? currentBucket?.lastSelectedAt,
    lastActionAt: state?.lastActionAt ?? currentBucket?.lastActionAt,
    buckets: mergedBuckets
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
  scopeKey: PromptRotationScopeKey;
  history: readonly PromptRotationHistoryEntry[];
  candidates: readonly PromptVariantCandidate[];
  fetchImpl?: typeof fetch;
}): Promise<PromptVariantSelectionResult> {
  const llmProvider = buildMainLlmProvider(input.config, input.fetchImpl);
  const recentHistory = input.history.slice(-HISTORY_CONTEXT_LIMIT);
  const attributionSummary = input.config.attributionDbPath
    ? await readAttributionSummaryFromStore(input.config.attributionDbPath, {
        campaignId: input.config.attributionCampaignId
      }).catch(() => undefined)
    : undefined;

  if (llmProvider) {
    const messages = [
      {
        role: "system" as const,
        content: [
          "You choose the next safe content-writing prompt variant.",
          "Pick only from the provided variant ids.",
          "Prefer variants that drove grant claims and private messages, not just clicks.",
          "Reddit must stay non-promotional, no-link, no-CTA.",
          "Return strict JSON with keys: selectedVariantId, rationale."
        ].join(" ")
      },
      {
        role: "user" as const,
        content: JSON.stringify(
          {
            venue: input.venue,
            actionType: input.actionType,
            scopeKey: input.scopeKey,
            recentHistory: recentHistory.map((entry) => ({
              venue: entry.venue,
              actionType: entry.actionType,
              scopeKey: entry.scopeKey,
              promptVariantId: entry.promptVariantId,
              promptProfileId: entry.promptProfileId,
              status: entry.status,
              eventType: entry.eventType,
              layout: entry.layout,
              messageStyle: entry.messageStyle,
              technicalDepth: entry.technicalDepth,
              tone: entry.tone,
              creativity: entry.creativity,
              clickCount: entry.clickCount ?? 0,
              grantClaimCount: entry.grantClaimCount ?? 0,
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
                grantClaimsSucceeded: group.grantClaimsSucceeded,
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
    ];
    const debugInputPath = await saveLlmDebugInput(input.config, {
      phase: "prompt-variant-selection",
      providerLabel: llmProvider.label,
      runId: input.scopeKey,
      messages,
      context: {
        scopeKey: input.scopeKey,
        venue: input.venue,
        actionType: input.actionType
      }
    });
    try {
      const response = await llmProvider.createJsonCompletion<PromptVariantSelectionResponse>(messages);
      const match = input.candidates.find((candidate) => candidate.id === response.selectedVariantId);
      if (match) {
        return {
          ...match,
          rationale: response.rationale?.trim() || `Selected ${match.id} from recent scoped prompt history.`,
          selectionSource: "llm",
          debugInputPath
        };
      }
    } catch {
      // Deterministic fallback below.
    }
  }

  return fallbackVariantChoice(input.candidates, recentHistory);
}

export function scorePromptRotationHistoryEntry(
  entry: Pick<
    PromptRotationHistoryEntry,
    "clickCount" | "grantClaimCount" | "privateMessageCount" | "status"
  >
): number {
  return (
    (entry.grantClaimCount ?? 0) * 5 +
    (entry.privateMessageCount ?? 0) * 8 +
    (entry.clickCount ?? 0) * 1 +
    (entry.status === "posted" || entry.status === "replied" || entry.status === "commented" ? 1 : 0) -
    (entry.status === "removed" || entry.status === "mod_warning" || entry.status === "spam_accusation"
      ? 5
      : 0)
  );
}

function fallbackVariantChoice(
  candidates: readonly PromptVariantCandidate[],
  history: readonly PromptRotationHistoryEntry[]
): PromptVariantSelectionResult {
  const variantScores = new Map<string, number>();
  for (const entry of history) {
    if (!entry.promptVariantId) {
      continue;
    }
    const score = scorePromptRotationHistoryEntry(entry);
    variantScores.set(entry.promptVariantId, (variantScores.get(entry.promptVariantId) ?? 0) + score);
  }
  const selected =
    [...candidates].sort((left, right) => {
      const delta = (variantScores.get(right.id) ?? 0) - (variantScores.get(left.id) ?? 0);
      return delta !== 0 ? delta : left.id.localeCompare(right.id);
    })[0] ?? candidates[0];
  return {
    ...selected,
    rationale: `Used deterministic fallback based on recent prompt outcomes and safe defaults; chose ${selected.id}.`,
    selectionSource: "deterministic_fallback"
  };
}

function normalizeHistoryEntry(entry: Partial<PromptRotationHistoryEntry> | undefined): PromptRotationHistoryEntry {
  return {
    id: entry?.id ?? randomUUID(),
    venue: entry?.venue ?? "moltbook",
    actionType: entry?.actionType ?? "comment_on_post",
    scopeKey:
      normalizeScopeKey(entry?.scopeKey) ??
      buildPromptRotationScopeKey(entry?.venue ?? "moltbook", entry?.actionType ?? "comment_on_post"),
    createdAt: entry?.createdAt ?? new Date().toISOString(),
    status: entry?.status,
    eventType: entry?.eventType,
    promptProfileId: entry?.promptProfileId,
    promptVariantId: entry?.promptVariantId,
    promptVariantLabel: entry?.promptVariantLabel,
    promptParameters: entry?.promptParameters,
    layout: entry?.layout,
    messageStyle: entry?.messageStyle,
    technicalDepth: entry?.technicalDepth,
    tone: entry?.tone,
    creativity: entry?.creativity,
    clickCount: entry?.clickCount,
    grantClaimCount: entry?.grantClaimCount,
    privateMessageCount: entry?.privateMessageCount,
    selectionSource: entry?.selectionSource,
    reusedExisting: entry?.reusedExisting,
    rotateAfterActions: entry?.rotateAfterActions,
    actionsSinceRotation: entry?.actionsSinceRotation,
    selectionRationale: entry?.selectionRationale,
    correlationId: entry?.correlationId,
    debugInputPath: entry?.debugInputPath
  };
}

function normalizeBucketRecord(
  buckets: PromptRotationState["buckets"] | undefined
): PromptRotationState["buckets"] {
  if (!buckets) {
    return {};
  }
  const normalized: PromptRotationState["buckets"] = {};
  for (const [scopeKey, bucket] of Object.entries(buckets)) {
    const normalizedScopeKey = normalizeScopeKey(scopeKey);
    if (!normalizedScopeKey || !bucket) {
      continue;
    }
    normalized[normalizedScopeKey] = normalizeBucketState({
      ...bucket,
      scopeKey: normalizedScopeKey
    });
  }
  return normalized;
}

function normalizeBucketState(bucket: Partial<PromptRotationBucketState>): PromptRotationBucketState {
  const scopeKey =
    normalizeScopeKey(bucket.scopeKey) ?? buildPromptRotationScopeKey("moltbook", "comment_on_post");
  return {
    scopeKey,
    currentPromptVariant: bucket.currentPromptVariant,
    currentPromptLabel: bucket.currentPromptLabel,
    actionsSinceRotation: Math.max(0, bucket.actionsSinceRotation ?? 0),
    rotateAfterActions: clampRotationWindow(bucket.rotateAfterActions),
    lastRotationAt: bucket.lastRotationAt,
    lastSelectionRationale: bucket.lastSelectionRationale,
    lastSelectionSource: bucket.lastSelectionSource,
    lastSelectedAt: bucket.lastSelectedAt,
    lastActionAt: bucket.lastActionAt,
    lastPublishedAt: bucket.lastPublishedAt
  };
}

function getBucketState(
  state: PromptRotationState,
  scopeKey: PromptRotationScopeKey
): PromptRotationBucketState {
  return state.buckets[scopeKey] ?? normalizeBucketState({ scopeKey });
}

function setBucketState(
  state: PromptRotationState,
  bucket: PromptRotationBucketState,
  history: readonly PromptRotationHistoryEntry[]
): PromptRotationState {
  return normalizeRotationState(
    {
      ...state,
      currentScopeKey: bucket.scopeKey,
      currentPromptVariant: bucket.currentPromptVariant,
      currentPromptLabel: bucket.currentPromptLabel,
      actionsSinceRotation: bucket.actionsSinceRotation,
      rotateAfterActions: bucket.rotateAfterActions,
      lastRotationAt: bucket.lastRotationAt,
      lastSelectionRationale: bucket.lastSelectionRationale,
      lastSelectionSource: bucket.lastSelectionSource,
      lastSelectedAt: bucket.lastSelectedAt,
      lastActionAt: bucket.lastActionAt,
      buckets: {
        ...state.buckets,
        [bucket.scopeKey]: bucket
      }
    },
    history
  );
}

function rebuildBucketsFromHistory(
  history: readonly PromptRotationHistoryEntry[]
): PromptRotationState["buckets"] {
  const grouped = new Map<PromptRotationScopeKey, PromptRotationHistoryEntry[]>();
  for (const entry of history) {
    const scopeKey = entry.scopeKey ?? buildPromptRotationScopeKey(entry.venue, entry.actionType);
    const bucketHistory = grouped.get(scopeKey) ?? [];
    bucketHistory.push(entry);
    grouped.set(scopeKey, bucketHistory);
  }

  const buckets: PromptRotationState["buckets"] = {};
  for (const [scopeKey, scopedHistory] of grouped.entries()) {
    const latest = scopedHistory[scopedHistory.length - 1];
    if (!latest?.promptVariantId) {
      continue;
    }
    let actionsSinceRotation = 0;
    for (let index = scopedHistory.length - 1; index >= 0; index -= 1) {
      const entry = scopedHistory[index];
      if (!entry?.promptVariantId || entry.promptVariantId !== latest.promptVariantId) {
        break;
      }
      actionsSinceRotation += 1;
    }
    buckets[scopeKey] = normalizeBucketState({
      scopeKey,
      currentPromptVariant: latest.promptVariantId,
      currentPromptLabel: latest.promptVariantLabel,
      actionsSinceRotation,
      rotateAfterActions: latest.rotateAfterActions,
      lastRotationAt: latest.createdAt,
      lastSelectionRationale: latest.selectionRationale,
      lastSelectionSource: latest.selectionSource,
      lastSelectedAt: latest.createdAt,
      lastActionAt: latest.createdAt,
      lastPublishedAt: latest.createdAt
    });
  }
  return buckets;
}

function normalizeScopeKey(value: string | undefined): PromptRotationScopeKey | undefined {
  if (!value) {
    return undefined;
  }
  const [venue, actionType] = value.split(":");
  if (
    (venue === "moltbook" || venue === "reddit") &&
    (actionType === "create_post" ||
      actionType === "comment_on_post" ||
      actionType === "reply_to_activity")
  ) {
    return value as PromptRotationScopeKey;
  }
  return undefined;
}

function mostRecentHistoryEntry(
  history: readonly PromptRotationHistoryEntry[]
): PromptRotationHistoryEntry | undefined {
  return history[history.length - 1];
}

function isBucketRotationStale(
  bucket: PromptRotationBucketState,
  nowIso: string
): boolean {
  const referenceTime =
    bucket.lastActionAt ?? bucket.lastSelectedAt ?? bucket.lastRotationAt;
  if (!referenceTime) {
    return false;
  }
  const elapsedMs = Date.parse(nowIso) - Date.parse(referenceTime);
  return Number.isFinite(elapsedMs) && elapsedMs >= MAX_VARIANT_AGE_MS;
}

async function appendPromptRotationAuditEvent(
  rotationStatePath: string,
  event: PromptRotationAuditEvent
): Promise<void> {
  const auditPath = defaultPromptRotationAuditPath(rotationStatePath);
  await mkdir(path.dirname(auditPath), { recursive: true });
  await appendFile(auditPath, `${JSON.stringify(event)}\n`, "utf8");
}
