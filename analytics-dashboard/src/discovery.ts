import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { extractRecentPublishedFromState } from "./content";
import { summarizeEngagements } from "./engagements";
import { readSqliteAgentSnapshot } from "./storage";
import type { AgentCurrentPrompt, AgentMetadata, AgentRuntimePaths, DiscoveredAgent } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readJson(filePath: string): Promise<{
  value?: Record<string, unknown>;
  present: boolean;
  error?: string;
}> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return { present: true, error: "JSON root is not an object." };
    }
    return { value: parsed, present: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { present: false };
    }
    return {
      present: true,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.length > 0 && Number.isFinite(Number(value))
      ? Number(value)
      : undefined;
}

function parseEnvFile(contents: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) {
      env[key] = value;
    }
  }
  return env;
}

function resolveTildePath(filePath: string): string {
  if (!filePath.startsWith("~/")) {
    return filePath;
  }
  const homeDir = process.env.HOME;
  return homeDir ? path.join(homeDir, filePath.slice(2)) : filePath;
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

async function resolvePromptRotationStatePath(paths: AgentRuntimePaths, agentRoot: string): Promise<string | undefined> {
  const candidatePaths = new Set<string>();

  try {
    const envRaw = await readFile(paths.envPath, "utf8");
    const configuredPath = parseEnvFile(envRaw).OUTREACH_PROMPT_ROTATION_STATE_PATH;
    if (configuredPath) {
      const resolved = resolveTildePath(configuredPath);
      candidatePaths.add(path.isAbsolute(resolved) ? resolved : path.resolve(path.dirname(paths.envPath), resolved));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  candidatePaths.add(path.join(paths.runtimeDir, "prompt-rotation.json"));
  candidatePaths.add(path.join(paths.agentDir, ".data", "prompt-rotation.json"));
  candidatePaths.add(path.join(path.dirname(paths.runtimeDir), "outreach-agent", ".data", "prompt-rotation.json"));
  candidatePaths.add(path.join(path.dirname(agentRoot), "repo", "outreach-agent", ".data", "prompt-rotation.json"));

  for (const candidatePath of candidatePaths) {
    if (await pathExists(candidatePath)) {
      return candidatePath;
    }
  }
  return undefined;
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

function sanitizeServiceName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}

function normalizeMetadata(agentDir: string, parsed: Record<string, unknown> | undefined): AgentMetadata {
  const fallbackId = path.basename(agentDir);
  const agentId = asOptionalString(parsed?.agentId) ?? fallbackId;
  return {
    agentId,
    displayName: asOptionalString(parsed?.displayName) ?? agentId,
    description: asOptionalString(parsed?.description),
    serviceName:
      asOptionalString(parsed?.serviceName) ?? `moltbook-outreach-${sanitizeServiceName(agentId)}`,
    profileUrl: asOptionalString(parsed?.profileUrl),
    walletAddress: asOptionalString(parsed?.walletAddress)
  };
}

function buildPaths(agentRoot: string, agentId: string): AgentRuntimePaths {
  const agentDir = path.join(agentRoot, agentId);
  const runtimeDir = path.join(agentDir, ".runtime");
  return {
    agentDir,
    runtimeDir,
    envPath: path.join(agentDir, ".env"),
    metadataPath: path.join(agentDir, "agent.json"),
    statePath: path.join(runtimeDir, "state.json"),
    storagePath: path.join(runtimeDir, "state.sqlite"),
    reportPath: path.join(runtimeDir, "last-heartbeat.json")
  };
}

export async function discoverAgents(agentRoot: string, now = new Date()): Promise<DiscoveredAgent[]> {
  let entries: string[];
  try {
    entries = await readdir(agentRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const agents: DiscoveredAgent[] = [];
  for (const entry of entries.sort()) {
    const agentDir = path.join(agentRoot, entry);
    const entryStats = await stat(agentDir);
    if (!entryStats.isDirectory()) {
      continue;
    }

    const paths = buildPaths(agentRoot, entry);
    const [metadataJson, stateJson, reportJson, currentPrompt] = await Promise.all([
      readJson(paths.metadataPath),
      readJson(paths.statePath),
      readJson(paths.reportPath),
      readCurrentPrompt(paths, agentRoot)
    ]);
    const metadata = normalizeMetadata(agentDir, metadataJson.value);
    const normalizedPaths =
      metadata.agentId === entry ? paths : buildPaths(agentRoot, metadata.agentId);
    const state = stateJson.value;
    const report = reportJson.value;
    let sqliteSnapshot;
    try {
      sqliteSnapshot = await readSqliteAgentSnapshot(normalizedPaths.storagePath, now);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const engagementSummary = sqliteSnapshot?.engagementSummary ?? summarizeEngagements(state, now);
    const jsonPendingWrites =
      (Array.isArray(state?.pendingWrites) ? state.pendingWrites.length : 0) +
      (Array.isArray(state?.queuedActionJobs) ? state.queuedActionJobs.length : 0);
    const pendingWrites =
      sqliteSnapshot?.pendingWrites === undefined
        ? jsonPendingWrites
        : Math.max(sqliteSnapshot.pendingWrites, jsonPendingWrites);
    const errors =
      sqliteSnapshot?.latestErrors ?? (Array.isArray(report?.errors) ? report.errors.length : 0);
    const skipped =
      sqliteSnapshot?.latestSkipped ?? (Array.isArray(report?.skipped) ? report.skipped.length : 0);

    agents.push({
      metadata,
      paths: normalizedPaths,
      statePresent: stateJson.present,
      reportPresent: reportJson.present,
      stateError: stateJson.error,
      reportError: reportJson.error,
      state,
      report,
      engagementSummary,
      lastHeartbeatAt:
        sqliteSnapshot?.lastHeartbeatAt ??
        asOptionalString(state?.lastHeartbeatAt) ??
        asOptionalString(report?.finishedAt),
      lastPostAt: asOptionalString(state?.lastPostAt),
      lastCommentAt: asOptionalString(state?.lastCommentAt),
      pendingWrites,
      schedulerHealth: sqliteSnapshot?.schedulerHealth ?? "unknown",
      lastSuccessfulHeartbeatAt:
        sqliteSnapshot?.lastSuccessfulHeartbeatAt ??
        (asOptionalString(report?.status) === "ok" ? asOptionalString(report?.finishedAt) : undefined),
      latestStartedAt: sqliteSnapshot?.latestStartedAt ?? asOptionalString(report?.startedAt),
      latestFinishedAt: sqliteSnapshot?.latestFinishedAt ?? asOptionalString(report?.finishedAt),
      latestStatus: sqliteSnapshot?.latestStatus ?? asOptionalString(report?.status),
      latestErrors: errors,
      latestSkipped: skipped,
      currentPrompt,
      recentPublished: extractRecentPublishedFromState(state)
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
