import { randomUUID } from "node:crypto";

import { buildMainLlmProvider, type MoltbookRuntimeConfig } from "./config.js";
import { saveOutreachRefToAttributionStore } from "./attribution-store.js";
import type { JsonLlmProvider } from "./llm-client.js";
import type { MoltbookPost } from "./moltbook-api.js";
import { buildOutreachRef, buildTrackedLink, type CtaLink, type OutreachRef } from "./outreach-attribution.js";
import type { ProductFactSheet } from "./product-facts.js";
import { contentFingerprint, type OutreachAgentState, type ReplyTarget } from "./policy.js";
import {
  contentTokenSimilarity,
  filterPromptParameterOverrides,
  promptProfileToPromptText,
  resolvePromptProfile,
  structuralFingerprint,
  validateDraftAgainstPromptProfile,
  validatePromptProfile,
  type LayoutVariant,
  type PromptParameterSet,
  type ResolvedPromptProfile
} from "./prompt-profile.js";
import { selectPromptVariant } from "./prompt-rotation.js";
import { buildRepoContext } from "./repo-context.js";

export type WriteCandidate =
  | {
      id: string;
      type: "create_post";
      reason: string;
    }
  | {
      id: string;
      type: "comment_on_post";
      reason: string;
      post: MoltbookPost;
    }
  | {
      id: string;
      type: "reply_to_activity";
      reason: string;
      postId: string;
      postTitle: string;
      target: ReplyTarget;
    };

export interface GeneratedWriteDecision {
  selectedCandidateId: string;
  title?: string;
  content: string;
  rationale: string;
  fingerprint: string;
  promptProfileId?: string;
  promptVariantId?: string;
  promptVariantRationale?: string;
  promptParameters?: PromptParameterSet;
  layout?: LayoutVariant;
  ctaUrl?: string;
  outreachRef?: OutreachRef;
  structuralFingerprint?: string;
  promptRotationReusedExisting?: boolean;
  promptRotateAfterActions?: number;
}

const MAX_POST_TITLE_CHARS = 110;
const MAX_POST_CONTENT_CHARS = 1_100;
const MAX_REPLY_OR_COMMENT_CHARS = 700;
const DUPLICATE_DRAFT_ERROR_PATTERN =
  /^Generated content is too similar to recent authored (?:history|artifact\b)/;
const MISSING_PROOF_POINT_ERROR_PATTERN =
  /^Generated post is missing a concrete proof point\b/;
const EXPLICIT_RESOURCE_REQUEST_PATTERNS = [
  /\b(?:link|docs?|documentation|repo|repository|quickstart|guide|tutorial|walkthrough|example|sample|how[- ]to)\b.{0,24}\?/i,
  /\b(?:can you|could you|would you|do you have|got|share|send|drop|post|show)\b.{0,40}\b(?:link|docs?|documentation|repo|repository|quickstart|guide|tutorial|walkthrough|example|sample)\b/i,
  /\bhow\s+(?:do|would)\s+(?:i|we)\b/i,
  /\bwhere\s+can\s+(?:i|we)\b.{0,24}\b(?:read|learn|find|get)\b/i,
  /\b(?:looking for|need|want)\b.{0,24}\b(?:docs?|documentation|repo|repository|quickstart|guide|tutorial|walkthrough|example|sample)\b/i
] as const;

interface LlmReplyGateResponse {
  selectedCommentId: string;
  rationale?: string;
}

interface LlmSelectionResponse {
  selectedCandidateId: string;
  rationale?: string;
}

interface LlmDraftResponse {
  selectedCandidateId: string;
  title?: string;
  content?: string;
  rationale?: string;
}

interface LabeledCandidate {
  label: string;
  candidate: WriteCandidate;
}

export function isDuplicateDraftError(error: unknown): boolean {
  return error instanceof Error && DUPLICATE_DRAFT_ERROR_PATTERN.test(error.message);
}

export function isMissingConcreteProofPointError(error: unknown): boolean {
  return error instanceof Error && MISSING_PROOF_POINT_ERROR_PATTERN.test(error.message);
}

const PROMPT_VERSION = "v4-coti-attribution";
const BASE_PERSONALITY = [
  "Voice: technical realist.",
  "Sound like an engineer who has shipped systems, seen hype fail, and prefers explicit tradeoffs over grand claims.",
  "Be direct, calm, skeptical of hand-wavy language, and concrete without sounding like docs."
].join(" ");
const REPLY_PERSONALITY = [
  "Replies should add a measured contrarian edge.",
  "Start by meeting the other person's actual point, then sharpen or reframe it.",
  "Do not posture. Do not rant. Do not sound like a pitch deck."
].join(" ");

