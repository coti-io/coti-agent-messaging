import { buildMainLlmProvider, type MoltbookRuntimeConfig } from "./config.js";
import {
  filterPromptParameterOverrides,
  layoutInstruction,
  maxCharsForResponseLength,
  promptProfileToPromptText,
  resolvePromptProfile,
  validateDraftAgainstPromptProfile,
  type PromptParameterSet,
  type ResolvedPromptProfile
} from "./prompt-profile.js";
import type { RedditReviewItem, RedditOutreachTargeting } from "./reddit-outreach.js";

export interface RedditDraftInput {
  config: MoltbookRuntimeConfig;
  item: RedditReviewItem;
  targeting: RedditOutreachTargeting;
  actionType?: "comment_on_post" | "reply_to_activity";
  recentContent?: readonly string[];
  promptVariantId?: string;
  promptParameterOverrides?: Partial<PromptParameterSet>;
  fetchImpl?: typeof fetch;
}

interface RedditDraftResponse {
  content?: string;
  rationale?: string;
}

const FORBIDDEN_MARKETING_PATTERNS = [
  /https?:\/\//i,
  /\bwww\./i,
  /\bcheck (?:this|it|us|out)\b/i,
  /\bsign up\b/i,
  /\bbook (?:a )?(?:demo|call)\b/i,
  /\b(?:dm|pm) me\b/i,
  /\bmessage me\b/i,
  /\btry (?:our|my)\b/i
] as const;

const MAX_LLM_DRAFT_ATTEMPTS = 3;

const FORBIDDEN_MARKETING_PHRASES = [
  "http:// or https:// URLs",
  "www.",
  "check this / check it / check us / check out",
  "sign up",
  "book a demo / book a call",
  "dm me / pm me",
  "message me",
  "try our / try my"
] as const;

const STANDALONE_FLUFF_EXAMPLES = [
  "yeah",
  "yep",
  "fair",
  "agreed",
  "good point",
  "great point",
  "interesting",
  "exactly",
  "this"
] as const;

export interface RedditDraftValidationSpec {
  maxCharacters: number;
  responseLength: PromptParameterSet["responseLength"];
  layout: PromptParameterSet["layout"];
  humor: PromptParameterSet["humor"];
  ctaLinks: "forbidden";
  forbiddenProductAliases: readonly string[];
  forbiddenMarketingPhrases: readonly string[];
  layoutRules: readonly string[];
  substanceRules: readonly string[];
  checklist: readonly string[];
}

export function buildRedditDraftValidationSpec(input: {
  profile: ResolvedPromptProfile;
  productAliases: readonly string[];
  maxChars: number;
}): RedditDraftValidationSpec {
  const { profile, productAliases, maxChars } = input;
  const layout = profile.parameters.layout;
  const layoutRules: string[] = [
    `Total length must be <= ${maxChars} characters (responseLength=${profile.parameters.responseLength}).`,
    "No URLs, no www, no signup/demo/DM/CTA language.",
    productAliases.length > 0
      ? `Do not mention these product/company strings (case-insensitive): ${productAliases.join(", ")}.`
      : "Do not mention product or company names.",
    `Never end with standalone fluff only (${STANDALONE_FLUFF_EXAMPLES.join(", ")}).`,
    profile.parameters.humor === "none"
      ? "No forced jokes or sarcasm."
      : "Humor only if it sharpens a useful point; never punch down."
  ];

  if (layout === "short_hook_then_detail") {
    layoutRules.push(
      `Minimum ${100} characters total.`,
      `Sentence 1 (hook): <= ${HOOK_UNIT_MAX_CHARS} characters and <= 22 words; brief acknowledgment, not the full answer.`,
      `After the hook: >= ${SUBSTANCE_MIN_CHARS} characters OR >= 10 words OR concrete technical terms (auth, MCP, OAuth, agent, encrypt, trust boundary, etc.).`,
      "At least 2 sentences (or 2 paragraphs); never stop after the hook alone.",
      "Good hook examples: 'Fair point.', 'Yeah —', 'The tricky part is', 'In practice,'."
    );
  } else {
    layoutRules.push(layoutInstruction(layout));
  }

  const substanceRules = [
    "Answer the thread's concrete question or pain; peer operator tone, not marketing.",
    "Do not copy or lightly paraphrase recentOutbound entries.",
    profile.cta.requirement === "forbidden" ? "CTA/links are forbidden for Reddit." : "Follow CTA rules from prompt profile."
  ];

  const checklist = [
    `characterCount <= ${maxChars}`,
    "noLinksOrCtaLanguage",
    "noForbiddenProductAliases",
    layout === "short_hook_then_detail" ? "hookThenSubstanceLayout" : `layout:${layout}`,
    "notStandaloneFluff",
    "usefulToThread"
  ];

  return {
    maxCharacters: maxChars,
    responseLength: profile.parameters.responseLength,
    layout,
    humor: profile.parameters.humor,
    ctaLinks: "forbidden",
    forbiddenProductAliases: productAliases,
    forbiddenMarketingPhrases: FORBIDDEN_MARKETING_PHRASES,
    layoutRules,
    substanceRules,
    checklist
  };
}

