import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { discoverAgents } from "../src/discovery";
import { extractRecentPublishedFromState } from "../src/content";

test("extractRecentPublishedFromState returns all post/comment/reply artifacts newest first", () => {
  const items = extractRecentPublishedFromState({
    recentGeneratedArtifacts: [
      {
        id: "post:older",
        type: "post",
        title: "Older",
        content: "older body",
        createdAt: "2026-05-04T10:00:00.000Z",
        promptProfileId: "profile-a"
      },
      {
        id: "comment:newer",
        type: "comment",
        content: "newer body",
        createdAt: "2026-05-04T12:00:00.000Z",
        outreachRef: {
          id: "ref-1",
          remoteContentUrl: "https://www.moltbook.com/post/post-1"
        }
      },
      {
        id: "upvote:ignored",
        type: "upvote",
        content: "nope",
        createdAt: "2026-05-04T13:00:00.000Z"
      }
    ]
  });

  assert.equal(items.length, 2);
  assert.equal(items[0]?.id, "comment:newer");
  assert.equal(items[0]?.type, "comment");
  assert.equal(items[0]?.contentUrl, "https://www.moltbook.com/post/post-1");
  assert.equal(items[0]?.attributed, true);
  assert.equal(items[1]?.id, "post:older");
  assert.equal(items[1]?.attributed, false);
  assert.match(items[1]?.contentPreview ?? "", /Older — older body/);
});

test("discoverAgents exposes recentPublished from runtime state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "analytics-content-"));
  const agentDir = path.join(tempDir, "agent-a");
  const runtimeDir = path.join(agentDir, ".runtime");

  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "agent.json"),
    JSON.stringify({ agentId: "agent-a", displayName: "Agent A" }),
    "utf8"
  );
  await writeFile(
    path.join(runtimeDir, "state.json"),
    JSON.stringify({
      recentGeneratedArtifacts: [
        {
          id: "reply:1",
          type: "reply",
          content: "reply text",
          createdAt: "2026-05-04T11:00:00.000Z"
        }
      ]
    }),
    "utf8"
  );

  try {
    const agents = await discoverAgents(tempDir, new Date("2026-05-04T12:00:00.000Z"));
    assert.equal(agents[0]?.recentPublished?.length, 1);
    assert.equal(agents[0]?.recentPublished?.[0]?.type, "reply");
    assert.equal(agents[0]?.recentPublished?.[0]?.contentPreview, "reply text");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
