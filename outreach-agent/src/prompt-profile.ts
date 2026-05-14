export type OutreachVenue = "moltbook" | "reddit";
export type OutreachActionType = "create_post" | "comment_on_post" | "reply_to_activity";

export type PromptIntent =
  | "educate"
  | "challenge_assumption"
  | "announce"
  | "invite_discussion"
  | "answer_objection";
export type PromotionLevel = "none" | "soft" | "direct";
export type AggressionLevel = "low" | "medium" | "high";
export type CreativityLevel = "conservative" | "balanced" | "experimental";
export type TechnicalDepth = "simple" | "practical" | "deep";
export type PromptTone = "technical_realist" | "contrarian" | "operator" | "founder" | "researcher";
export type CtaStyle = "none" | "question" | "soft_next_step" | "direct_next_step";
export type ProductSpecificity = "generic_category" | "coti_anchored" | "feature_specific";
export type RewardEmphasis = "none" | "secondary" | "primary_when_relevant";
export type PromptAudience = "agent_builder" | "web3_dev" | "privacy_dev" | "mcp_builder" | "operator";
export type MessageStyle =
  | "informative"
  | "aggressive"
  | "curious"
  | "technical"
  | "contrarian"
  | "promotional";
export type LayoutVariant =
  | "regular_paragraph"
  | "structured_bullets"
  | "short_hook_then_detail"
  | "question_answer"
  | "problem_solution";
export type CtaRequirement = "required" | "optional" | "forbidden";
export type CtaPlacement = "end" | "after_first_paragraph";

export interface PromptParameterSet {
  intent: PromptIntent;
  promotionLevel: PromotionLevel;
  aggression: AggressionLevel;
  creativity: CreativityLevel;
  technicalDepth: TechnicalDepth;
  tone: PromptTone;
  ctaStyle: CtaStyle;
  productSpecificity: ProductSpecificity;
  rewardEmphasis: RewardEmphasis;
  audience: PromptAudience;
  messageStyle: MessageStyle;
  layout: LayoutVariant;
}

export interface CtaPolicy {
  requirement: CtaRequirement;
  placement: CtaPlacement;
  approvedDomains: string[];
  baseUrl?: string;
}

export interface PromptProfile {
  id: string;
  description?: string;
  parameters: Partial<PromptParameterSet>;
  cta?: Partial<CtaPolicy>;
  venueOverrides?: Partial<Record<OutreachVenue, Partial<PromptParameterSet> & { cta?: Partial<CtaPolicy> }>>;
  actionOverrides?: Partial<Record<OutreachActionType, Partial<PromptParameterSet> & { cta?: Partial<CtaPolicy> }>>;
}

export interface ResolvedPromptProfile {
  id: string;
  venue: OutreachVenue;
  actionType: OutreachActionType;
  parameters: PromptParameterSet;
  cta: CtaPolicy;
  warnings: string[];
}

export interface ResolvePromptProfileInput {
  venue: OutreachVenue;
  actionType: OutreachActionType;
  profile?: PromptProfile;
  profileId?: string;
  ctaBaseUrl?: string;
  approvedDomains?: readonly string[];
}

export interface DraftSimilarity {
  artifactId: string;
  score: number;
  reason: string;
}

export const DEFAULT_PROMPT_PARAMETERS: PromptParameterSet = {
  intent: "educate",
  promotionLevel: "soft",
  aggression: "medium",
  creativity: "balanced",
  technicalDepth: "practical",
  tone: "technical_realist",
  ctaStyle: "soft_next_step",
  productSpecificity: "coti_anchored",
  rewardEmphasis: "secondary",
  audience: "agent_builder",
  messageStyle: "technical",
  layout: "regular_paragraph"
};

export const DEFAULT_PROMPT_PROFILE: PromptProfile = {
  id: "default-technical-soft-cta",
  description: "Conservative technical outreach with optional CTA support.",
  parameters: DEFAULT_PROMPT_PARAMETERS,
  cta: {
    requirement: "optional",
    placement: "end"
  }
};

const SHORTENER_OR_CLOAKING_DOMAINS = new Set([
  "bit.ly",
  "t.co",
  "tinyurl.com",
  "goo.gl",
  "ow.ly",
  "buff.ly",
  "rebrand.ly",
  "cutt.ly"
]);