export function redditDraftValidationSpecToPromptText(spec: RedditDraftValidationSpec): string {
  return [
    "VALIDATION CHECKLIST — the content field must pass every rule or it will be rejected:",
    ...spec.checklist.map((entry) => `- ${entry}`),
    `Hard max: ${spec.maxCharacters} characters.`,
    ...spec.layoutRules.map((rule) => `- ${rule}`),
    ...spec.substanceRules.map((rule) => `- ${rule}`)
  ].join("\n");
}

export class RedditDraftGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedditDraftGenerationError";
  }
}

export async function draftRedditResponse(input: RedditDraftInput): Promise<{
  content: string;
  rationale: string;
  promptProfileId: string;
  promptParameters: PromptParameterSet;
  layout: PromptParameterSet["layout"];
}> {
  const llmProvider = buildMainLlmProvider(input.config, input.fetchImpl);
  if (!llmProvider) {
    throw new RedditDraftGenerationError("Reddit draft generation requires an LLM provider.");
  }

  const actionType = input.actionType ?? "reply_to_activity";
  const variantOverrides = input.promptParameterOverrides;
  const resolvedProfile = resolvePromptProfile({
    venue: "reddit",
    actionType,
    profile: input.config.promptProfile,
    profileId: input.config.promptProfileId,
    parameterOverrides: filterPromptParameterOverrides(
      input.config.promptProfile,
      "reddit",
      actionType,
      variantOverrides
    )
  });
  const maxChars = maxCharsForResponseLength(resolvedProfile.parameters.responseLength, "reddit");

  let lastError: Error | undefined;
  let lastContent: string | undefined;
  let strictLength = false;
  let retryReason: string | undefined;

  for (let attempt = 0; attempt < MAX_LLM_DRAFT_ATTEMPTS; attempt += 1) {
    const llmDraft = await requestRedditLlmDraft({
      llmProvider,
      draftInput: input,
      resolvedProfile,
      maxChars,
      strictLength,
      retryReason
    });
    const content = llmDraft?.trim();
    if (!content) {
      lastError = new RedditDraftGenerationError("Reddit LLM draft returned empty content.");
      retryReason = lastError.message;
      continue;
    }
    lastContent = content;

    try {
      validateRedditDraft(content, input.targeting.productAliases, resolvedProfile);
      return {
        content,
        rationale: "LLM drafted a zero-marketing Reddit response.",
        promptProfileId: resolvedProfile.id,
        promptParameters: resolvedProfile.parameters,
        layout: resolvedProfile.parameters.layout
      };
    } catch (error) {
      if (isRedditDraftForbiddenError(error)) {
        throw error;
      }
      lastError = error instanceof Error ? error : new RedditDraftGenerationError(String(error));
      retryReason = formatRedditDraftRetryReason(lastError.message, resolvedProfile.parameters.layout);
      strictLength = isRedditDraftLengthError(error);
    }
  }

  if (lastContent && isRedditDraftLengthError(lastError)) {
    const trimmed = trimRedditDraftToMax(lastContent, maxChars);
    try {
      validateRedditDraft(trimmed, input.targeting.productAliases, resolvedProfile);
      return {
        content: trimmed,
        rationale: "LLM draft trimmed to venue length cap after validation retries.",
        promptProfileId: resolvedProfile.id,
        promptParameters: resolvedProfile.parameters,
        layout: resolvedProfile.parameters.layout
      };
    } catch {
      // fall through to error below
    }
  }

  throw new RedditDraftGenerationError(
    `Reddit draft generation failed after ${MAX_LLM_DRAFT_ATTEMPTS} LLM attempts: ${lastError?.message ?? "unknown error"}`
  );
}

