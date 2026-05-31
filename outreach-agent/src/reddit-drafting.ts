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

export async function draftRedditResponse(input: RedditDraftInput): Promise<{
  content: string;
  rationale: string;
  promptProfileId: string;
  promptParameters: PromptParameterSet;
  layout: PromptParameterSet["layout"];
}> {
  const llmProvider = buildMainLlmProvider(input.config, input.fetchImpl);
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
  const fallback = trimDraftToLength(
    input.item.draft ?? deterministicDraft(input.item, resolvedProfile),
    resolvedProfile
  );
  let content = fallback;
  if (llmProvider) {
    const firstDraft = await requestRedditLlmDraft({
      llmProvider,
      draftInput: input,
      resolvedProfile,
      maxChars,
      strictLength: false
    });
    content = firstDraft?.trim() || fallback;
    try {
      validateRedditDraft(content, input.targeting.productAliases, resolvedProfile);
    } catch (error) {
      if (isRedditDraftForbiddenError(error)) {
        throw error;
      }
      const retryDraft = await requestRedditLlmDraft({
        llmProvider,
        draftInput: input,
        resolvedProfile,
        maxChars,
        strictLength: isRedditDraftLengthError(error)
      });
      content = retryDraft?.trim() || fallback;
      try {
        validateRedditDraft(content, input.targeting.productAliases, resolvedProfile);
      } catch (retryError) {
        if (isRedditDraftForbiddenError(retryError)) {
          throw retryError;
        }
        content = coerceValidRedditDraft(fallback, input.targeting.productAliases, resolvedProfile);
      }
    }
  } else {
    validateRedditDraft(content, input.targeting.productAliases, resolvedProfile);
  }
  return {
    content,
    rationale: llmProvider ? "LLM drafted a zero-marketing Reddit response." : "Used deterministic zero-marketing fallback draft.",
    promptProfileId: resolvedProfile.id,
    promptParameters: resolvedProfile.parameters,
    layout: resolvedProfile.parameters.layout
  };
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

async function requestRedditLlmDraft(params: {
  llmProvider: NonNullable<ReturnType<typeof buildMainLlmProvider>>;
  draftInput: RedditDraftInput;
  resolvedProfile: ResolvedPromptProfile;
  maxChars: number;
  strictLength: boolean;
}): Promise<string | undefined> {
  const lengthInstruction = params.strictLength
    ? `Your previous draft was too long. Rewrite shorter: stay under ${params.maxChars} characters with no filler.`
    : `Hard cap: keep content under ${params.maxChars} characters.`;
  const response = await params.llmProvider.createJsonCompletion<RedditDraftResponse>([
    {
      role: "system",
      content: [
        "You write Reddit comments as a practical operator, not a marketer.",
        "Zero direct marketing. No product name. No company name. No links. No CTA. No DM request.",
        "Be useful first. Answer the concrete day-to-day operational pain.",
        "A short opener is allowed only when it is immediately followed by concrete substance in the same reply.",
        "Never write standalone fluff like 'great point' or 'interesting take' by itself.",
        "Prefer concise, natural peer tone over polished essay copy or consultant cadence.",
        params.resolvedProfile.parameters.humor === "none"
          ? "Do not force humor."
          : "Humor is allowed only when it sharpens the point; never at the OP's expense.",
        lengthInstruction,
        promptProfileToPromptText(params.resolvedProfile),
        "Return strict JSON with keys: content, rationale."
      ].join(" ")
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
          recentContent: params.draftInput.recentContent ?? [],
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

function coerceValidRedditDraft(
  preferred: string,
  productAliases: readonly string[],
  profile: ResolvedPromptProfile
): string {
  for (const candidate of [
    preferred,
    trimDraftToLength(
      formatDeterministicSentences(
        [
          "The pattern I have seen work is to keep the process small enough that someone can still reason about it.",
          "Define the trigger, the data it is allowed to touch, the failure mode, and who gets notified."
        ],
        profile.parameters.layout
      ),
      profile
    ),
    trimDraftToLength(
      formatDeterministicSentences(
        [
          "The pattern I have seen work is to keep the process small enough that someone can still reason about it.",
          "Define the trigger, the data it is allowed to touch, the failure mode, and who gets notified."
        ],
        "short_hook_then_detail"
      ),
      profile
    )
  ]) {
    try {
      validateRedditDraft(candidate, productAliases, profile);
      return candidate;
    } catch (error) {
      if (isRedditDraftForbiddenError(error)) {
        throw error;
      }
    }
  }
  throw new Error("Reddit draft could not be coerced into a valid response.");
}

function deterministicDraft(item: RedditReviewItem, profile: ResolvedPromptProfile): string {
  const text = [item.source.parentTitle, item.source.title, item.source.body].filter(Boolean).join(" ").toLowerCase();
  if (/\bcrm\b|\bduplicate|data quality|handoff/.test(text)) {
    return trimDraftToLength(
      formatDeterministicSentences(
        [
          "I would start by treating this as a data ownership problem, not an automation problem.",
          "Pick one source of truth, define who can change each field, and log every automated write somewhere a human can audit.",
          "Most CRM cleanup loops fail because nobody can tell whether the automation made the record better or just moved the mess around."
        ],
        profile.parameters.layout
      ),
      profile
    );
  }
  if (/\bworkflow|manual|spreadsheet|ops?\b/.test(text)) {
    return trimDraftToLength(
      formatDeterministicSentences(
        [
          "The useful first step is mapping the handoff, not replacing the whole workflow.",
          "Find where people copy data between tools, then automate only the boring validation and routing pieces.",
          "That keeps failures visible instead of turning the process into a black box."
        ],
        profile.parameters.layout
      ),
      profile
    );
  }
  if (/\bautomation\b|\bfailing|incident|debug/.test(text)) {
    return trimDraftToLength(
      formatDeterministicSentences(
        [
          "Automation needs a boring fallback path or it eventually becomes another incident source.",
          "Log the input, the decision, the write it attempted, and why it skipped or failed.",
          "That makes the system debuggable when the happy path breaks."
        ],
        profile.parameters.layout
      ),
      profile
    );
  }
  const sentences = [
    "The pattern I have seen work is to keep the process small enough that someone can still reason about it.",
    "Define the trigger, the data it is allowed to touch, the failure mode, and who gets notified.",
    "Once that is clear, the tooling choice matters a lot less."
  ];
  return trimDraftToLength(formatDeterministicSentences(sentences, profile.parameters.layout), profile);
}

function formatDeterministicSentences(sentences: string[], layout: PromptParameterSet["layout"]): string {
  if (layout === "question_answer") {
    return [`Short answer: ${sentences[0]}`, sentences[1]].join(" ");
  }
  if (layout === "problem_solution") {
    return [`Problem: ${sentences[0]}`, `Fix: ${sentences[1]}`].join(" ");
  }
  if (layout === "short_hook_then_detail") {
    return ["Fair point.", sentences[0], sentences[1]].filter(Boolean).join(" ");
  }
  return sentences.slice(0, 2).join(" ");
}

function trimDraftToLength(content: string, profile: ResolvedPromptProfile): string {
  const maxChars = maxCharsForResponseLength(profile.parameters.responseLength, "reddit");
  if (content.length <= maxChars) {
    return content;
  }
  const trimmed = content.slice(0, maxChars - 1).trimEnd();
  const lastSentenceEnd = Math.max(trimmed.lastIndexOf("."), trimmed.lastIndexOf("!"), trimmed.lastIndexOf("?"));
  if (lastSentenceEnd > maxChars * 0.55) {
    return trimmed.slice(0, lastSentenceEnd + 1);
  }
  return `${trimmed}…`;
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
    /^(?:fair|yeah|agreed|exactly|the real issue|the bigger problem|the part that(?: usually)? breaks|what usually fails)/i.test(
      firstSentence
    );
  return hookLike && remainder.length >= 80;
}
