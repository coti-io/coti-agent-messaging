import type { AgentRecentPublished } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractPromptParameterSummary(entry: Record<string, unknown>): {
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
  const promptParameters = { ...(isRecord(entry.promptParameters) ? entry.promptParameters : {}) };
  const readField = (key: string): string | undefined =>
    asOptionalString(entry[key]) ?? asOptionalString(promptParameters[key]);

  return {
    promptParameters,
    messageStyle: readField("messageStyle"),
    layout: readField("layout") ?? asOptionalString(entry.layout),
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

function truncatePreview(value: string, maxLength = 160): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function isPublishedType(value: unknown): value is AgentRecentPublished["type"] {
  return value === "post" || value === "comment" || value === "reply";
}

export function extractRecentPublishedFromState(
  state: Record<string, unknown> | undefined
): AgentRecentPublished[] {
  const rawArtifacts = state?.recentGeneratedArtifacts;
  if (!Array.isArray(rawArtifacts)) {
    return [];
  }

  const items: AgentRecentPublished[] = [];
  for (const raw of rawArtifacts) {
    if (!isRecord(raw)) {
      continue;
    }
    if (!isPublishedType(raw.type)) {
      continue;
    }
    const content = asOptionalString(raw.content);
    if (!content) {
      continue;
    }

    const outreachRef = isRecord(raw.outreachRef) ? raw.outreachRef : undefined;
    const refId = asOptionalString(outreachRef?.id);
    const promptSummary = extractPromptParameterSummary(raw);

    items.push({
      id: asOptionalString(raw.id) ?? `${raw.type}:${refId ?? content.slice(0, 24)}`,
      type: raw.type,
      createdAt: asOptionalString(raw.createdAt) ?? "",
      title: asOptionalString(raw.title),
      contentPreview: truncatePreview(
        raw.type === "post" && asOptionalString(raw.title)
          ? `${asOptionalString(raw.title)} — ${content}`
          : content
      ),
      targetSummary: asOptionalString(raw.targetSummary),
      promptProfileId: asOptionalString(raw.promptProfileId),
      promptVariantId: asOptionalString(raw.promptVariantId),
      promptVariantRationale: asOptionalString(raw.promptVariantRationale),
      ...promptSummary,
      ctaUrl: asOptionalString(raw.ctaUrl),
      contentUrl: asOptionalString(outreachRef?.remoteContentUrl),
      refId,
      attributed: Boolean(refId)
    });
  }

  return items
    .filter((item) => item.createdAt.length > 0)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}
