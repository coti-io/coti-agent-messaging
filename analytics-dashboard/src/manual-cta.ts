import { createHash } from "node:crypto";

export interface ManualRefBuilderInput {
  venue: string;
  surface?: string;
  contentType: string;
  campaignId: string;
  promptProfileId: string;
  messageStyle: string;
  layout: string;
  ctaStyle?: string;
  promotionLevel?: string;
  productSpecificity?: string;
  rewardEmphasis?: string;
  audience?: string;
  label?: string;
  utmMedium?: string;
  attributionMode?: "tracked_link" | "manual_ref" | "inferred";
  publicValueDeliveredFirst?: boolean;
  privateMessageEscalationReason?: string;
}

export interface ManualOutreachRef {
  id: string;
  venue: string;
  surface?: string;
  contentType: string;
  campaignId: string;
  promptProfileId: string;
  promptParameters: Record<string, unknown>;
  messageStyle: string;
  layout: string;
  ctaStyle?: string;
  promotionLevel?: string;
  productSpecificity?: string;
  rewardEmphasis?: string;
  audience?: string;
  candidateId: string;
  generatedContentId: string;
  attributionMode: "tracked_link" | "manual_ref" | "inferred";
  publicValueDeliveredFirst: boolean;
  privateMessageEscalationReason?: string;
  utm: Record<string, string>;
  createdAt: string;
}

function requireString(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`Missing required field "${field}".`);
  }
  return trimmed;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function slugify(value: string, fallback = "manual"): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || fallback;
}

function buildToken(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("base64url").slice(0, 10);
}

export function buildTrackedCtaUrl(
  baseUrl: string | undefined,
  ref: Pick<ManualOutreachRef, "id" | "utm">
): string | undefined {
  if (!baseUrl) {
    return undefined;
  }
  try {
    const url = new URL(baseUrl);
    if (ref.utm.source) url.searchParams.set("utm_source", ref.utm.source);
    if (ref.utm.medium) url.searchParams.set("utm_medium", ref.utm.medium);
    if (ref.utm.campaign) url.searchParams.set("utm_campaign", ref.utm.campaign);
    if (ref.utm.content) url.searchParams.set("utm_content", ref.utm.content);
    url.searchParams.set("ref", ref.id);
    return url.toString();
  } catch {
    return undefined;
  }
}

export function buildManualOutreachRef(
  input: ManualRefBuilderInput,
  now = new Date()
): ManualOutreachRef {
  const venue = requireString(input.venue, "venue");
  const contentType = requireString(input.contentType, "contentType");
  const campaignId = requireString(input.campaignId, "campaignId");
  const promptProfileId = requireString(input.promptProfileId, "promptProfileId");
  const messageStyle = requireString(input.messageStyle, "messageStyle");
  const layout = requireString(input.layout, "layout");
  const surface = normalizeOptional(input.surface);
  const ctaStyle = normalizeOptional(input.ctaStyle);
  const promotionLevel = normalizeOptional(input.promotionLevel);
  const productSpecificity = normalizeOptional(input.productSpecificity);
  const rewardEmphasis = normalizeOptional(input.rewardEmphasis);
  const audience = normalizeOptional(input.audience);
  const label = normalizeOptional(input.label);
  const utmMedium = normalizeOptional(input.utmMedium) ?? "manual_outreach";
  const attributionMode = input.attributionMode ?? "manual_ref";
  const publicValueDeliveredFirst = input.publicValueDeliveredFirst ?? true;
  const privateMessageEscalationReason = normalizeOptional(input.privateMessageEscalationReason);
  const createdAt = now.toISOString();

  const venueSlug = slugify(venue, "channel");
  const labelSlug = slugify(label ?? `${campaignId}-${contentType}`, "content");
  const token = buildToken([venue, campaignId, promptProfileId, messageStyle, layout, labelSlug, createdAt]);

  return {
    id: `manual_${venueSlug}_${token}`,
    venue,
    surface,
    contentType,
    campaignId,
    promptProfileId,
    promptParameters: {
      builder: "manual_cta",
      label,
      venue,
      surface,
      contentType,
      campaignId,
      promptProfileId,
      messageStyle,
      layout,
      ctaStyle,
      promotionLevel,
      productSpecificity,
      rewardEmphasis,
      audience,
      attributionMode,
      publicValueDeliveredFirst,
      privateMessageEscalationReason
    },
    messageStyle,
    layout,
    ctaStyle,
    promotionLevel,
    productSpecificity,
    rewardEmphasis,
    audience,
    attributionMode,
    publicValueDeliveredFirst,
    privateMessageEscalationReason,
    candidateId: `manual-${contentType}-${token}`,
    generatedContentId: `${labelSlug}_${token}`,
    utm: {
      source: venueSlug,
      medium: utmMedium,
      campaign: campaignId,
      content: `${labelSlug}_${token}`
    },
    createdAt
  };
}
