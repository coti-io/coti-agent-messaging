import { getOutreachAgentConfig, type MoltbookRuntimeConfig } from "./config.js";
import { createRedditController } from "./reddit-controller.js";
import { MoltbookVenueProvider } from "./moltbook-venue.js";
import { RedditVenueProvider } from "./reddit-venue.js";
import type { VenueProvider } from "./venue.js";

export function createVenueProvider(config: MoltbookRuntimeConfig): VenueProvider {
  const agent = getOutreachAgentConfig(config);
  switch (agent.venue) {
    case "moltbook":
      return new MoltbookVenueProvider(config);
    case "reddit":
      return new RedditVenueProvider(agent, createRedditController(config));
    default:
      throw new Error(`Unsupported outreach venue: ${agent.venue}`);
  }
}

export function assertMoltbookVenueProvider(provider: VenueProvider): MoltbookVenueProvider {
  if (!(provider instanceof MoltbookVenueProvider)) {
    throw new Error(`Heartbeat does not support venue ${provider.id} yet.`);
  }
  return provider;
}
