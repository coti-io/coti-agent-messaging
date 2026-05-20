import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import type { MoltbookRuntimeConfig } from "../src/config.js";
import {
  chooseRotationWindow,
  loadPromptRotationStore,
  recordPromptRotationAction,
  selectPromptVariant
} from "../src/prompt-rotation.js";

function createConfig(promptRotationStatePath: string): MoltbookRuntimeConfig {
  const packageRoot = path.resolve(import.meta.dirname, "..", "..");
  return {
    packageRoot,
    projectRoot: path.resolve(packageRoot, ".."),
    credentialsPath: path.join(os.tmpdir(), "prompt-rotation-credentials.json"),
    statePath: path.join(os.tmpdir(), "prompt-rotation-state.json"),
    heartbeatReportPath: path.join(os.tmpdir(), "prompt-rotation-heartbeat.json"),
    promptRotationStatePath,
    moltbookBaseUrl: "https://www.moltbook.com/api/v1",
    defaultSubmolt: "general",
    dryRun: true,
    autoVerify: false
  };
}

test("prompt rotation chooses a stable 10-20 action window", () => {
  assert.equal(chooseRotationWindow(() => 0), 10);
  assert.equal(chooseRotationWindow(() => 0.5), 15);
  assert.equal(chooseRotationWindow(() => 0.999), 20);
});

test("prompt rotation reuses the active variant until the window is reached", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prompt-rotation-"));
  const promptRotationStatePath = path.join(tempDir, "prompt-rotation.json");
  const config = createConfig(promptRotationStatePath);

  const first = await selectPromptVariant({
    config,
    venue: "reddit",
    actionType: "reply_to_activity"
  });
  await recordPromptRotationAction({
    config,
    selection: {
      variantId: first.variantId,
      rationale: first.rationale,
      rotateAfterActions: first.rotateAfterActions,
      reusedExisting: first.reusedExisting
    },
    entry: {
      id: "reddit:1",
      venue: "reddit",
      actionType: "reply_to_activity",
      createdAt: "2026-05-19T09:00:00.000Z",
      status: "replied",
      promptVariantId: first.variantId,
      promptParameters: first.parameterOverrides
    }
  });

  const second = await selectPromptVariant({
    config,
    venue: "reddit",
    actionType: "reply_to_activity"
  });

  assert.equal(second.variantId, first.variantId);
  assert.equal(second.reusedExisting, true);
});

test("prompt rotation does not advance state until a successful action is recorded", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prompt-rotation-pending-"));
  const promptRotationStatePath = path.join(tempDir, "prompt-rotation.json");
  const config = createConfig(promptRotationStatePath);

  const selected = await selectPromptVariant({
    config,
    venue: "reddit",
    actionType: "reply_to_activity",
    rng: () => 0
  });
  const storeBeforeRecord = await loadPromptRotationStore(promptRotationStatePath);
  assert.equal(storeBeforeRecord.state.currentPromptVariant, undefined);

  await recordPromptRotationAction({
    config,
    selection: {
      variantId: selected.variantId,
      rationale: selected.rationale,
      rotateAfterActions: selected.rotateAfterActions,
      reusedExisting: selected.reusedExisting
    },
    entry: {
      id: "reddit:success",
      venue: "reddit",
      actionType: "reply_to_activity",
      createdAt: "2026-05-19T09:00:00.000Z",
      status: "replied",
      promptVariantId: selected.variantId
    }
  });

  const storeAfterRecord = await loadPromptRotationStore(promptRotationStatePath);
  assert.equal(storeAfterRecord.state.currentPromptVariant, selected.variantId);
  assert.equal(storeAfterRecord.state.actionsSinceRotation, 1);
});

test("prompt rotation records cross-venue prompt metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prompt-rotation-history-"));
  const promptRotationStatePath = path.join(tempDir, "prompt-rotation.json");
  const config = createConfig(promptRotationStatePath);

  await recordPromptRotationAction({
    config,
    entry: {
      id: "moltbook:comment:1",
      venue: "moltbook",
      actionType: "comment_on_post",
      createdAt: "2026-05-19T09:00:00.000Z",
      status: "commented",
      promptProfileId: "default-technical-soft-cta",
      promptVariantId: "operator-problem-solution",
      promptParameters: {
        layout: "problem_solution",
        messageStyle: "technical",
        tone: "operator",
        technicalDepth: "deep",
        creativity: "balanced"
      },
      clickCount: 2,
      privateMessageCount: 1
    }
  });

  const store = await loadPromptRotationStore(promptRotationStatePath);
  assert.equal(store.history.length, 1);
  assert.equal(store.history[0]?.venue, "moltbook");
  assert.equal(store.history[0]?.promptVariantId, "operator-problem-solution");
  assert.equal(store.state.actionsSinceRotation, 1);
});
