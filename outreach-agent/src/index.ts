#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runBridgeServerCli } from "./bridge-server.js";
import { stopBridgeServer } from "./bridge-stop.js";
import { runRedditBrowserLoginCli } from "./reddit-browser-login.js";
import { runRedditBrowserWorkerCli } from "./reddit-browser-worker.js";
import { runRedditSessionCli } from "./reddit-session.js";
import { readAttributionSummaryFromStore, readMessageFunnelSummaryFromStore } from "./attribution-store.js";
import { getOutreachAgentConfig, getRedditControllerConfig, loadRuntimeConfig, saveStoredCredentials } from "./config.js";
import { mergeFeedPosts, rankDesignPartnerCandidates } from "./design-partners.js";
import { runExecutor, runHeartbeat } from "./heartbeat.js";
import { MoltbookApiClient, type MoltbookAgentProfile } from "./moltbook-api.js";
import {
  createInitialState,
  getEngagementSummary,
  normalizeState,
  type OutreachAgentState
} from "./policy.js";
import { loadProductFacts } from "./product-facts.js";
import { loadStateFromStorage, readStoredEngagementSummary } from "./storage.js";
import {
  DEFAULT_REDDIT_RULES_REGISTRY,
  DEFAULT_REDDIT_TARGETING,
  RedditReadOnlyClient,
  buildRedditReviewQueue,
  evaluateRedditOutcomes,
  parseRedditListing,
  type RedditOutboundMemoryEntry,
  type RedditRulesRegistry,
  type RedditSourceItem
} from "./reddit-outreach.js";
import {
  summarizeAttribution,
  type AttributionEvent,
  type OutreachRef
} from "./outreach-attribution.js";
import { createVenueProvider } from "./venue-factory.js";
import type { VenueAction } from "./venue.js";

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function printUsage(): void {
  console.log(`Usage:
  coti-outreach-agent register --name NAME --description DESCRIPTION
  coti-outreach-agent status
  coti-outreach-agent engagements
  coti-outreach-agent delete-post --post-id POST_ID
  coti-outreach-agent facts
  coti-outreach-agent venue-config
  coti-outreach-agent design-partners [--limit 10]
  coti-outreach-agent reddit-targets
  coti-outreach-agent reddit-scan [--input FILE] [--history FILE] [--rules FILE] [--output FILE]
  coti-outreach-agent reddit-evaluate --history FILE
  coti-outreach-agent reddit-publish --input FILE
  coti-outreach-agent reddit-browser-login [--storage-state FILE] [--startup-url URL]
  coti-outreach-agent reddit-browser-worker
  coti-outreach-agent reddit-session [--dry-run | --live] [--once] [--max-actions 1] [--subreddits sales,SaaS]
  coti-outreach-agent attribution-summary [--db FILE | --refs FILE --events FILE]
  coti-outreach-agent message-funnel [--db FILE]
  coti-outreach-agent bridge-server
  coti-outreach-agent bridge-stop
  coti-outreach-agent heartbeat
  coti-outreach-agent executor`);
}

