import { createHash } from "node:crypto";

import type { CtaPlacement, LayoutVariant, MessageStyle, PromptParameterSet } from "./prompt-profile.js";
import { validateCtaUrlDomain } from "./prompt-profile.js";

export type AttributionVenue = "moltbook" | "reddit" | (string & {});
export type AttributedContentType = "post" | "comment" | "reply" | "private_message" | "grant" | "skill_usage";
export type AttributionEventType =
  | "click"
  | "private_message"
  | "private_message_received"
  | "grant_request"
  | "grant_challenge"
  | "grant_claim_attempted"
  | "grant_claim_queued"
  | "grant_claim_succeeded"
  | "grant_claim_failed"
  | "skill_usage"
  | "posted"
  | "removed"
  | "spam_accusation";

export interface OutreachRefInput {
  venue: AttributionVenue;
  venueAccountId?: string;
  surface?: string;
  contentType: AttributedContentType;
  promptProfileId: string;
  parameters: PromptParameterSet;
  campaignId: string;
  candidateId: string;
  generatedContentId: string;
  remoteContentId?: string;
  remoteContentUrl?: string;
  timestamp?: Date;
}

export interface OutreachRef {
  id: string;
  venue: AttributionVenue;
  venueAccountId?: string;
  surface?: string;
  contentType: AttributedContentType;
  promptProfileId: string;
  promptParameters: PromptParameterSet;
  messageStyle: MessageStyle;
  layout: LayoutVariant;
  ctaStyle: PromptParameterSet["ctaStyle"];
  promotionLevel: PromptParameterSet["promotionLevel"];
  productSpecificity: PromptParameterSet["productSpecificity"];
  rewardEmphasis: PromptParameterSet["rewardEmphasis"];
  audience: PromptParameterSet["audience"];
  campaignId: string;
  candidateId: string;
  generatedContentId: string;
  remoteContentId?: string;
  remoteContentUrl?: string;
  timestampBucket: string;
  utm: {
    source: string;
    medium: string;
    campaign: string;
    content: string;
  };
}

export interface TrackedLink {
  url: string;
  ref: OutreachRef;
  placement: CtaPlacement;
}

export type CtaLink = TrackedLink;

export interface AttributionEvent {
  refId: string;
  type: AttributionEventType;
  occurredAt: string;
  venue?: string;
  sessionId?: string;
  walletAddress?: string;
  installId?: string;
  skillId?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface AttributionSummary {
  generatedAt: string;
  groups: Array<{
    key: string;
    promptProfileId: string;
    messageStyle: MessageStyle;
    layout: LayoutVariant;
    clicks: number;
    privateMessages: number;
    privateMessagesReceived: number;
    grantRequests: number;
    skillUsages: number;
    clickToPrivateMessageRate: number;
    clickToSkillUsageRate: number;
  }>;
}

export function buildOutreachRef(input: OutreachRefInput): OutreachRef {
  const timestamp = input.timestamp ?? new Date();
  const timestampBucket = timestamp.toISOString().slice(0, 13).replace(/[-T:]/g, "");
  const contentSlug = [
    input.parameters.messageStyle,
    input.parameters.layout.replace(/_(?:paragraph|bullets)$/u, ""),
    shortHash(`${input.campaignId}:${input.candidateId}:${input.generatedContentId}:${timestampBucket}`)
  ].join("_");
  const id = `${input.venue.slice(0, 2)}_${shortHash(contentSlug)}`;

  return {
    id,
    venue: input.venue,
    venueAccountId: input.venueAccountId,
    surface: input.surface,
    contentType: input.contentType,
    promptProfileId: input.promptProfileId,
    promptParameters: input.parameters,
    messageStyle: input.parameters.messageStyle,
    layout: input.parameters.layout,
    ctaStyle: input.parameters.ctaStyle,
    promotionLevel: input.parameters.promotionLevel,
    productSpecificity: input.parameters.productSpecificity,
    rewardEmphasis: input.parameters.rewardEmphasis,
    audience: input.parameters.audience,
    campaignId: input.campaignId,
    candidateId: input.candidateId,
    generatedContentId: input.generatedContentId,
    remoteContentId: input.remoteContentId,
    remoteContentUrl: input.remoteContentUrl,
    timestampBucket,
    utm: {
      source: input.venue,
      medium: "outreach_agent",
      campaign: input.campaignId,
      content: `${contentSlug}_${input.contentType}`
    }
  };
}

export function buildTrackedLink(input: {
  baseUrl: string;
  ref: OutreachRef;
  placement: CtaPlacement;
  approvedDomains: readonly string[];
}): TrackedLink {
  validateCtaUrlDomain(input.baseUrl, input.approvedDomains);
  const url = new URL(input.baseUrl);
  url.searchParams.set("utm_source", input.ref.utm.source);
  url.searchParams.set("utm_medium", input.ref.utm.medium);
  url.searchParams.set("utm_campaign", input.ref.utm.campaign);
  url.searchParams.set("utm_content", input.ref.utm.content);
  url.searchParams.set("ref", input.ref.id);

  const finalUrl = url.toString();
  validateCtaUrlDomain(finalUrl, input.approvedDomains);

  return {
    url: finalUrl,
    ref: input.ref,
    placement: input.placement
  };
}

export const buildMoltbookCtaLink = buildTrackedLink;

export function extractRefIdFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.searchParams.get("ref") ?? undefined;
  } catch {
    return undefined;
  }
}

