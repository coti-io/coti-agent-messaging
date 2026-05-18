import test from "node:test";
import assert from "node:assert/strict";

import {
  canUseProductSpecificFollowUp,
  contentTokenSimilarity,
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
  assert.equal(resolved.parameters.messageStyle, "informative");
  assert.equal(resolved.parameters.layout, "question_answer");
  assert.equal(resolved.parameters.productSpecificity, "generic_category");
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
