import { getOutreachAgentConfig, type MoltbookRuntimeConfig } from "./config.js";
import { createRedditController } from "./reddit-controller.js";
import { MoltbookVenueProvider } from "./moltbook-venue.js";
import { RedditVenueProvider } from "./reddit-venue.js";
import {
  hasVenueCapability,
  requireVenueCapability,
  type VenueProvider
} from "./venue.js";

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
  requireVenueCapability(provider, "heartbeatSources");
  if (!(provider instanceof MoltbookVenueProvider)) {
    throw new Error(`Expected MoltbookVenueProvider for venue ${provider.id}.`);
  }
  return provider;
}

export function assertRedditVenueProvider(provider: VenueProvider): RedditVenueProvider {
  if (!(provider instanceof RedditVenueProvider)) {
    throw new Error(`Expected RedditVenueProvider for venue ${provider.id}.`);
  }
  return provider;
}

export { hasVenueCapability, requireVenueCapability };