async function flushStream(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.destroyed) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    stream.write("", (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function exitCliProcess(code: number): Promise<never> {
  await Promise.allSettled([flushStream(process.stdout), flushStream(process.stderr)]);
  process.exit(code);
}

async function loadLocalState(statePath: string): Promise<OutreachAgentState> {
  try {
    return await loadStateFromStorage(statePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return createInitialState();
    }
    throw error;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function loadRedditHistory(filePath: string | undefined): Promise<RedditOutboundMemoryEntry[]> {
  if (!filePath) {
    return [];
  }

  const raw = await readJsonFile<unknown>(filePath);
  if (Array.isArray(raw)) {
    return raw as RedditOutboundMemoryEntry[];
  }

  if (typeof raw === "object" && raw !== null && Array.isArray((raw as { history?: unknown }).history)) {
    return (raw as { history: RedditOutboundMemoryEntry[] }).history;
  }

  throw new Error(`Reddit history file must contain an array or { "history": [...] }: ${filePath}`);
}

async function loadRedditSourceItems(inputPath: string | undefined): Promise<RedditSourceItem[]> {
  if (inputPath) {
    return parseRedditListing(await readJsonFile<unknown>(inputPath));
  }

  const accessToken = process.env.REDDIT_ACCESS_TOKEN;
  const userAgent = process.env.REDDIT_USER_AGENT;
  if (!accessToken || !userAgent) {
    throw new Error(
      "reddit-scan requires --input FILE, or REDDIT_ACCESS_TOKEN plus REDDIT_USER_AGENT for live read-only monitoring."
    );
  }

  const limit = Number(getArg("--limit") ?? "10");
  const client = new RedditReadOnlyClient({
    accessToken,
    userAgent,
    baseUrl: process.env.REDDIT_BASE_URL
  });
  const batches = await Promise.all(
    DEFAULT_REDDIT_TARGETING.targetSubreddits.map((subreddit) =>
      client.getNewPosts(subreddit.name, Number.isFinite(limit) && limit > 0 ? limit : 10)
    )
  );

  return batches.flat();
}

async function loadRedditRules(filePath: string | undefined): Promise<RedditRulesRegistry> {
  return filePath ? readJsonFile<RedditRulesRegistry>(filePath) : DEFAULT_REDDIT_RULES_REGISTRY;
}

async function emitJson(value: unknown): Promise<void> {
  const outputPath = getArg("--output");
  if (outputPath) {
    await writeJsonFile(outputPath, value);
    console.log(JSON.stringify({ wrote: outputPath }, null, 2));
    return;
  }

  console.log(JSON.stringify(value, null, 2));
}

async function run(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help") {
    printUsage();
    return;
  }

  switch (command) {
    case "register": {
      const name = getArg("--name");
      const description = getArg("--description");
      if (!name || !description) {
        throw new Error("register requires --name and --description.");
      }

      const config = await loadRuntimeConfig();
      const api = new MoltbookApiClient({
        baseUrl: config.moltbookBaseUrl,
        autoVerify: false
      });
      const response = await api.registerAgent({ name, description });
      await saveStoredCredentials(config.credentialsPath, {
        apiKey: response.agent.api_key,
        agentName: name,
        claimUrl: response.agent.claim_url,
        verificationCode: response.agent.verification_code
      });

      console.log(
        JSON.stringify(
          {
            saved_credentials_to: config.credentialsPath,
            api_key: response.agent.api_key,
            claim_url: response.agent.claim_url,
            verification_code: response.agent.verification_code,
            next_step: "Send the claim_url to your human so they can activate the agent."
          },
          null,
          2
        )
      );
      return;
    }
    case "status": {
      const config = await loadRuntimeConfig({ requireApiKey: true });
      const api = new MoltbookApiClient({
        baseUrl: config.moltbookBaseUrl,
        apiKey: config.apiKey,
        autoVerify: config.autoVerify
      });
      const [status, me] = await Promise.all([api.getStatus(), api.getMe()]);
      console.log(JSON.stringify({ status, me }, null, 2));
      return;
    }
    case "engagements": {
      const config = await loadRuntimeConfig();
      console.log(JSON.stringify(await readStoredEngagementSummary(config.statePath), null, 2));
      return;
    }
    case "delete-post": {
      const postId = getArg("--post-id");
      if (!postId) {
        throw new Error("delete-post requires --post-id.");
      }

      const config = await loadRuntimeConfig({ requireApiKey: true });
      const api = new MoltbookApiClient({
        baseUrl: config.moltbookBaseUrl,
        apiKey: config.apiKey,
        autoVerify: false
      });
      const result = await api.deletePost(postId);
      console.log(JSON.stringify({ postId, ...result }, null, 2));
      return;
    }
    case "facts": {
      const config = await loadRuntimeConfig();
      const facts = await loadProductFacts(config);
      console.log(JSON.stringify(facts, null, 2));
      return;
    }
    case "venue-config": {
      const config = await loadRuntimeConfig({ requireVenue: true });
      console.log(
        JSON.stringify(
          {
            agent: config.agent,
            reddit: getOutreachAgentConfig(config).venue === "reddit" ? getRedditControllerConfig(config) : undefined
          },
          null,
          2
        )
      );
      return;
    }
    case "design-partners": {
      const config = await loadRuntimeConfig();
      const limit = Number(getArg("--limit") ?? "10");
      const candidateLimit = Number.isFinite(limit) && limit > 0 ? limit : 10;
      const api = new MoltbookApiClient({
        baseUrl: config.moltbookBaseUrl,
        apiKey: config.apiKey,
        autoVerify: false
      });
      const feedLimit = Number(getArg("--feed-limit") ?? "40");
      const feeds = await Promise.all([
        api.getFeed({ sort: "hot", limit: feedLimit }),
        api.getFeed({ sort: "top", limit: feedLimit }),
        api.getFeed({ sort: "rising", limit: feedLimit }),
        api.getFeed({ sort: "new", limit: feedLimit })
      ]);
      const posts = mergeFeedPosts(feeds);
      const firstPass = rankDesignPartnerCandidates({ posts }, Math.max(candidateLimit * 2, candidateLimit));
      const profileEntries = await Promise.all(
        firstPass.map(async (candidate): Promise<[string, MoltbookAgentProfile | undefined]> => {
          try {
            const profile = await api.getAgentProfile(candidate.agentName);
            return [candidate.agentName, profile.agent];
          } catch {
            return [candidate.agentName, undefined];
          }
        })
      );

      await emitJson({
        generatedAt: new Date().toISOString(),
        sourcePostCount: posts.length,
        candidates: rankDesignPartnerCandidates(
          {
            posts,
            profiles: Object.fromEntries(profileEntries)
          },
          candidateLimit
        )
      });
      return;
    }
    case "reddit-targets": {
      await emitJson({
        targeting: DEFAULT_REDDIT_TARGETING,
        rulesRegistry: DEFAULT_REDDIT_RULES_REGISTRY
      });
      return;
    }
    case "reddit-scan": {
      const [items, history, registry] = await Promise.all([
        loadRedditSourceItems(getArg("--input")),
        loadRedditHistory(getArg("--history")),
        loadRedditRules(getArg("--rules"))
      ]);
      const queue = buildRedditReviewQueue({
        items,
        history,
        registry
      });
      await emitJson(hasFlag("--summary") ? {
        generatedAt: queue.generatedAt,
        reviewItems: queue.items.length,
        ignoredItems: queue.ignored.length,
        items: queue.items.map((item) => ({
          id: item.id,
          subreddit: item.source.subreddit,
          action: item.action,
          status: item.status,
          relevanceScore: item.relevanceScore,
          riskScore: item.riskScore,
          draft: item.draft,
          blockedGates: item.gates
            .filter((gate) => gate.severity === "block" && !gate.passed)
            .map((gate) => gate.id)
        }))
      } : queue);
      return;
    }
    case "reddit-evaluate": {
      const historyPath = getArg("--history");
      if (!historyPath) {
        throw new Error("reddit-evaluate requires --history FILE.");
      }

      await emitJson(evaluateRedditOutcomes(await loadRedditHistory(historyPath)));
      return;
    }
    case "reddit-publish": {
      const inputPath = getArg("--input");
      if (!inputPath) {
        throw new Error("reddit-publish requires --input FILE.");
      }
      const config = await loadRuntimeConfig({ requireVenue: true });
      const agent = getOutreachAgentConfig(config);
      if (agent.venue !== "reddit") {
        throw new Error("reddit-publish requires OUTREACH_AGENT_VENUE=reddit.");
      }
      const action = await readJsonFile<VenueAction>(inputPath);
      if (action.venue !== "reddit") {
        throw new Error("reddit-publish input must contain a Reddit VenueAction.");
      }
      const venue = createVenueProvider(config);
      await emitJson(await venue.publishAction(action));
      return;
    }
    case "reddit-browser-login": {
      await runRedditBrowserLoginCli();
      return;
    }
    case "reddit-browser-worker": {
      await runRedditBrowserWorkerCli();
      return;
    }
    case "reddit-session": {
      await runRedditSessionCli();
      return;
    }
    case "attribution-summary": {
      const dbPath = getArg("--db");
      const refsPath = getArg("--refs");
      const eventsPath = getArg("--events");
      if (dbPath) {
        await emitJson(
          await readAttributionSummaryFromStore(dbPath, {
            campaignId: getArg("--campaign-id")
          })
        );
        return;
      }
      const config = await loadRuntimeConfig();
      if (config.attributionDbPath && !refsPath && !eventsPath) {
        await emitJson(
          await readAttributionSummaryFromStore(config.attributionDbPath, {
            campaignId: getArg("--campaign-id")
          })
        );
        return;
      }
      if (!refsPath || !eventsPath) {
        throw new Error(
          "attribution-summary requires --db FILE, OUTREACH_ATTRIBUTION_DB_PATH, or --refs FILE and --events FILE."
        );
      }

      await emitJson(
        summarizeAttribution({
          refs: await readJsonFile<OutreachRef[]>(refsPath),
          events: await readJsonFile<AttributionEvent[]>(eventsPath)
        })
      );
      return;
    }
    case "message-funnel": {
      const dbPath = getArg("--db");
      if (dbPath) {
        await emitJson(await readMessageFunnelSummaryFromStore(dbPath));
        return;
      }
      const config = await loadRuntimeConfig();
      if (!config.attributionDbPath) {
        throw new Error("message-funnel requires --db FILE or OUTREACH_ATTRIBUTION_DB_PATH.");
      }
      await emitJson(await readMessageFunnelSummaryFromStore(config.attributionDbPath));
      return;
    }
    case "bridge-server": {
      await runBridgeServerCli();
      return;
    }
    case "bridge-stop": {
      console.log(JSON.stringify(await stopBridgeServer(), null, 2));
      return;
    }
    case "heartbeat": {
      const config = await loadRuntimeConfig({ requireVenue: true });
      const result = await runHeartbeat(config);
      console.log(result.summary);
      await exitCliProcess(0);
    }
    case "executor": {
      const config = await loadRuntimeConfig({ requireVenue: true });
      const result = await runExecutor(config);
      console.log(result.summary);
      await exitCliProcess(0);
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

void run().catch(async (error) => {
  console.error(error);
  await exitCliProcess(1);
});