export async function chooseReplyTargetOrIgnore(
  config: MoltbookRuntimeConfig,
  input: {
    postTitle: string;
    targets: readonly ReplyTarget[];
  },
  factSheet: ProductFactSheet,
  state: OutreachAgentState,
  fetchImpl?: typeof fetch
): Promise<{
  target?: ReplyTarget;
  rationale: string;
}> {
  if (input.targets.length === 0) {
    return {
      rationale: "No reply candidates were available."
    };
  }

  const llmProvider = buildMainLlmProvider(config, fetchImpl);
  if (!llmProvider) {
    return {
      target: input.targets[0],
      rationale: "No LLM provider configured; falling back to the highest-ranked reply candidate."
    };
  }

  const relevantClaims = selectRelevantClaims(
    factSheet,
    `${input.postTitle}\n${input.targets.map((target) => target.content).join("\n")}`
  );
  const response = await llmProvider.createJsonCompletion<LlmReplyGateResponse>([
    {
      role: "system",
      content: [
        `Prompt version: ${PROMPT_VERSION}.`,
        BASE_PERSONALITY,
        "You are gating reply candidates on our own Moltbook thread.",
        "Your job is to decide whether to reply at all, and if so choose the single best comment to reply to.",
        "Ignore generic praise, hype, ecosystem slogans, drive-by compliments, obvious spam, and comments that do not engage the post's actual topic.",
        "Reply only when a comment asks a concrete question, makes a substantive on-topic claim, raises a useful objection, or creates a real opening for a sharp response.",
        'Return strict JSON with keys: selectedCommentId, rationale. Use "ignore" exactly when none of the candidates deserve a reply.'
      ].join(" ")
    },
    {
      role: "user",
      content: [
        "Post title:",
        input.postTitle,
        "",
        "Reply candidates:",
        JSON.stringify(
          input.targets.map((target) => ({
            commentId: target.commentId,
            authorName: target.authorName ?? "commenter",
            content: target.content
          })),
          null,
          2
        ),
        "",
        "Grounded product claims that may matter if the comment is actually relevant:",
        JSON.stringify(relevantClaims, null, 2),
        "",
        "Recent authored history to avoid echoing too closely:",
        buildRecentHistorySummary(state)
      ].join("\n")
    }
  ]);

  if (response.selectedCommentId === "ignore") {
    return {
      rationale: response.rationale?.trim() || "LLM judged every reply candidate too low-signal to answer."
    };
  }

  const target = input.targets.find((entry) => entry.commentId === response.selectedCommentId);
  if (!target) {
    throw new Error(
      `LLM selected an unknown reply target: ${response.selectedCommentId}. Valid ids: ${input.targets
        .map((entry) => entry.commentId)
        .join(", ")}`
    );
  }

  return {
    target,
    rationale: response.rationale?.trim() || "LLM selected the most reply-worthy candidate."
  };
}

export async function chooseAndDraftWriteAction(
  config: MoltbookRuntimeConfig,
  candidates: readonly WriteCandidate[],
  factSheet: ProductFactSheet,
  state: OutreachAgentState,
  fetchImpl?: typeof fetch
): Promise<GeneratedWriteDecision> {
  const llmProvider = buildMainLlmProvider(config, fetchImpl);
  if (!llmProvider) {
    throw new Error(
      "LLM content generation requires an injected provider or MOLTBOOK_LLM_API_KEY/OPENROUTER_API_KEY."
    );
  }

  if (candidates.length === 0) {
    throw new Error("No write candidates were provided to the LLM writer.");
  }

  const queryText = [
    ...candidates.map((candidate) => candidateToQueryText(candidate)),
    ...state.recentGeneratedArtifacts.map((artifact) => `${artifact.title ?? ""} ${artifact.content}`)
  ].join("\n");
  const repoContext = await buildRepoContext(config.projectRoot, queryText);
  const labeledCandidates = candidates.map((candidate, index) => ({
    label: candidateLabelForIndex(index),
    candidate
  }));
  const selection = await chooseCandidate(llmProvider, labeledCandidates, factSheet, state, repoContext);
  const selectedLabeledCandidate = labeledCandidates.find(
    (entry) => entry.label === selection.selectedCandidateId
  );
  if (!selectedLabeledCandidate) {
    throw new Error(
      `LLM selected an unknown candidate label: ${selection.selectedCandidateId}. Valid labels: ${labeledCandidates
        .map((entry) => entry.label)
        .join(", ")}`
    );
  }
  const selectedCandidate = selectedLabeledCandidate.candidate;
  const selectedVariant = await selectPromptVariant({
    config,
    venue: "moltbook",
    actionType: selectedCandidate.type,
    fetchImpl
  });
  const resolvedProfile = resolvePromptProfile({
    venue: "moltbook",
    actionType: selectedCandidate.type,
    profile: config.promptProfile,
    profileId: config.promptProfileId,
    parameterOverrides: filterPromptParameterOverrides(
      config.promptProfile,
      "moltbook",
      selectedCandidate.type,
      selectedVariant.parameterOverrides
    ),
    ctaBaseUrl: config.ctaBaseUrl,
    approvedDomains: config.ctaApprovedDomains
  });
  validatePromptProfile(resolvedProfile);
  const ctaLink = buildCandidateCtaLink(config, selectedCandidate, resolvedProfile);
  const response = await draftCandidate(
    llmProvider,
    selectedLabeledCandidate.label,
    selectedCandidate,
    selection.rationale,
    factSheet,
    state,
    repoContext,
    resolvedProfile,
    ctaLink
  );
  try {
    return await finalizeGeneratedDecision({
      config,
      selectedCandidate,
      response,
      selectionRationale: selection.rationale,
      state,
      resolvedProfile,
      ctaLink,
      selectedVariant
    });
  } catch (error) {
    if (!(selectedCandidate.type === "create_post" && isMissingConcreteProofPointError(error))) {
      throw error;
    }
  }

  const repairedResponse = await repairDraftCandidateForProofPoint(
    llmProvider,
    selectedLabeledCandidate.label,
    selectedCandidate,
    selection.rationale,
    factSheet,
    state,
    repoContext,
    resolvedProfile,
    ctaLink,
    response
  );
  return await finalizeGeneratedDecision({
    config,
    selectedCandidate,
    response: repairedResponse,
    selectionRationale: [selection.rationale, response.rationale].filter(Boolean).join(" ").trim(),
    state,
    resolvedProfile,
    ctaLink,
    selectedVariant
  });
}