export function buildAttributionEvent(input: {
  refId: string;
  type: AttributionEventType;
  occurredAt?: Date;
  venue?: string;
  sessionId?: string;
  walletAddress?: string;
  installId?: string;
  skillId?: string;
  metadata?: Record<string, string | number | boolean>;
}): AttributionEvent {
  return {
    refId: input.refId,
    type: input.type,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    venue: input.venue,
    sessionId: input.sessionId,
    walletAddress: input.walletAddress,
    installId: input.installId,
    skillId: input.skillId,
    metadata: input.metadata
  };
}

export function summarizeAttribution(input: {
  refs: readonly OutreachRef[];
  events: readonly AttributionEvent[];
  now?: Date;
}): AttributionSummary {
  const refsById = new Map(input.refs.map((ref) => [ref.id, ref]));
  const groups = new Map<
    string,
    {
      promptProfileId: string;
      messageStyle: MessageStyle;
      layout: LayoutVariant;
      clicks: number;
      privateMessages: number;
      privateMessagesReceived: number;
      grantRequests: number;
      skillUsages: number;
    }
  >();

  for (const event of input.events) {
    const ref = refsById.get(event.refId);
    if (!ref) {
      continue;
    }

    const key = `${ref.promptProfileId}:${ref.messageStyle}:${ref.layout}`;
    const group =
      groups.get(key) ??
      {
        promptProfileId: ref.promptProfileId,
        messageStyle: ref.messageStyle,
        layout: ref.layout,
        clicks: 0,
        privateMessages: 0,
        privateMessagesReceived: 0,
        grantRequests: 0,
        skillUsages: 0
      };
    if (event.type === "click") {
      group.clicks += 1;
    }
    if (event.type === "private_message") {
      group.privateMessages += 1;
    }
    if (event.type === "private_message_received") {
      group.privateMessagesReceived += 1;
    }
    if (event.type === "grant_request") {
      group.grantRequests += 1;
    }
    if (event.type === "skill_usage") {
      group.skillUsages += 1;
    }
    groups.set(key, group);
  }

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    groups: [...groups.entries()].map(([key, group]) => ({
      key,
      ...group,
      clickToPrivateMessageRate:
        group.clicks === 0 ? 0 : (group.privateMessages + group.privateMessagesReceived) / group.clicks,
      clickToSkillUsageRate:
        group.clicks === 0 ? 0 : group.skillUsages / group.clicks
    }))
  };
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}
