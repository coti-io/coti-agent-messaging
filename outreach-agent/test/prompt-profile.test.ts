import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSafePromptVariantCandidates,
  canUseProductSpecificFollowUp,
  contentTokenSimilarity,
  DEFAULT_PROMPT_PROFILE,
  filterPromptParameterOverrides,
  promptProfileToPromptText,
  resolvePromptProfile,
  structuralFingerprint,
  validateDraftAgainstPromptProfile,
  validatePromptProfile,
  type PromptProfile
} from "../src/prompt-profile.js";

test("Reddit first replies force non-promotional profile settings and forbid CTA links", () => {
  const profile: PromptProfile = {
    id: "pushy",
    parameters: {
      promotionLevel: "direct",
      ctaStyle: "direct_next_step",
      productSpecificity: "feature_specific",
      messageStyle: "promotional",
      layout: "structured_bullets"
    },
    cta: {
      requirement: "required",
      baseUrl: "https://example.com/agent-messaging"
    }
  };

  const resolved = resolvePromptProfile({
    venue: "reddit",
    actionType: "comment_on_post",
    profile
  });

  assert.equal(resolved.parameters.promotionLevel, "none");
  assert.equal(resolved.parameters.ctaStyle, "none");
  assert.equal(resolved.parameters.productSpecificity, "generic_category");
  assert.equal(resolved.cta.requirement, "forbidden");
  assert.doesNotThrow(() => validatePromptProfile(resolved));
  assert.throws(
    () => validateDraftAgainstPromptProfile(resolved, "Helpful answer https://example.com"),
    /forbidden/i
  );
});

test("default Reddit prompt profile biases toward useful public answers", () => {
  const resolved = resolvePromptProfile({
    venue: "reddit",
    actionType: "comment_on_post"
  });

  assert.equal(resolved.parameters.intent, "educate");
  assert.equal(resolved.parameters.responseLength, "brief");
  assert.equal(resolved.parameters.messageStyle, "curious");
  assert.equal(resolved.parameters.layout, "short_hook_then_detail");
  assert.equal(resolved.parameters.technicalDepth, "simple");
  assert.equal(resolved.parameters.productSpecificity, "generic_category");
  assert.match(promptProfileToPromptText(resolved), /under 420 characters/i);
});

test("reddit variant list includes a brief peer reply candidate", () => {
  const candidates = buildSafePromptVariantCandidates({
    venue: "reddit",
    actionType: "comment_on_post"
  });
  assert.equal(candidates[0]?.id, "reddit-brief-peer");
  assert.equal(
    candidates.some((candidate) => candidate.id === "reddit-wry-peer" && candidate.parameters.humor === "light"),
    true
  );
  assert.equal(
    candidates.some((candidate) => candidate.id === "reddit-playful-peer" && candidate.parameters.humor === "playful"),
    true
  );
  assert.equal(
    candidates.some((candidate) => candidate.id === "operator-problem-solution"),
    false
  );
});

test("humor parameter is reflected in prompt text and can be overridden", () => {
  const wry = resolvePromptProfile({
    venue: "reddit",
    actionType: "comment_on_post",
    parameterOverrides: { humor: "light" }
  });
  assert.match(promptProfileToPromptText(wry), /Humor: light/i);
  assert.match(promptProfileToPromptText(wry), /dry, understated/i);

  const playful = resolvePromptProfile({
    venue: "reddit",
    actionType: "comment_on_post",
    parameterOverrides: { humor: "playful", aggression: "high" }
  });
  assert.equal(playful.parameters.aggression, "low");
  assert.match(promptProfileToPromptText(playful), /light irony/i);
});

test("Reddit product-specific follow-up requires explicit interest after public value", () => {
  const blocked = canUseProductSpecificFollowUp({
    venue: "reddit",
    explicitInterest: false,
    publicValueDeliveredFirst: true
  });
  const allowed = canUseProductSpecificFollowUp({
    venue: "reddit",
    explicitInterest: true,
    publicValueDeliveredFirst: true
  });

  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /explicitly asks/i);
  assert.equal(allowed.allowed, true);
});