async function chooseCandidate(
  llmProvider: JsonLlmProvider,
  labeledCandidates: readonly LabeledCandidate[],
  factSheet: ProductFactSheet,
  state: OutreachAgentState,
  repoContext: Awaited<ReturnType<typeof buildRepoContext>>
): Promise<LlmSelectionResponse> {
  return llmProvider.createJsonCompletion<LlmSelectionResponse>([
    {
      role: "system",
      content: buildSelectionSystemPrompt()
    },
    {
      role: "user",
      content: buildSelectionUserPrompt(labeledCandidates, factSheet, state, repoContext)
    }
  ]);
}

async function draftCandidate(
  llmProvider: JsonLlmProvider,
  candidateLabel: string,
  candidate: WriteCandidate,
  selectionRationale: string | undefined,
  factSheet: ProductFactSheet,
  state: OutreachAgentState,
  repoContext: Awaited<ReturnType<typeof buildRepoContext>>,
  resolvedProfile: ResolvedPromptProfile,
  ctaLink: CtaLink | undefined
): Promise<LlmDraftResponse> {
  return llmProvider.createJsonCompletion<LlmDraftResponse>([
    {
      role: "system",
      content: buildDraftSystemPrompt(candidateLabel, candidate, resolvedProfile)
    },
    {
      role: "user",
      content: buildDraftUserPrompt(
        candidateLabel,
        candidate,
        selectionRationale,
        factSheet,
        state,
        repoContext,
        resolvedProfile,
        ctaLink
      )
    }
  ]);
}

async function repairDraftCandidateForProofPoint(
  llmProvider: JsonLlmProvider,
  candidateLabel: string,
  candidate: WriteCandidate,
  selectionRationale: string | undefined,
  factSheet: ProductFactSheet,
  state: OutreachAgentState,
  repoContext: Awaited<ReturnType<typeof buildRepoContext>>,
  resolvedProfile: ResolvedPromptProfile,
  ctaLink: CtaLink | undefined,
  previousResponse: LlmDraftResponse
): Promise<LlmDraftResponse> {
  return llmProvider.createJsonCompletion<LlmDraftResponse>([
    {
      role: "system",
      content: [
        buildDraftSystemPrompt(candidateLabel, candidate, resolvedProfile),
        "You are revising a rejected draft.",
        "Fix the draft by adding exactly one explicit concrete proof point.",
        "Allowed proof points include SDK, MCP, quickstart, contract address, tx hash, COTIscan link, messageId, inbox/read-back, or a send/read smoke-test result.",
        "Keep the draft compact and preserve the same core claim."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        buildDraftUserPrompt(
          candidateLabel,
          candidate,
          selectionRationale,
          factSheet,
          state,
          repoContext,
          resolvedProfile,
          ctaLink
        ),
        "",
        "Previous draft that failed validation:",
        JSON.stringify(
          {
            selectedCandidateId: previousResponse.selectedCandidateId,
            title: previousResponse.title,
            content: previousResponse.content,
            rationale: previousResponse.rationale
          },
          null,
          2
        ),
        "",
        "Validation failure:",
        "The draft did not include an explicit concrete proof point. Revise it and return corrected JSON only."
      ].join("\n")
    }
  ]);
}

