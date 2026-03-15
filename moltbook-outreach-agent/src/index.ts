#!/usr/bin/env node

import { loadRuntimeConfig, saveStoredCredentials } from "./config.js";
import { runHeartbeat } from "./heartbeat.js";
import { MoltbookApiClient } from "./moltbook-api.js";
import { loadProductFacts } from "./product-facts.js";

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
  coti-moltbook-outreach-agent facts
  coti-moltbook-outreach-agent heartbeat`);
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
    case "facts": {
      const config = await loadRuntimeConfig();
      const facts = await loadProductFacts(config);
      console.log(JSON.stringify(facts, null, 2));
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