test("default profile allows rotation to override reddit voice keys", () => {
  const overrides = filterPromptParameterOverrides(
    { id: "default", allowVariantOverrides: true, parameters: {} },
    "reddit",
    "comment_on_post",
    {
      humor: "light",
      responseLength: "brief",
      layout: "problem_solution",
      messageStyle: "informative"
    }
  );

  assert.deepEqual(overrides, {
    humor: "light",
    responseLength: "brief",
    layout: "problem_solution",
    messageStyle: "informative"
  });
});

test("default profile applies wry-peer variant humor override on reddit", () => {
  const wry = buildSafePromptVariantCandidates({
    venue: "reddit",
    actionType: "comment_on_post"
  }).find((candidate) => candidate.id === "reddit-wry-peer");
  assert.ok(wry);
  const overrides = filterPromptParameterOverrides(
    DEFAULT_PROMPT_PROFILE,
    "reddit",
    "comment_on_post",
    wry?.parameters
  );
  const resolved = resolvePromptProfile({
    venue: "reddit",
    actionType: "comment_on_post",
    profile: DEFAULT_PROMPT_PROFILE,
    parameterOverrides: overrides
  });
  assert.equal(resolved.parameters.humor, "light");
  assert.equal(resolved.parameters.responseLength, "brief");
});

test("default profile still locks promotion and CTA overrides from rotation", () => {
  const overrides = filterPromptParameterOverrides(
    { id: "default", allowVariantOverrides: true, parameters: {} },
    "reddit",
    "comment_on_post",
    {
      promotionLevel: "direct",
      ctaStyle: "direct_next_step",
      humor: "light"
    }
  );

  assert.deepEqual(overrides, { humor: "light" });
});

test("profile defaults do not strip safe prompt-rotation overrides", () => {
  const profile: PromptProfile = {
    id: "custom-profile",
    allowVariantOverrides: true,
    parameters: {
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
    }
  };

  const overrides = filterPromptParameterOverrides(profile, "reddit", "reply_to_activity", {
    layout: "problem_solution",
    tone: "operator"
  });

  assert.deepEqual(overrides, {
    layout: "problem_solution",
    tone: "operator"
  });
});

test("Moltbook profiles can require CTA links but block shorteners", () => {
  const resolved = resolvePromptProfile({
    venue: "moltbook",
    actionType: "create_post",
    ctaBaseUrl: "https://example.com/agent-messaging",
    approvedDomains: ["example.com"]
  });

  assert.equal(resolved.cta.requirement, "required");
  assert.doesNotThrow(() => validatePromptProfile(resolved));
  assert.throws(
    () => validateDraftAgainstPromptProfile(resolved, "CTA missing", "https://example.com/agent-messaging"),
    /missing/i
  );

  const shortener = resolvePromptProfile({
    venue: "moltbook",
    actionType: "create_post",
    ctaBaseUrl: "https://bit.ly/abc",
    approvedDomains: ["bit.ly"]
  });
  assert.throws(() => validatePromptProfile(shortener), /shorteners/i);
});

test("Moltbook comments keep CTA optional and reject unsolicited links", () => {
  const resolved = resolvePromptProfile({
    venue: "moltbook",
    actionType: "comment_on_post",
    ctaBaseUrl: "https://example.com/agent-messaging",
    approvedDomains: ["example.com"]
  });

  assert.equal(resolved.cta.requirement, "optional");
  assert.doesNotThrow(() => validatePromptProfile(resolved));
  assert.throws(
    () => validateDraftAgainstPromptProfile(resolved, "Here is the link https://example.com/agent-messaging"),
    /must not include links unless the target explicitly asked/i
  );
  assert.doesNotThrow(() =>
    validateDraftAgainstPromptProfile(
      resolved,
      "Here is the quickstart you asked for https://example.com/agent-messaging?utm_source=moltbook",
      "https://example.com/agent-messaging?utm_source=moltbook"
    )
  );
});

test("structural and token similarity catch repeated answer shapes", () => {
  const first =
    "Problem: public coordination leaks too much.\n\nSolution: keep routing public and payloads private.";
  const second =
    "Problem: public coordination exposes too much.\n\nSolution: keep routing visible and payloads encrypted.";

  assert.equal(structuralFingerprint(first), structuralFingerprint(second));
  assert.equal(contentTokenSimilarity(first, second) > 0.45, true);
});