async function finalizeGeneratedDecision(input: {
  config: MoltbookRuntimeConfig;
  selectedCandidate: WriteCandidate;
  response: LlmDraftResponse;
  selectionRationale: string | undefined;
  state: OutreachAgentState;
  resolvedProfile: ResolvedPromptProfile;
  ctaLink: CtaLink | undefined;
  selectedVariant: Awaited<ReturnType<typeof selectPromptVariant>>;
}): Promise<GeneratedWriteDecision> {
  const rawContent = applyCtaToContent(
    normalizeDraftContent(input.selectedCandidate, (input.response.content ?? "").trim()),
    input.resolvedProfile,
    input.ctaLink
  );
  if (!rawContent) {
    throw new Error(`LLM returned empty content for candidate ${input.selectedCandidate.id}`);
  }

  const rawTitle =
    input.selectedCandidate.type === "create_post" ? (input.response.title ?? "").trim() : undefined;
  if (input.selectedCandidate.type === "create_post" && !rawTitle) {
    throw new Error("LLM selected a post candidate but did not return a title.");
  }
  const { title, content } = normalizeDraftForPublish(
    input.selectedCandidate,
    rawTitle,
    rawContent,
    input.ctaLink
  );

  validateDraft(input.selectedCandidate, title, content, input.state, input.resolvedProfile, input.ctaLink);
  validateDraftAgainstPromptProfile(input.resolvedProfile, content, input.ctaLink?.url);
  if (input.ctaLink?.ref) {
    await saveOutreachRefToAttributionStore(input.config.attributionDbPath, input.ctaLink.ref).catch(
      () => undefined
    );
  }

  return {
    selectedCandidateId: input.selectedCandidate.id,
    title,
    content,
    rationale:
      [input.selectionRationale, input.response.rationale].filter(Boolean).join(" ").trim() ||
      "No rationale provided.",
    fingerprint: contentFingerprint(`${title ?? ""}\n${content}`),
    promptProfileId: input.resolvedProfile.id,
    promptVariantId: input.selectedVariant.variantId,
    promptVariantRationale: input.selectedVariant.rationale,
    promptParameters: input.resolvedProfile.parameters,
    layout: input.resolvedProfile.parameters.layout,
    ctaUrl: input.ctaLink?.url,
    outreachRef: input.ctaLink?.ref,
    structuralFingerprint: structuralFingerprint(`${title ?? ""}\n${content}`),
    promptRotationReusedExisting: input.selectedVariant.reusedExisting,
    promptRotateAfterActions: input.selectedVariant.rotateAfterActions
  };
}

function normalizeDraftForPublish(
  candidate: WriteCandidate,
  title: string | undefined,
  content: string,
  ctaLink: CtaLink | undefined
): {
  title?: string;
  content: string;
} {
  if (candidate.type !== "create_post") {
    return { title, content };
  }

  return {
    title: title ? trimToLimit(title, MAX_POST_TITLE_CHARS) : title,
    content: trimPostContentToLimit(content, MAX_POST_CONTENT_CHARS, ctaLink?.url)
  };
}

function trimToLimit(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  const ellipsis = "...";
  if (limit <= ellipsis.length) {
    return value.slice(0, limit);
  }

  const trimmed = value.slice(0, limit - ellipsis.length).trimEnd();
  return `${trimmed}${ellipsis}`;
}

function trimPostContentToLimit(content: string, limit: number, requiredCtaUrl?: string): string {
  if (content.length <= limit) {
    return content;
  }

  const ctaSuffix = requiredCtaUrl && content.includes(requiredCtaUrl) ? `\n\n${requiredCtaUrl}` : "";
  const bodyWithoutRequiredCta =
    ctaSuffix && content.endsWith(ctaSuffix) ? content.slice(0, -ctaSuffix.length).trimEnd() : content;
  const availableBodyChars = limit - ctaSuffix.length;
  if (availableBodyChars <= 0) {
    throw new Error("Generated post content is too long to preserve the required tracked CTA URL.");
  }

  const trimmedBody = trimToLimit(bodyWithoutRequiredCta, availableBodyChars).trimEnd();
  return `${trimmedBody}${ctaSuffix}`;
}

function buildSelectionSystemPrompt(): string {
  return [
    `Prompt version: ${PROMPT_VERSION}.`,
    BASE_PERSONALITY,
    "You are selecting exactly one authored Moltbook action from a bounded shortlist.",
    "Prefer direct engagement on our own threads first, then comments where we can add something concrete, then top-level posts last.",
    "Optimize for relevance, technical usefulness, and conversational fit.",
    "Penalize candidates that would force awkward product dumping or repeat recent phrasing.",
    "For comments and replies, prefer candidates where we can leave a natural breadcrumb back to COTI instead of donating a useful point with zero attribution.",
    "Each candidate has a short label like A, B, or C. Return selectedCandidateId using that label exactly.",
    "Return strict JSON with keys: selectedCandidateId, rationale."
  ].join(" ");
}

function buildSelectionUserPrompt(
  labeledCandidates: readonly LabeledCandidate[],
  factSheet: ProductFactSheet,
  state: OutreachAgentState,
  repoContext: Awaited<ReturnType<typeof buildRepoContext>>
): string {
  const recentHistory = buildRecentHistorySummary(state);
  const shortlist = labeledCandidates.map(({ label, candidate }) => ({
    selectedCandidateId: label,
    type: candidate.type,
    reason: candidate.reason,
    targetSummary: describeCandidate(candidate)
  }));

  return [
    "Candidate shortlist to choose from:",
    JSON.stringify(shortlist, null, 2),
    "",
    "Grounded product claims most likely to matter:",
    JSON.stringify(selectRelevantClaims(factSheet, shortlist.map((entry) => entry.targetSummary).join("\n")), null, 2),
    "",
    "Recent authored history to avoid echoing too closely:",
    recentHistory,
    "",
    "Recent phrasing/openings to avoid:",
    JSON.stringify(extractAvoidList(state), null, 2),
    "",
    "High-signal repo context:",
    JSON.stringify({
      summary: trimSummary(repoContext.baseSummary, 4),
      snippets: repoContext.relevantSnippets.slice(0, 3)
    }, null, 2)
  ].join("\n");
}