const PRESSURE_PATTERNS = [
  /\byou(?:'re| are) (?:dumb|stupid|idiot|wrong)\b/i,
  /\bonly an idiot\b/i,
  /\bmust (?:join|buy|sign up|act) now\b/i,
  /\blast chance\b/i,
  /\bdon't miss out\b/i
] as const;

export function resolvePromptProfile(input: ResolvePromptProfileInput): ResolvedPromptProfile {
  const profile = input.profile ?? DEFAULT_PROMPT_PROFILE;
  const venueOverride = profile.venueOverrides?.[input.venue];
  const actionOverride = profile.actionOverrides?.[input.actionType];
  const mergedParameters: PromptParameterSet = {
    ...DEFAULT_PROMPT_PARAMETERS,
    ...profile.parameters,
    ...venueOverride,
    ...actionOverride
  };
  const mergedCta: CtaPolicy = {
    requirement: "optional",
    placement: "end",
    approvedDomains: [...(input.approvedDomains ?? [])],
    ...profile.cta,
    ...venueOverride?.cta,
    ...actionOverride?.cta
  };
  if (input.ctaBaseUrl) {
    mergedCta.baseUrl = input.ctaBaseUrl;
    if (
      mergedCta.requirement === "optional" &&
      input.venue === "moltbook" &&
      input.actionType === "create_post"
    ) {
      mergedCta.requirement = "required";
    }
  }
  if (mergedCta.baseUrl && mergedCta.approvedDomains.length === 0) {
    mergedCta.approvedDomains = [new URL(mergedCta.baseUrl).hostname];
  }

  const warnings: string[] = [];
  if (input.venue === "reddit") {
    if (mergedParameters.promotionLevel !== "none") {
      warnings.push("Reddit first replies force promotionLevel=none.");
    }
    if (mergedParameters.ctaStyle !== "none") {
      warnings.push("Reddit first replies force ctaStyle=none.");
    }
    if (mergedParameters.productSpecificity !== "generic_category") {
      warnings.push("Reddit first replies force productSpecificity=generic_category.");
    }
    mergedParameters.promotionLevel = "none";
    mergedParameters.ctaStyle = "none";
    mergedParameters.productSpecificity = "generic_category";
    mergedCta.requirement = "forbidden";
    delete mergedCta.baseUrl;
  }

  if (input.actionType !== "create_post" && mergedParameters.promotionLevel === "direct") {
    warnings.push("First-touch comments/replies cannot use promotionLevel=direct; downgraded to soft.");
    mergedParameters.promotionLevel = "soft";
  }

  if (mergedParameters.aggression === "high") {
    warnings.push("High aggression means sharper framing only; harassment and pressure language stay blocked.");
  }

  return {
    id: input.profileId ?? profile.id,
    venue: input.venue,
    actionType: input.actionType,
    parameters: mergedParameters,
    cta: mergedCta,
    warnings
  };
}

export function validatePromptProfile(profile: ResolvedPromptProfile): void {
  if (profile.venue === "reddit" && profile.cta.requirement !== "forbidden") {
    throw new Error("Reddit first replies must forbid CTA links.");
  }

  if (profile.cta.requirement === "required" && !profile.cta.baseUrl) {
    throw new Error("CTA is required but no CTA base URL is configured.");
  }

  for (const domain of profile.cta.approvedDomains) {
    if (SHORTENER_OR_CLOAKING_DOMAINS.has(domain.toLowerCase())) {
      throw new Error(`Unapproved CTA domain: ${domain}. Link shorteners are blocked.`);
    }
  }
}

export function validateDraftAgainstPromptProfile(
  profile: ResolvedPromptProfile,
  content: string,
  ctaUrl?: string
): void {
  const detectedUrls = extractUrls(content);
  if (profile.cta.requirement === "forbidden" && /https?:\/\//i.test(content)) {
    throw new Error("CTA/link is forbidden for this venue/action.");
  }

  if (ctaUrl) {
    if (!content.includes(ctaUrl)) {
      throw new Error("Generated content is missing the required tracked CTA URL.");
    }
    validateCtaUrlDomain(ctaUrl, profile.cta.approvedDomains);
  }

  if (profile.cta.requirement === "required") {
    if (!ctaUrl) {
      throw new Error("CTA is required but no tracked CTA URL was generated.");
    }
  }

  if (profile.venue === "moltbook" && profile.actionType !== "create_post") {
    if (!ctaUrl && detectedUrls.length > 0) {
      throw new Error("Replies/comments must not include links unless the target explicitly asked for one.");
    }
    if (
      ctaUrl &&
      detectedUrls.some((url) => normalizeDetectedUrl(url) !== normalizeDetectedUrl(ctaUrl))
    ) {
      throw new Error("Replies/comments may include only the exact tracked CTA URL.");
    }
  }

  if (profile.parameters.aggression === "high" && PRESSURE_PATTERNS.some((pattern) => pattern.test(content))) {
    throw new Error("Generated content uses harassment or pressure language.");
  }
}

export function validateCtaUrlDomain(ctaUrl: string, approvedDomains: readonly string[]): void {
  const domain = new URL(ctaUrl).hostname.toLowerCase();
  if (SHORTENER_OR_CLOAKING_DOMAINS.has(domain)) {
    throw new Error(`Unapproved CTA domain: ${domain}. Link shorteners are blocked.`);
  }
  if (approvedDomains.length > 0 && !approvedDomains.map((entry) => entry.toLowerCase()).includes(domain)) {
    throw new Error(`CTA domain ${domain} is not in the approved domain list.`);
  }
}

export function promptProfileToPromptText(profile: ResolvedPromptProfile): string {
  return [
    `Prompt profile: ${profile.id}`,
    `Message style: ${profile.parameters.messageStyle}`,
    `Intent: ${profile.parameters.intent}`,
    `Promotion level: ${profile.parameters.promotionLevel}`,
    `Aggression: ${profile.parameters.aggression}`,
    `Creativity: ${profile.parameters.creativity}`,
    `Technical depth: ${profile.parameters.technicalDepth}`,
    `Tone: ${profile.parameters.tone}`,
    `CTA style: ${profile.parameters.ctaStyle}`,
    `Product specificity: ${profile.parameters.productSpecificity}`,
    `Reward emphasis: ${profile.parameters.rewardEmphasis}`,
    `Audience: ${profile.parameters.audience}`,
    `Layout: ${profile.parameters.layout}`,
    layoutInstruction(profile.parameters.layout),
    ctaInstruction(profile)
  ].join("\n");
}

export function layoutInstruction(layout: LayoutVariant): string {
  switch (layout) {
    case "regular_paragraph":
      return "Layout instruction: write compact regular prose; no bullets unless absolutely necessary.";
    case "structured_bullets":
      return "Layout instruction: use short structured bullets when the venue supports them.";
    case "short_hook_then_detail":
      return "Layout instruction: open with a short hook, then one practical detail.";
    case "question_answer":
      return "Layout instruction: frame the answer as a direct question-and-answer response.";
    case "problem_solution":
      return "Layout instruction: state the problem, then the practical solution.";
  }
}

function ctaInstruction(profile: ResolvedPromptProfile): string {
  switch (profile.cta.requirement) {
    case "required":
      return `CTA instruction: include exactly one tracked CTA URL at the ${profile.cta.placement === "end" ? "end" : "after the first paragraph"}.`;
    case "optional":
      return "CTA instruction: include a CTA only when the venue and prompt context make it natural.";
    case "forbidden":
      return "CTA instruction: do not include links, CTAs, demo offers, or DM prompts.";
  }
}

function extractUrls(content: string): string[] {
  return [...content.matchAll(/(?:https?:\/\/|www\.)[^\s<>"'`]+/gi)].map((match) =>
    normalizeDetectedUrl(match[0])
  );
}

function normalizeDetectedUrl(value: string): string {
  return value.replace(/[),.;!?]+$/u, "");
}

export function structuralFingerprint(value: string): string {
  const lines = value
    .trim()
    .split(/\n+/)
    .map((line) => {
      const trimmed = line.trim();
      if (/^[-*]\s+/.test(trimmed)) {
        return "bullet";
      }
      if (/^#{1,6}\s+/.test(trimmed)) {
        return "heading";
      }
      if (trimmed.includes("?")) {
        return "question";
      }
      if (/https?:\/\//i.test(trimmed)) {
        return "link";
      }
      return `sentence:${Math.min(trimmed.split(/\s+/).length, 20)}`;
    });

  return lines.join("|").slice(0, 180);
}

export function contentTokenSimilarity(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / (leftTokens.size + rightTokens.size - overlap);
}

function tokenSet(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter(
      (token) => !["that", "this", "with", "from", "they", "your", "what", "when"].includes(token)
    )
  );
}
