import test from "node:test";
import assert from "node:assert/strict";

import { createActionJob, type ActionJob } from "../src/action-planning.js";
import {
  compactActionJobs,
  pickNextExecutableJob,
  requeueFailedActionJob,
  scheduleActionJobNotBefore
} from "../src/action-execution.js";
import type { ActionExecutionConfig } from "../src/config.js";
import type { VenueAction } from "../src/venue.js";

const config: ActionExecutionConfig = {
  globalMinDelaySeconds: 10,
  globalMaxDelaySeconds: 60,
  createPostMinMinutes: 1200,
  createPostMaxMinutes: 2160,
  commentMinMinutes: 45,
  commentMaxMinutes: 120,
  replyMinMinutes: 20,
  replyMaxMinutes: 75,
  upvoteMinDelaySeconds: 90,
  upvoteMaxDelaySeconds: 360,
  followMinDelaySeconds: 300,
  followMaxDelaySeconds: 1200,
  maxAttempts: 3,
  retryBaseDelaySeconds: 60,
  retryMaxDelayMinutes: 30,
  runningLeaseTimeoutMinutes: 15
};

test("scheduler blocks due jobs during action-type cooldown", () => {
  const now = new Date("2026-06-03T10:00:00.000Z");
  const job = jobFor({
    id: "comment:post-1",
    type: "comment_on_post",
    notBefore: "2026-06-03T09:59:00.000Z"
  });

  const selection = pickNextExecutableJob({
    jobs: [job],
    records: [
      {
        venue: "moltbook",
        type: "comment_on_post",
        createdAt: "2026-06-03T09:30:00.000Z",
        status: "posted"
      }
    ],
    now,
    config
  });

  assert.equal(selection.selectedJob, undefined);
  assert.match(selection.skipped ?? "", /comment_on_post execution cooldown/);
  assert.equal(selection.jobs[0]?.notBefore, "2026-06-03T10:15:00.000Z");
});

test("scheduler recovers stale running leases before selection", () => {
  const now = new Date("2026-06-03T10:30:00.000Z");
  const stale = {
    ...jobFor({
      id: "reply:post-1:comment-1",
      type: "reply_to_comment",
      notBefore: "2026-06-03T09:00:00.000Z"
    }),
    status: "running" as const,
    runningAt: "2026-06-03T10:00:00.000Z"
  };

  const selection = pickNextExecutableJob({
    jobs: [stale],
    records: [],
    now,
    config
  });

  assert.equal(selection.selectedJob?.id, stale.id);
  assert.equal(selection.selectedJob?.status, "running");
  assert.equal(selection.selectedJob?.attempts, 1);
});

test("scheduler requeues retryable failures with backoff", () => {
  const now = new Date("2026-06-03T10:00:00.000Z");
  const running = {
    ...jobFor({
      id: "comment:post-1",
      type: "comment_on_post",
      notBefore: "2026-06-03T09:59:00.000Z"
    }),
    status: "running" as const,
    attempts: 1
  };

  const result = requeueFailedActionJob({
    jobs: [running],
    jobId: running.id,
    error: new Error("HTTP 503"),
    now,
    config,
    rng: () => 0
  });

  assert.equal(result.retrying, true);
  assert.equal(result.jobs[0]?.status, "queued");
  assert.equal(result.jobs[0]?.notBefore, "2026-06-03T10:01:00.000Z");
});

test("queue compaction dedupes equivalent queued jobs", () => {
  const first = jobFor({
    id: "comment:post-1:first",
    type: "comment_on_post",
    notBefore: "2026-06-03T10:00:00.000Z"
  });
  const second = {
    ...first,
    id: "comment:post-1:second",
    createdAt: "2026-06-03T09:59:00.000Z"
  };

  const compacted = compactActionJobs([first, second]);

  assert.equal(compacted.length, 1);
});

test("scheduler-aware not-before respects queued backlog", () => {
  const now = new Date("2026-06-03T10:00:00.000Z");
  const existing = jobFor({
    id: "comment:post-1",
    type: "comment_on_post",
    notBefore: "2026-06-03T10:30:00.000Z"
  });

  const notBefore = scheduleActionJobNotBefore({
    now,
    actionType: "reply_to_comment",
    needsContent: true,
    existingJobs: [existing],
    records: [],
    config,
    rng: () => 0
  });

  assert.equal(notBefore, "2026-06-03T10:30:10.000Z");
});

function jobFor(input: {
  id: string;
  type: VenueAction["type"];
  notBefore: string;
}): ActionJob {
  return createActionJob({
    action: {
      id: input.id,
      venue: "moltbook",
      type: input.type,
      parentId: "post-1",
      candidateId: "candidate-1",
      content: input.type === "upvote_post" || input.type === "follow_account" ? undefined : "Useful content."
    },
    candidateId: "candidate-1",
    sourceDecisionId: "decision-1",
    notBefore: input.notBefore
  });
}
