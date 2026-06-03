import path from "node:path";

import {
  asOptionalString,
  buildAgentPaths,
  isRecord,
  listAgentDirectories,
  normalizeMetadata,
  pathExists,
  readJson
} from "./agent-registry";
import {
  loadAgentSchedulerSnapshot,
  resolveProfileUrl,
  resolvePromptRotationStatePath
} from "./agent-snapshot";
import { extractRecentPublishedFromState } from "./content";
import { summarizeEngagements } from "./engagements";
import { loadAgentRecentRuns } from "./run-repository";
import type { AgentCurrentPrompt, AgentMetadata, AgentRuntimePaths, DiscoveredAgent } from "./types";

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.length > 0 && Number.isFinite(Number(value))
      ? Number(value)
      : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function promptRotationAuditPath(statePath: string): string {
  const parsed = path.parse(statePath);
  return path.join(parsed.dir, `${parsed.name}.audit.jsonl`);
}

function extractPromptParameterSummary(entry: Record<string, unknown> | undefined): {
  promptParameters: Record<string, unknown>;
  messageStyle?: string;
  layout?: string;
  ctaStyle?: string;
  promotionLevel?: string;
  productSpecificity?: string;
  rewardEmphasis?: string;
  audience?: string;
  tone?: string;
  technicalDepth?: string;
  creativity?: string;
} {
  const promptParameters = { ...(asRecord(entry?.promptParameters) ?? {}) };
  const readField = (key: string): string | undefined =>
    asOptionalString(entry?.[key]) ?? asOptionalString(promptParameters[key]);

  return {
    promptParameters,
    messageStyle: readField("messageStyle"),
    layout: readField("layout"),
    ctaStyle: readField("ctaStyle"),
    promotionLevel: readField("promotionLevel"),
    productSpecificity: readField("productSpecificity"),
    rewardEmphasis: readField("rewardEmphasis"),
    audience: readField("audience"),
    tone: readField("tone"),
    technicalDepth: readField("technicalDepth"),
    creativity: readField("creativity")
  };
}