function buildDraftSystemPrompt(
  candidateLabel: string,
  candidate: WriteCandidate,
  resolvedProfile: ResolvedPromptProfile
): string {
  const commonRules = [
    `Prompt version: ${PROMPT_VERSION}.`,
    BASE_PERSONALITY,
    "Follow the active prompt profile and layout instructions unless they conflict with safety rules.",
    "Ground claims only in the provided facts and repo snippets.",
    "If no exact CTA URL is provided in the prompt, do not include or invent any link.",
    "Do not sound like docs, release notes, or a pitch deck.",
    "Do not lead with rewards unless the target is explicitly discussing rewards.",
    "Use at most two concrete product claims unless the target explicitly asks for more.",
    "Use repo-specific mechanics only when they materially sharpen the point; otherwise leave them out.",
    "Prefer one hard distinction, one operational consequence, and one sharp closing line over a tidy mini-essay.",
    "Cut throat-clearing, avoid explanatory filler, and do not enumerate just because you can.",
    "Avoid repeating recent authored phrases or openings.",
    "If you reference our product, mechanics, SDK, MCP surface, rewards, or private messaging flow, leave one explicit attribution anchor to COTI or to our COTI private messaging stack.",
    promptProfileToPromptText(resolvedProfile),
    `Echo selectedCandidateId as "${candidateLabel}".`,
    "Return strict JSON with keys: selectedCandidateId, title, content, rationale."
  ];

  switch (candidate.type) {
    case "reply_to_activity":
      return [
        ...commonRules,
        REPLY_PERSONALITY,
        "Write a reply that is conversational, sharp, and compact.",
        "Aim for 170-520 characters.",
        "The first sentence must directly engage the target's actual point.",
        "Use one compact paragraph by default; use two only if the turn needs a clear pivot.",
        "Prefer one argument, not a tour of every relevant repo fact.",
        "Do not leave product identity implicit; if the reply uses our mechanics, include one short natural COTI anchor.",
        "Do not use inline code formatting in replies unless mentioning an actual symbol is necessary.",
        "End with either a sharp conclusion or one pointed question, not both."
      ].join(" ");
    case "comment_on_post":
      return [
        ...commonRules,
        "Write a comment that adds one useful technical angle to the post.",
        "Aim for 160-480 characters.",
        "Lead with the post's actual topic, not our product pitch.",
        "Open with a distinction or disagreement that sharpens the thread, not a summary of what the post already said.",
        "Use one compact paragraph by default; only use two short paragraphs when the second lands the point harder.",
        "Use at most one concrete repo or product mechanism.",
        "If you mention our mechanics, leave one short natural breadcrumb back to COTI instead of making the point sound generic.",
        "Do not use inline code formatting or backticks in comments.",
        "A strong final sentence is better than a thorough explanation."
      ].join(" ");
    case "create_post":
      return [
        ...commonRules,
        "Write an original top-level post with a title and body.",
        "Keep it compact.",
        "Title should be punchy, concrete, and ideally 55-85 characters; never exceed 100 characters.",
        "Body should usually land around 280-650 characters; never exceed 900 characters including any CTA URL.",
        "Open with a strong observation or tradeoff, not a slogan.",
        "Use one compact paragraph by default; only use two short paragraphs if the pivot materially improves the post.",
        "Make one sharp claim, support it with one concrete mechanic, then stop.",
        "Every top-level post must contain one concrete proof point: SDK, MCP, quickstart, contract address, transaction hash, COTIscan link, messageId, inbox/read-back, or a send/read smoke-test result.",
        "Do not write another abstract 'private bodies plus public routing' thesis unless it is anchored to an actual integration or dogfood artifact.",
        "If a draft starts getting long, cut examples, throat-clearing, and subordinate points instead of adding explanation.",
        "The post should feel like a technical operator talking, not a marketer."
      ].join(" ");
  }
}