export function validateRedditDraft(
  content: string,
  productAliases: readonly string[] = [],
  profile: ResolvedPromptProfile = resolvePromptProfile({
    venue: "reddit",
    actionType: "reply_to_activity"
  })
): void {
  validateDraftAgainstPromptProfile(profile, content);
  const maxChars = maxCharsForResponseLength(profile.parameters.responseLength, "reddit");
  if (content.length > maxChars) {
    throw new Error(
      `Reddit draft exceeds ${profile.parameters.responseLength} length limit (${content.length}/${maxChars} chars).`
    );
  }
  const layout = profile.parameters.layout;
  if (FORBIDDEN_MARKETING_PATTERNS.some((pattern) => pattern.test(content))) {
    throw new Error("Reddit draft contains forbidden marketing, link, CTA, or DM language.");
  }
  const normalized = content.toLowerCase();
  if (productAliases.some((alias) => normalized.includes(alias.toLowerCase()))) {
    throw new Error("Reddit draft mentions a product/company alias.");
  }
  if (looksLikeStandaloneFluff(content)) {
    throw new Error("Reddit draft is too fluffy and does not contain enough useful substance.");
  }
  if (layout === "short_hook_then_detail" && !hasHookThenSubstance(content)) {
    throw new Error("Reddit hook-style draft must open briefly and then deliver useful substance.");
  }
}

function summarizeRecentOutbound(recentContent: readonly string[]): string[] {
  return recentContent
    .filter((entry) => entry.trim().length > 0)
    .slice(-8)
    .map((entry) => entry.trim().slice(0, 160));
}

async function requestRedditLlmDraft(params: {
  llmProvider: NonNullable<ReturnType<typeof buildMainLlmProvider>>;
  draftInput: RedditDraftInput;
  resolvedProfile: ResolvedPromptProfile;
  maxChars: number;
  strictLength: boolean;
  retryReason?: string;
}): Promise<string | undefined> {
  const recentOutbound = summarizeRecentOutbound(params.draftInput.recentContent ?? []);
  const validationSpec = buildRedditDraftValidationSpec({
    profile: params.resolvedProfile,
    productAliases: params.draftInput.targeting.productAliases,
    maxChars: params.maxChars
  });
  const validationPrompt = redditDraftValidationSpecToPromptText(validationSpec);
  const lengthInstruction = params.strictLength
    ? `Your previous draft was too long. Rewrite shorter: stay under ${params.maxChars} characters with no filler.`
    : undefined;
  const retryInstruction = params.retryReason
    ? `Previous draft failed validation: ${params.retryReason}`
    : undefined;
  const response = await params.llmProvider.createJsonCompletion<RedditDraftResponse>([
    {
      role: "system",
      content: [
        "You write Reddit comments as a practical operator, not a marketer.",
        "Be useful first. Answer the concrete operational pain in this thread.",
        "Sound like a human peer: specific, natural, grounded in what was asked.",
        "Do not repeat yourself too much across replies — vary openers, examples, and structure.",
        recentOutbound.length > 0
          ? "recentOutbound lists your recent comments; use them for context but do not copy or lightly paraphrase them."
          : undefined,
        "Before returning JSON, self-check content against validation in the user message.",
        validationPrompt,
        lengthInstruction,
        retryInstruction,
        promptProfileToPromptText(params.resolvedProfile),
        "Return strict JSON with keys: content (passes all validation), rationale (why it passes)."
      ]
        .filter(Boolean)
        .join("\n")
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          subreddit: params.draftInput.item.source.subreddit,
          title: params.draftInput.item.source.title,
          body: params.draftInput.item.source.body,
          parentTitle: params.draftInput.item.source.parentTitle,
          whyRelevant: params.draftInput.item.whyRelevant,
          recentOutbound,
          validation: validationSpec
        },
        null,
        2
      )
    }
  ]);
  return response.content?.trim();
}

