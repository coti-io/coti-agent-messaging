import {
  getOutreachAgentConfig,
  getRedditOperatingAgentConfig
} from "./config.js";
import { DEFAULT_REDDIT_DISCOVERY_POOL } from "./reddit-outreach.js";
import type { RedditOutboundMemoryEntry } from "./reddit-outreach-types.js";
import {
  buildScanLedgerMap,
  collectScanLedgerExcludePostIds,
  mergeScanLedgerUpdates,
  pruneScanLedger
} from "./reddit-scan-ledger.js";
import {
  collectDiscoveryExcludePostIds,
  collectOwnThreadTargets,
  createDiscoveryRng,
  resolveIngestionBackend,
  resolveIngestionLimits,
  sampleDiscoverySubreddits,
  type DiscoveryIngestionOptions
} from "./reddit-ingestion-discovery.js";
import { snapshotsToSourceItems } from "./reddit-ingestion-snapshots.js";
import {
  ingestViaApi,
  ingestViaBrowser,
  ingestViaReddapi,
  ingestViaUnofficial
} from "./reddit-ingestion-backends.js";
import { dedupeSnapshots } from "./reddit-ingestion-utils.js";
import type { RedditIngestionDiagnostics, RedditIngestionInput, RedditIngestionResult } from "./reddit-ingestion-types.js";

export * from "./reddit-ingestion-types.js";
export * from "./reddit-ingestion-discovery.js";
export { snapshotsToSourceItems } from "./reddit-ingestion-snapshots.js";

function isRedditBrowserHeadless(): boolean {
  const value = process.env.OUTREACH_REDDIT_BROWSER_HEADLESS;
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function appendHeadlessDiscoveryWarning(
  skipped: string[],
  input: {
    usedBrowser: boolean;
    headless: boolean;
    maxDiscoveryThreadReads: number;
    subredditCount: number;
    discoveryThreadSnapshots: number;
  }
): void {
  if (
    !input.headless ||
    !input.usedBrowser ||
    input.maxDiscoveryThreadReads <= 0 ||
    input.subredditCount <= 0 ||
    input.discoveryThreadSnapshots > 0
  ) {
    return;
  }
  skipped.push(
    "discovery_warning: headless browser returned zero discovery snapshots; Reddit often blocks headless — run a headed worker (npm run reddit:browser-worker)"
  );
}


export async function ingestRedditState(input: RedditIngestionInput): Promise<RedditIngestionResult> {
  const capturedAt = new Date().toISOString();
  const now = new Date(capturedAt);
  const operating = getRedditOperatingAgentConfig(input.config);
  const discoveryPool =
    input.subredditPool ??
    (operating.discoverySubredditPool.length > 0
      ? operating.discoverySubredditPool
      : [...DEFAULT_REDDIT_DISCOVERY_POOL]);
  const subsPerRun = input.discoverySubsPerRun ?? operating.discoverySubsPerRun;
  const discoveryRng = createDiscoveryRng(input.discoverySeed);
  const subreddits = input.subreddits?.length
    ? [...input.subreddits]
    : sampleDiscoverySubreddits(discoveryPool, subsPerRun, discoveryRng);
  const queries = input.queries ?? operating.searchQueries;
  const source = input.source ?? "auto";
  const history = input.history ?? [];
  const scanLedgerEntries = input.scanLedger ?? [];
  const scanLedgerTtlHours = input.scanLedgerTtlHours ?? operating.scanLedgerTtlHours;
  const scanLedgerMaxEntries = input.scanLedgerMaxEntries ?? operating.scanLedgerMaxEntries;
  const scanLedgerMap = buildScanLedgerMap(scanLedgerEntries);
  const limits = resolveIngestionLimits(input, operating);
  const skipped: string[] = [];
  const ownThreadTargets = collectOwnThreadTargets(history);

  const discoveryExcludePostIds = new Set([
    ...collectDiscoveryExcludePostIds(history),
    ...collectScanLedgerExcludePostIds(scanLedgerEntries, now, scanLedgerTtlHours)
  ]);
  const discoveryPickStrategy = input.discoveryPickStrategy ?? "stochastic";
  const diagnostics: RedditIngestionDiagnostics = {
    discoverySubredditPool: [...discoveryPool],
    sampledSubreddits: [...subreddits],
    subreddits: [...subreddits],
    discoverySearchQueries: [],
    discoveryListingSorts: [],
    discoveryListingPages: [],
    discoverySearchPages: [],
    excludedThreadPostIds: [...discoveryExcludePostIds],
    scanLedgerSkippedScrapes: 0,
    discoveryPickStrategy,
    browserHeadless: isRedditBrowserHeadless(),
    readViaBrowser: false,
    readViaReddapi: false,
    readViaUnofficial: false
  };

  const ingestionBackend = resolveIngestionBackend(source, input.config, operating);
  diagnostics.readViaBrowser = ingestionBackend === "browser";
  diagnostics.readViaReddapi = ingestionBackend === "reddapi";
  diagnostics.readViaUnofficial = ingestionBackend === "unofficial";
  const discoveryOptions: DiscoveryIngestionOptions = {
    random: discoveryRng,
    excludePostIds: discoveryExcludePostIds,
    pickStrategy: discoveryPickStrategy,
    diagnostics,
    scanLedgerMap,
    scanLedgerTtlHours,
    now
  };
  const snapshots =
    ingestionBackend === "browser"
      ? await ingestViaBrowser(
          input.config,
          subreddits,
          queries,
          limits,
          ownThreadTargets,
          skipped,
          discoveryOptions
        )
      : ingestionBackend === "reddapi"
        ? await ingestViaReddapi(
            input.config,
            subreddits,
            queries,
            limits,
            ownThreadTargets,
            skipped,
            discoveryOptions
          )
        : ingestionBackend === "unofficial"
          ? await ingestViaUnofficial(
              input.config,
              subreddits,
              queries,
              limits,
              ownThreadTargets,
              skipped,
              discoveryOptions
            )
        : await ingestViaApi(
            input.config,
            subreddits,
            queries,
            limits,
            ownThreadTargets,
            skipped,
            discoveryOptions
          );

  const deduped = dedupeSnapshots(snapshots);
  const agent = getOutreachAgentConfig(input.config);
  const discoveryThreadSnapshots = deduped.filter((snapshot) => !snapshot.ownThread).length;
  appendHeadlessDiscoveryWarning(skipped, {
    usedBrowser: diagnostics.readViaBrowser,
    headless: isRedditBrowserHeadless(),
    maxDiscoveryThreadReads: limits.maxDiscoveryThreadReads,
    subredditCount: subreddits.length,
    discoveryThreadSnapshots
  });
  const scanLedger = pruneScanLedger(
    mergeScanLedgerUpdates(scanLedgerEntries, deduped, capturedAt),
    scanLedgerMaxEntries
  );

  return {
    capturedAt,
    snapshots: deduped,
    sourceItems: snapshotsToSourceItems(deduped, history, {
      venueAccountId: agent.venueAccountId,
      scanLedgerMap
    }),
    skipped,
    ownThreadTargets: ownThreadTargets.length,
    ownThreadSnapshots: deduped.filter((snapshot) => snapshot.ownThread).length,
    discoveryThreadSnapshots,
    sampledSubreddits: [...subreddits],
    scanLedger,
    diagnostics
  };
}