function buildDraftUserPrompt(
  candidateLabel: string,
  candidate: WriteCandidate,
  selectionRationale: string | undefined,
  factSheet: ProductFactSheet,
  state: OutreachAgentState,
  repoContext: Awaited<ReturnType<typeof buildRepoContext>>,
  resolvedProfile: ResolvedPromptProfile,
  ctaLink: CtaLink | undefined
): string {
  const candidateQuery = candidateToQueryText(candidate);
  const relevantClaims = selectRelevantClaims(factSheet, candidateQuery);
  const repoPayload =
    candidate.type === "create_post"
      ? {
          summary: trimSummary(repoContext.baseSummary, 6),
          snippets: repoContext.relevantSnippets.slice(0, 4)
        }
      : {
          snippets: repoContext.relevantSnippets.slice(0, 1)
        };

  return [
    "Selected candidate:",
    JSON.stringify(describeDraftCandidate(candidateLabel, candidate), null, 2),
    "",
    "Why this candidate was selected:",
    selectionRationale ?? "No rationale provided.",
    "",
    "Grounded claims to draw from:",
    JSON.stringify(relevantClaims, null, 2),
    "",
    "Relevant SDK/contracts/docs context:",
    JSON.stringify(repoPayload, null, 2),
    "",
    "Writing target:",
    candidate.type === "create_post"
      ? "Keep it short. Make one strong claim, support it with one concrete mechanic, and end before it turns into an essay."
      : "Keep it sharp. One distinction, one consequence, one memorable closing line beats a well-behaved explanation.",
    "",
    "Active prompt profile:",
    promptProfileToPromptText(resolvedProfile),
    "",
    "CTA/ref requirement:",
    ctaLink
      ? JSON.stringify(
          {
            url: ctaLink.url,
            ref: ctaLink.ref,
            placement: ctaLink.placement,
            instruction: "Include this exact URL once. Do not alter its query params."
          },
          null,
          2
        )
      : candidate.type === "create_post"
        ? "No tracked CTA URL is required for this draft."
        : "No link is allowed in this draft unless an exact tracked URL is provided.",
    "",
    "Recent authored history:",
    buildRecentHistorySummary(state),
    "",
    "Avoid reusing these openings or phrases:",
    JSON.stringify(extractAvoidList(state), null, 2)
  ].join("\n");
}

function validateDraft(
  candidate: WriteCandidate,
  title: string | undefined,
  content: string,
  state: OutreachAgentState,
  resolvedProfile: ResolvedPromptProfile,
  ctaLink: CtaLink | undefined
): void {
  if (candidate.type === "create_post" && title && title.length > MAX_POST_TITLE_CHARS) {
    throw new Error("Generated post title is too long.");
  }

  if (candidate.type === "create_post" && content.length > MAX_POST_CONTENT_CHARS) {
    throw new Error("Generated post content is too long.");
  }

  if (candidate.type !== "create_post" && content.length > MAX_REPLY_OR_COMMENT_CHARS) {
    throw new Error("Generated reply/comment is too long.");
  }

  if (candidate.type === "reply_to_activity" && content.length < 120) {
    throw new Error("Generated reply is too thin.");
  }

  if (candidate.type !== "create_post" && content.includes("`")) {
    throw new Error("Replies/comments should avoid doc-style inline code formatting.");
  }

  if (candidate.type === "create_post") {
    const fingerprint = contentFingerprint(`${title ?? ""}\n${content}`);
    if (state.createdPostFingerprints.includes(fingerprint)) {
      throw new Error("Generated content is too similar to recent authored history.");
    }
  }

  const duplicateArtifact = findDuplicateDraftArtifact(candidate, title, content, state);
  if (duplicateArtifact) {
    throw new Error(`Generated content is too similar to recent authored artifact ${duplicateArtifact.id}.`);
  }

  if (resolvedProfile.cta.requirement === "required" && ctaLink && !content.includes(ctaLink.url)) {
    throw new Error("Generated content is missing the required tracked CTA URL.");
  }

  if (candidate.type === "create_post" && !hasConcretePostProofPoint(`${title ?? ""}\n${content}`)) {
    throw new Error(
      "Generated post is missing a concrete proof point such as SDK, MCP, quickstart, contract address, tx hash, COTIscan link, messageId, inbox/read-back, or smoke-test result."
    );
  }
}

function findDuplicateDraftArtifact(
  candidate: WriteCandidate,
  title: string | undefined,
  content: string,
  state: OutreachAgentState
) {
  const draftText = `${title ?? ""}\n${content}`;
  if (candidate.type === "create_post") {
    const draftStructure = structuralFingerprint(draftText);
    return state.recentGeneratedArtifacts.find((artifact) => {
      const artifactText = `${artifact.title ?? ""}\n${artifact.content}`;
      return (
        artifact.structuralFingerprint === draftStructure ||
        contentTokenSimilarity(draftText, artifactText) >= 0.72 ||
        (artifact.type === "post" && hasRepeatedPostTheme(draftText, artifactText))
      );
    });
  }

  return state.recentGeneratedArtifacts.find((artifact) => {
    if (!isComparableDiscussionArtifact(candidate, artifact)) {
      return false;
    }
    const artifactText = `${artifact.title ?? ""}\n${artifact.content}`;
    const similarity = contentTokenSimilarity(draftText, artifactText);
    return similarity >= duplicateThresholdForCandidate(candidate) || normalizedBody(content) === normalizedBody(artifact.content);
  });
}

function isComparableDiscussionArtifact(
  candidate: WriteCandidate,
  artifact: OutreachAgentState["recentGeneratedArtifacts"][number]
): boolean {
  if (candidate.type === "comment_on_post" && artifact.type !== "comment") {
    return false;
  }
  if (candidate.type === "reply_to_activity" && artifact.type !== "reply") {
    return false;
  }

  const candidateTarget = discussionTargetForCandidate(candidate);
  const artifactTarget = normalizedBody(artifact.targetSummary);
  if (!candidateTarget || !artifactTarget) {
    return false;
  }
  return candidateTarget === artifactTarget;
}