function formatRedditDraftRetryReason(message: string, layout: PromptParameterSet["layout"]): string {
  if (layout !== "short_hook_then_detail" || !/hook-style|fluffy|substance/i.test(message)) {
    return message;
  }
  return `${message} Rewrite with: (1) one short hook sentence, then (2) at least two sentences of concrete helpful detail — names, tradeoffs, or steps from the thread topic.`;
}

function isRedditDraftLengthError(error: unknown): boolean {
  return error instanceof Error && /length limit|exceeds .* chars/i.test(error.message);
}

function isRedditDraftForbiddenError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /forbidden marketing|product\/company alias|mentions a product/i.test(error.message)
  );
}

function looksLikeStandaloneFluff(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length >= 90) {
    return false;
  }
  return /^(?:yeah|yep|fair|true|agreed|good point|great point|interesting|exactly|this)\b[.! ]*$/i.test(trimmed);
}

const HOOK_UNIT_MAX_CHARS = 110;
const SUBSTANCE_MIN_CHARS = 55;
const SUBSTANCE_SIGNAL_PATTERN =
  /\b(?:because|when|if|usually|practice|issue|problem|boundary|auth|cred|token|flow|server|client|agent|mcp|oauth|encrypt|route|channel|check|audit|deploy|tool|runtime|trust|local|remote|pattern|approach|tradeoff|fail|broker|harness|scope|permission)\b/i;

function hasHookThenSubstance(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 100) {
    return false;
  }

  const paragraphs = trimmed
    .split(/\n\s*\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (paragraphs.length >= 2) {
    const opener = paragraphs[0] ?? "";
    const body = paragraphs.slice(1).join("\n\n");
    return isHookUnit(opener) && hasUsefulSubstance(body);
  }

  const sentences = trimmed
    .split(/(?<=[.!?])\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (sentences.length < 2) {
    return false;
  }
  const firstSentence = sentences[0] ?? "";
  const remainder = sentences.slice(1).join(" ");
  return isHookUnit(firstSentence) && hasUsefulSubstance(remainder);
}

function isHookUnit(unit: string): boolean {
  const trimmed = unit.trim();
  if (!trimmed || trimmed.length > HOOK_UNIT_MAX_CHARS) {
    return false;
  }
  if (looksLikeStandaloneFluff(trimmed)) {
    return false;
  }
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  return words <= 22;
}

function trimRedditDraftToMax(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content.trim();
  }
  let trimmed = content.slice(0, maxChars);
  const sentenceBreak = Math.max(
    trimmed.lastIndexOf(". "),
    trimmed.lastIndexOf("! "),
    trimmed.lastIndexOf("? ")
  );
  if (sentenceBreak >= Math.floor(maxChars * 0.55)) {
    return trimmed.slice(0, sentenceBreak + 1).trim();
  }
  const wordBreak = trimmed.lastIndexOf(" ");
  if (wordBreak >= Math.floor(maxChars * 0.7)) {
    return trimmed.slice(0, wordBreak).trim();
  }
  return trimmed.trim();
}

function hasUsefulSubstance(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < SUBSTANCE_MIN_CHARS) {
    return false;
  }
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  return wordCount >= 10 || SUBSTANCE_SIGNAL_PATTERN.test(trimmed);
}