async function readCurrentPrompt(
  paths: AgentRuntimePaths,
  agentRoot: string
): Promise<AgentCurrentPrompt | undefined> {
  const statePath = await resolvePromptRotationStatePath(paths, agentRoot);
  if (!statePath) {
    return undefined;
  }

  const promptJson = await readJson(statePath);
  if (!promptJson.present || !promptJson.value) {
    return undefined;
  }

  const state = asRecord(promptJson.value.state);
  const bucketsRecord = asRecord(state?.buckets);
  const bucketEntries = Object.entries(bucketsRecord ?? {})
    .map(([scopeKey, bucketValue]) => {
      const bucket = asRecord(bucketValue);
      if (!bucket) {
        return undefined;
      }
      return {
        scopeKey,
        promptVariantId: asOptionalString(bucket.currentPromptVariant),
        promptVariantLabel: asOptionalString(bucket.currentPromptLabel),
        actionsSinceRotation: asOptionalNumber(bucket.actionsSinceRotation) ?? 0,
        rotateAfterActions: asOptionalNumber(bucket.rotateAfterActions) ?? 0,
        lastRotationAt: asOptionalString(bucket.lastRotationAt),
        lastSelectionRationale: asOptionalString(bucket.lastSelectionRationale),
        lastSelectionSource: asOptionalString(bucket.lastSelectionSource),
        lastSelectedAt: asOptionalString(bucket.lastSelectedAt),
        lastActionAt: asOptionalString(bucket.lastActionAt)
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((left, right) => left.scopeKey.localeCompare(right.scopeKey));
  const history = Array.isArray(promptJson.value.history)
    ? promptJson.value.history.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
  const currentScopeKey = asOptionalString(state?.currentScopeKey);
  const currentVariantId = asOptionalString(state?.currentPromptVariant);
  const latestEntry =
    [...history].reverse().find(
      (entry) =>
        (currentScopeKey ? asOptionalString(entry.scopeKey) === currentScopeKey : true) &&
        asOptionalString(entry.promptVariantId) === currentVariantId
    ) ??
    [...history].reverse().find((entry) => Boolean(asOptionalString(entry.promptVariantId)));

  if (!currentVariantId && !latestEntry && !state) {
    return undefined;
  }

  const summary = extractPromptParameterSummary(latestEntry);
  return {
    statePath,
    auditPath: promptRotationAuditPath(statePath),
    currentScopeKey,
    promptProfileId: asOptionalString(latestEntry?.promptProfileId),
    promptVariantId: currentVariantId ?? asOptionalString(latestEntry?.promptVariantId),
    promptVariantLabel: asOptionalString(latestEntry?.promptVariantLabel),
    promptParameters: summary.promptParameters,
    messageStyle: summary.messageStyle,
    layout: summary.layout,
    ctaStyle: summary.ctaStyle,
    promotionLevel: summary.promotionLevel,
    productSpecificity: summary.productSpecificity,
    rewardEmphasis: summary.rewardEmphasis,
    audience: summary.audience,
    tone: summary.tone,
    technicalDepth: summary.technicalDepth,
    creativity: summary.creativity,
    actionsSinceRotation: asOptionalNumber(state?.actionsSinceRotation) ?? 0,
    rotateAfterActions: asOptionalNumber(state?.rotateAfterActions) ?? 0,
    lastRotationAt: asOptionalString(state?.lastRotationAt),
    lastSelectionRationale: asOptionalString(state?.lastSelectionRationale),
    lastSelectionSource: asOptionalString(state?.lastSelectionSource),
    lastSelectedAt: asOptionalString(state?.lastSelectedAt),
    lastActionAt: asOptionalString(state?.lastActionAt) ?? asOptionalString(latestEntry?.createdAt),
    buckets: bucketEntries,
    recentHistory: history
      .slice(-10)
      .map((entry) => ({
        id: asOptionalString(entry.id) ?? "unknown",
        scopeKey: asOptionalString(entry.scopeKey),
        status: asOptionalString(entry.status),
        eventType: asOptionalString(entry.eventType),
        promptVariantId: asOptionalString(entry.promptVariantId),
        promptVariantLabel: asOptionalString(entry.promptVariantLabel),
        selectionSource: asOptionalString(entry.selectionSource),
        reusedExisting:
          typeof entry.reusedExisting === "boolean" ? entry.reusedExisting : undefined,
        rotateAfterActions: asOptionalNumber(entry.rotateAfterActions),
        actionsSinceRotation: asOptionalNumber(entry.actionsSinceRotation),
        selectionRationale: asOptionalString(entry.selectionRationale),
        createdAt: asOptionalString(entry.createdAt) ?? new Date(0).toISOString(),
        correlationId: asOptionalString(entry.correlationId),
        debugInputPath: asOptionalString(entry.debugInputPath)
      }))
  };
}

export async function discoverAgents(agentRoot: string, now = new Date()): Promise<DiscoveredAgent[]> {
  const agents: DiscoveredAgent[] = [];
  for (const entry of await listAgentDirectories(agentRoot)) {
    const paths = buildAgentPaths(agentRoot, entry);
    const [metadataJson, stateJson, reportJson, currentPrompt] = await Promise.all([
      readJson(paths.metadataPath),
      readJson(paths.statePath),
      readJson(paths.reportPath),
      readCurrentPrompt(paths, agentRoot)
    ]);
    let metadata = normalizeMetadata(paths.agentDir, metadataJson.value);
    const normalizedPaths =
      metadata.agentId === entry ? paths : buildAgentPaths(agentRoot, metadata.agentId);
    const state = stateJson.value;
    const profileUrl = await resolveProfileUrl(normalizedPaths, metadata.profileUrl, state);
    if (profileUrl) {
      metadata = { ...metadata, profileUrl };
    }
    const report = reportJson.value;
    const { readModel, sqliteSnapshot, scheduler } = await loadAgentSchedulerSnapshot(
      normalizedPaths,
      now
    );
    const engagementSummary =
      (readModel?.engagementSummary as DiscoveredAgent["engagementSummary"] | undefined) ??
      sqliteSnapshot?.engagementSummary ??
      summarizeEngagements(state, now);
    const errors =
      sqliteSnapshot?.latestErrors ?? (Array.isArray(report?.errors) ? report.errors.length : 0);
    const skipped =
      sqliteSnapshot?.latestSkipped ?? (Array.isArray(report?.skipped) ? report.skipped.length : 0);
    const recentRuns = await loadAgentRecentRuns(normalizedPaths, report, 5);

    agents.push({
      metadata,
      paths: normalizedPaths,
      readModelPresent: scheduler.readModelPresent,
      statePresent: stateJson.present,
      reportPresent: reportJson.present,
      stateError: stateJson.error,
      reportError: reportJson.error,
      state,
      report,
      engagementSummary,
      lastHeartbeatAt: scheduler.lastHeartbeatAt,
      lastPostAt: asOptionalString(state?.lastPostAt),
      lastCommentAt: asOptionalString(state?.lastCommentAt),
      pendingWrites: scheduler.pendingWrites,
      schedulerHealth: scheduler.schedulerHealth,
      lastSuccessfulHeartbeatAt: scheduler.lastSuccessfulHeartbeatAt,
      latestStartedAt: scheduler.latestStartedAt,
      latestFinishedAt: scheduler.latestFinishedAt,
      latestStatus: scheduler.latestStatus,
      latestErrors: errors,
      latestSkipped: skipped,
      currentPrompt,
      recentPublished: extractRecentPublishedFromState(state),
      recentRuns
    });
  }

  return agents;
}

export async function readDeployMetadata(agentRoot: string) {
  return {
    agentRoot,
    agentRootPresent: await pathExists(agentRoot)
  };
}
