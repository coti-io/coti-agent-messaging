import { buildMainLlmProvider, type MoltbookRuntimeConfig } from "./config.js";
import { validateDraftAgainstPromptProfile, resolvePromptProfile } from "./prompt-profile.js";
import type { RedditReviewItem, RedditOutreachTargeting } from "./reddit-outreach.js";

export interface RedditDraftInput {
  config: MoltbookRuntimeConfig;
  item: RedditReviewItem;
  targeting: RedditOutreachTargeting;
  recentContent?: readonly string[];
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
}> {
  const llmProvider = buildMainLlmProvider(input.config, input.fetchImpl);
  const fallback = input.item.draft ?? deterministicDraft(input.item);
  const content = llmProvider
    ? (await llmProvider.createJsonCompletion<RedditDraftResponse>([
        {
          role: "system",
          content: [
            "You write Reddit comments as a practical operator, not a marketer.",
            "Zero direct marketing. No product name. No company name. No links. No CTA. No DM request.",
            "Be useful first. Answer the concrete day-to-day operational pain.",
            "Prefer concise, natural prose over polished slogan copy.",
            "Return strict JSON with keys: content, rationale."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({
            subreddit: input.item.source.subreddit,
            title: input.item.source.title,
            body: input.item.source.body,
            parentTitle: input.item.source.parentTitle,
            whyRelevant: input.item.whyRelevant,
            recentContent: input.recentContent ?? [],
            forbiddenProductAliases: input.targeting.productAliases
          }, null, 2)
        }
      ])).content?.trim() || fallback
    : fallback;

  validateRedditDraft(content, input.targeting.productAliases);
  return {
    content,
    rationale: llmProvider ? "LLM drafted a zero-marketing Reddit response." : "Used deterministic zero-marketing fallback draft."
  };
}

export function validateRedditDraft(content: string, productAliases: readonly string[] = []): void {
  const profile = resolvePromptProfile({
    venue: "reddit",
    actionType: "reply_to_activity"
  });
  validateDraftAgainstPromptProfile(profile, content);
  if (FORBIDDEN_MARKETING_PATTERNS.some((pattern) => pattern.test(content))) {
    throw new Error("Reddit draft contains forbidden marketing, link, CTA, or DM language.");
  }
  const normalized = content.toLowerCase();
  if (productAliases.some((alias) => normalized.includes(alias.toLowerCase()))) {
    throw new Error("Reddit draft mentions a product/company alias.");
  }
}

function deterministicDraft(item: RedditReviewItem): string {
  const text = [item.source.parentTitle, item.source.title, item.source.body].filter(Boolean).join(" ").toLowerCase();
  if (/\bcrm\b|\bduplicate|data quality|handoff/.test(text)) {
    return [
      "I would start by treating this as a data ownership problem, not an automation problem.",
      "Pick one source of truth, define who is allowed to change each field, and log every automated write somewhere a human can audit.",
      "Most CRM cleanup loops fail because nobody can tell whether the automation made the record better or just moved the mess around."
    ].join(" ");
  }
  if (/\bworkflow|manual|spreadsheet|ops?\b/.test(text)) {
    return [
      "The useful first step is mapping the handoff, not replacing the whole workflow.",
      "Find the point where people copy data between tools, write down what can go wrong there, then automate only the boring validation and routing pieces.",
      "That keeps failures visible instead of turning the process into a black box."
    ].join(" ");
  }
  if (/\bautomation\b|\bfailing|incident|debug/.test(text)) {
    return [
      "Automation needs a boring fallback path or it eventually becomes another incident source.",
      "I would log the input, the decision, the write it attempted, and the reason it skipped or failed.",
      "That makes the system debuggable when the happy path breaks."
    ].join(" ");
  }
  return [
    "The pattern I have seen work is to keep the process small enough that someone can still reason about it.",
    "Define the trigger, the data it is allowed to touch, the failure mode, and who gets notified.",
    "Once that is clear, the tooling choice matters a lot less."
  ].join(" ");
}
