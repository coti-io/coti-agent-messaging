import { buildMainLlmProvider, type MoltbookRuntimeConfig } from "./config.js";
import {
  filterPromptParameterOverrides,
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
      retryReason = lastError.message;
      strictLength = isRedditDraftLengthError(error);
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
  const lengthInstruction = params.strictLength
    ? `Your previous draft was too long. Rewrite shorter: stay under ${params.maxChars} characters with no filler.`
    : `Hard cap: keep content under ${params.maxChars} characters.`;
  const retryInstruction = params.retryReason
    ? `Previous draft failed validation: ${params.retryReason}`
    : undefined;
  const response = await params.llmProvider.createJsonCompletion<RedditDraftResponse>([
    {
      role: "system",
      content: [
        "You write Reddit comments as a practical operator, not a marketer.",
        "Zero direct marketing. No product name. No company name. No links. No CTA. No DM request.",
        "Be useful first. Answer the concrete operational pain in this thread.",
        "Sound like a human peer: specific, natural, grounded in what was asked.",
        "Do not repeat yourself too much across replies — vary openers, examples, and structure.",
        recentOutbound.length > 0
          ? "recentOutbound lists your recent comments; use them for context but do not copy or lightly paraphrase them."
          : undefined,
        "A short opener is fine when followed immediately by concrete substance.",
        "Never write standalone fluff like 'great point' by itself.",
        "Prefer concise peer tone over polished consultant copy.",
        params.resolvedProfile.parameters.humor === "none"
          ? "Do not force humor."
          : "Humor is allowed only when it sharpens the point; never at the OP's expense.",
        lengthInstruction,
        retryInstruction,
        promptProfileToPromptText(params.resolvedProfile),
        "Return strict JSON with keys: content, rationale."
      ]
        .filter(Boolean)
        .join(" ")
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
          forbiddenProductAliases: params.draftInput.targeting.productAliases
        },
        null,
        2
      )
    }
  ]);
  return response.content?.trim();
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

function hasHookThenSubstance(content: string): boolean {
  const sentences = content
    .split(/(?<=[.!?])\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (sentences.length < 2) {
    return false;
  }
  const firstSentence = sentences[0] ?? "";
  const remainder = sentences.slice(1).join(" ");
  const hookLike =
    firstSentence.length <= 80 &&
    /^(?:fair|yeah|agreed|exactly|the real issue|the bigger problem|the part that(?: usually)? breaks|what usually fails|what i'd watch|in practice)/i.test(
      firstSentence
    );
  return hookLike && remainder.length >= 80;
}