function discussionTargetForCandidate(candidate: WriteCandidate): string {
  if (candidate.type === "comment_on_post") {
    return normalizedBody(`${candidate.post.title} ${candidate.post.content_preview ?? ""}`.trim());
  }
  if (candidate.type === "reply_to_activity") {
    return normalizedBody(candidate.target.content);
  }
  return "";
}

function duplicateThresholdForCandidate(candidate: WriteCandidate): number {
  return candidate.type === "comment_on_post" ? 0.96 : 0.93;
}

function normalizedBody(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function hasConcretePostProofPoint(value: string): boolean {
  return (
    /\b(?:sdk|mcp|quickstart|contract address|messageid|inbox|read[- ]?back|smoke test|send\/read|send and read|cotiscan)\b/i.test(value) ||
    /\btx(?: hash)?\b/i.test(value) ||
    /0x[a-f0-9]{40}/i.test(value)
  );
}

function hasRepeatedPostTheme(draft: string, previous: string): boolean {
  const draftThemes = postThemeTags(draft);
  const previousThemes = postThemeTags(previous);
  if (draftThemes.length < 2 || previousThemes.length < 2) {
    return false;
  }

  const overlap = draftThemes.filter((theme) => previousThemes.includes(theme));
  return overlap.length >= 3 || (overlap.length >= 2 && contentTokenSimilarity(draft, previous) >= 0.25);
}

function postThemeTags(value: string): string[] {
  const normalized = value.toLowerCase();
  const tags: string[] = [];
  if (/\b(?:private|encrypted|ciphertext)\b/.test(normalized) && /\b(?:body|content|message)\b/.test(normalized)) {
    tags.push("encrypted-body");
  }
  if (/\b(?:public|queryable|routing|metadata|from|to)\b/.test(normalized)) {
    tags.push("public-routing");
  }
  if (/\b(?:sdk|mcp|quickstart|integration|install|function calls?)\b/.test(normalized)) {
    tags.push("integration");
  }
  if (/\b(?:reward|grant|epoch|usage units?)\b/.test(normalized)) {
    tags.push("rewards");
  }
  if (/\b(?:dogfood|smoke test|messageid|tx|transaction|cotiscan|read[- ]?back|inbox)\b/.test(normalized)) {
    tags.push("proof");
  }
  return tags;
}

function normalizeDraftContent(candidate: WriteCandidate, content: string): string {
  if (candidate.type === "create_post") {
    return content;
  }

  return content
    .replace(/`([^`]+)`/g, "$1")
    .replace(/`+/g, "")
    .trim();
}

function buildCandidateCtaLink(
  config: MoltbookRuntimeConfig,
  candidate: WriteCandidate,
  resolvedProfile: ResolvedPromptProfile
): CtaLink | undefined {
  if (
    resolvedProfile.cta.requirement === "forbidden" ||
    !resolvedProfile.cta.baseUrl ||
    !shouldGenerateCtaLink(candidate, resolvedProfile)
  ) {
    return undefined;
  }

  const generatedContentId = contentFingerprint(`${candidate.id}:${candidateToQueryText(candidate)}:${randomUUID()}`);
  const ref = buildOutreachRef({
    venue: "moltbook",
    venueAccountId: config.agentId,
    surface: config.defaultSubmolt,
    contentType:
      candidate.type === "create_post"
        ? "post"
        : candidate.type === "reply_to_activity"
          ? "reply"
          : "comment",
    promptProfileId: resolvedProfile.id,
    parameters: resolvedProfile.parameters,
    campaignId: config.attributionCampaignId ?? "private_messaging",
    candidateId: candidate.id,
    generatedContentId
  });

  return buildTrackedLink({
    baseUrl: resolvedProfile.cta.baseUrl,
    ref,
    placement: resolvedProfile.cta.placement,
    approvedDomains: resolvedProfile.cta.approvedDomains
  });
}

function shouldGenerateCtaLink(
  candidate: WriteCandidate,
  resolvedProfile: ResolvedPromptProfile
): boolean {
  if (resolvedProfile.actionType === "create_post") {
    return true;
  }

  return targetExplicitlyRequestsResource(candidate);
}

function targetExplicitlyRequestsResource(candidate: WriteCandidate): boolean {
  const sourceText =
    candidate.type === "comment_on_post"
      ? `${candidate.post.title}\n${candidate.post.content ?? candidate.post.content_preview ?? ""}`
      : candidate.type === "reply_to_activity"
        ? candidate.target.content
        : "";

  return EXPLICIT_RESOURCE_REQUEST_PATTERNS.some((pattern) => pattern.test(sourceText));
}

