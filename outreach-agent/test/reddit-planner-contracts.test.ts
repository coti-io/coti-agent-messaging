import test from "node:test";
import assert from "node:assert/strict";

import {
  REDDIT_HEARTBEAT_PHASES,
  REDDIT_SESSION_PHASES
} from "../src/runtime/reddit-cycle-strategy.js";
import {
  assertRedditPlannerWorkspaceReady,
  REDDIT_PRE_DRAFT_PHASES,
  REDDIT_PRE_ENQUEUE_PHASES,
  REDDIT_PRE_SELECT_PHASES
} from "../src/runtime/reddit-planner-workspace-invariants.js";
import type { RedditPlannerWorkspace } from "../src/runtime/reddit-cycle-strategy.js";
import { emptyRedditFilterSummary } from "../src/reddit-policy.js";

test("reddit session phases apply limits before select_bundle and draft before enqueue", () => {
  const planIdx = REDDIT_SESSION_PHASES.indexOf("plan_actions");
  const selectIdx = REDDIT_SESSION_PHASES.indexOf("select_bundle");
  const draftIdx = REDDIT_SESSION_PHASES.indexOf("draft_content");
  const enqueueIdx = REDDIT_SESSION_PHASES.indexOf("enqueue_jobs");
  assert.ok(planIdx >= 0 && selectIdx >= 0 && draftIdx >= 0 && enqueueIdx >= 0);
  assert.ok(planIdx < selectIdx, "plan_actions must precede select_bundle");
  assert.ok(draftIdx < enqueueIdx, "draft_content must precede enqueue_jobs");
});

test("reddit heartbeat phases omit execute_due_jobs and publish", () => {
  const phases = REDDIT_HEARTBEAT_PHASES as readonly string[];
  assert.ok(!phases.includes("execute_due_jobs"));
  assert.ok(!phases.includes("publish"));
  const planIdx = REDDIT_HEARTBEAT_PHASES.indexOf("plan_actions");
  const selectIdx = REDDIT_HEARTBEAT_PHASES.indexOf("select_bundle");
  assert.ok(planIdx < selectIdx);
});

test("reddit pre-select invariant chain matches phase order prefix", () => {
  const sessionPhases = REDDIT_SESSION_PHASES as readonly string[];
  for (let i = 0; i < REDDIT_PRE_SELECT_PHASES.length - 1; i++) {
    const left = sessionPhases.indexOf(REDDIT_PRE_SELECT_PHASES[i]!);
    const right = sessionPhases.indexOf(REDDIT_PRE_SELECT_PHASES[i + 1]!);
    assert.ok(left < right, `${REDDIT_PRE_SELECT_PHASES[i]} must precede ${REDDIT_PRE_SELECT_PHASES[i + 1]}`);
  }
});

test("assertRedditPlannerWorkspaceReady throws when discover state missing before plan_actions", () => {
  const ws = { input: {}, options: { executeDueJobsFirst: false, allowImmediatePublish: false } } as RedditPlannerWorkspace;
  assert.throws(
    () => assertRedditPlannerWorkspaceReady(ws, "plan_actions"),
    /missing decision after discover_candidates/
  );
});

test("assertRedditPlannerWorkspaceReady throws when bundle missing before draft_content", () => {
  const ws = {
    input: {},
    options: { executeDueJobsFirst: false, allowImmediatePublish: false },
    decision: { skipped: [], candidates: [], plannedCandidates: [], filterSummary: emptyRedditFilterSummary() },
    gatedActionCandidates: []
  } as unknown as RedditPlannerWorkspace;
  assert.throws(
    () => assertRedditPlannerWorkspaceReady(ws, "draft_content"),
    /missing selectedActionBundle/
  );
});

test("REDDIT_PRE_ENQUEUE phases end at draft_content", () => {
  assert.equal(REDDIT_PRE_ENQUEUE_PHASES.at(-1), "draft_content");
  assert.equal(REDDIT_PRE_DRAFT_PHASES.at(-1), "select_bundle");
});
