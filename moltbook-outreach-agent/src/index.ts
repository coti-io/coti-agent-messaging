#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { runBridgeServerCli } from "./bridge-server.js";
import { stopBridgeServer } from "./bridge-stop.js";
import { loadRuntimeConfig, saveStoredCredentials } from "./config.js";
import { runHeartbeat } from "./heartbeat.js";
import { MoltbookApiClient } from "./moltbook-api.js";
import {
  createInitialState,
  getEngagementSummary,
  normalizeState,
  type OutreachAgentState
} from "./policy.js";
import { loadProductFacts } from "./product-facts.js";
import { loadStateFromStorage, readStoredEngagementSummary } from "./storage.js";

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

function printUsage(): void {
  console.log(`Usage:
  coti-moltbook-outreach-agent register --name NAME --description DESCRIPTION
  coti-moltbook-outreach-agent status
  coti-moltbook-outreach-agent engagements
  coti-moltbook-outreach-agent delete-post --post-id POST_ID
  coti-moltbook-outreach-agent facts
  coti-moltbook-outreach-agent bridge-server
  coti-moltbook-outreach-agent bridge-stop
  coti-moltbook-outreach-agent heartbeat`);
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
    case "bridge-server": {
      await runBridgeServerCli();
      return;
    }
    case "bridge-stop": {
      console.log(JSON.stringify(await stopBridgeServer(), null, 2));
      return;
    }
    case "heartbeat": {
      const config = await loadRuntimeConfig({ requireApiKey: true });
      const result = await runHeartbeat(config);
      console.log(result.summary);
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