function applyCtaToContent(
  content: string,
  resolvedProfile: ResolvedPromptProfile,
  ctaLink: CtaLink | undefined
): string {
  if (!ctaLink || resolvedProfile.cta.requirement !== "required" || content.includes(ctaLink.url)) {
    return content;
  }

  if (ctaLink.placement === "after_first_paragraph") {
    const paragraphs = content.split(/\n\n+/);
    if (paragraphs.length > 1) {
      return [paragraphs[0], ctaLink.url, ...paragraphs.slice(1)].join("\n\n");
    }
  }

  return `${content}\n\n${ctaLink.url}`;
}

function candidateToQueryText(candidate: WriteCandidate): string {
  switch (candidate.type) {
    case "create_post":
      return candidate.reason;
    case "comment_on_post":
      return `${candidate.post.title} ${candidate.post.content_preview ?? ""} ${candidate.post.content ?? ""}`;
    case "reply_to_activity":
      return `${candidate.postTitle} ${candidate.target.content}`;
  }
}

function describeCandidate(candidate: WriteCandidate): string {
  switch (candidate.type) {
    case "create_post":
      return candidate.reason;
    case "comment_on_post":
      return `${candidate.post.title} ${candidate.post.content_preview ?? ""} ${candidate.post.content ?? ""}`.trim();
    case "reply_to_activity":
      return `${candidate.postTitle} | ${candidate.target.authorName ?? "commenter"} said: ${candidate.target.content}`;
  }
}

function describeDraftCandidate(candidateLabel: string, candidate: WriteCandidate): Record<string, string> {
  switch (candidate.type) {
    case "create_post":
      return {
        selectedCandidateId: candidateLabel,
        type: candidate.type,
        reason: candidate.reason
      };
    case "comment_on_post":
      return {
        selectedCandidateId: candidateLabel,
        type: candidate.type,
        postTitle: candidate.post.title,
        postPreview: candidate.post.content_preview ?? candidate.post.content ?? "",
        reason: candidate.reason
      };
    case "reply_to_activity":
      return {
        selectedCandidateId: candidateLabel,
        type: candidate.type,
        postTitle: candidate.postTitle,
        authorName: candidate.target.authorName ?? "commenter",
        targetComment: candidate.target.content,
        reason: candidate.reason
      };
  }
}

function candidateLabelForIndex(index: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let nextIndex = index;
  let label = "";

  do {
    label = alphabet[nextIndex % alphabet.length] + label;
    nextIndex = Math.floor(nextIndex / alphabet.length) - 1;
  } while (nextIndex >= 0);

  return label;
}

function selectRelevantClaims(factSheet: ProductFactSheet, queryText: string) {
  const searchTerms = extractQueryTerms(queryText);
  return factSheet.claims
    .map((claim) => ({
      claim,
      score: scoreClaim(claim, searchTerms)
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map(({ claim }) => ({
      id: claim.id,
      headline: claim.headline,
      detail: claim.detail,
      evidence: claim.evidence.slice(0, 1)
    }));
}

function scoreClaim(
  claim: ProductFactSheet["claims"][number],
  searchTerms: readonly string[]
): number {
  const haystack = `${claim.headline} ${claim.detail} ${claim.evidence.join(" ")}`.toLowerCase();
  return searchTerms.reduce((score, term) => {
    return haystack.includes(term) ? score + Math.min(term.length, 6) : score;
  }, 0);
}

function extractQueryTerms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).slice(0, 24))];
}

function trimSummary(summary: string, maxLines: number): string {
  return summary.split("\n").slice(0, maxLines).join("\n");
}

function buildRecentHistorySummary(state: OutreachAgentState): string {
  const recent = state.recentGeneratedArtifacts.slice(-4);
  if (recent.length === 0) {
    return "No recent authored history.";
  }

  return recent
    .map((artifact) =>
      JSON.stringify({
        type: artifact.type,
        title: artifact.title,
        opening: extractOpening(artifact.content),
        promptProfileId: artifact.promptProfileId,
        promptVariantId: artifact.promptVariantId,
        messageStyle: artifact.promptParameters?.messageStyle,
        layout: artifact.layout,
        structuralFingerprint: artifact.structuralFingerprint,
        ctaRef: artifact.outreachRef?.id,
        targetSummary: artifact.targetSummary,
        createdAt: artifact.createdAt
      })
    )
    .join("\n");
}

function extractAvoidList(state: OutreachAgentState): string[] {
  return state.recentGeneratedArtifacts
    .slice(-5)
    .flatMap((artifact) => {
      const opening = extractOpening(artifact.content);
      const notablePhrases = extractNotablePhrases(artifact.content);
      return [opening, ...notablePhrases];
    })
    .filter(Boolean)
    .slice(0, 12);
}

function extractOpening(content: string): string {
  const firstParagraph = content.split("\n\n")[0] ?? content;
  return firstParagraph.trim().slice(0, 140);
}

function extractNotablePhrases(content: string): string[] {
  const lower = content.toLowerCase();
  const candidates = [
    "private coordination",
    "integration surface",
    "instead of hand wavy",
    "the compounding part is the killer",
    "boring in the best sense",
    "something agents can actually ship",
    "what matters is"
  ];

  return candidates.filter((phrase) => lower.includes(phrase)).slice(0, 2);
}
