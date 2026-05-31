import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { getRedditControllerConfig, type MoltbookRuntimeConfig, type RedditControllerKind } from "./config.js";
import { RedditReddapiClient, resolveReddapiPostUrl } from "./reddit-reddapi.js";
import type { OutreachAgentMode } from "./venue.js";
import type { VenueAction } from "./venue.js";

const REDDIT_WEB_BASE_URL = "https://www.reddit.com";

export type RedditPublishableActionType = Extract<
  VenueAction["type"],
  "create_post" | "comment_on_post" | "reply_to_comment"
>;
export type RedditReadableActionType = "search_subreddit" | "list_subreddit_posts" | "read_thread";
export type RedditBrowserActionType = RedditPublishableActionType | RedditReadableActionType;

type RedditCreatePostAction = VenueAction & { type: "create_post"; title: string; content: string };
type RedditCommentOnPostAction = VenueAction & { type: "comment_on_post"; parentId: string; content: string };
type RedditReplyToCommentAction = VenueAction & {
  type: "reply_to_comment";
  candidateId: string;
  content: string;
};
type RedditPublishableAction =
  | RedditCreatePostAction
  | RedditCommentOnPostAction
  | RedditReplyToCommentAction;

export interface RedditControllerContext {
  mode: OutreachAgentMode;
  allowedSurfaces: readonly string[];
  venueAccountId?: string;
}

export interface RedditPublishResult {
  remoteContentId?: string;
  remoteContentUrl?: string;
  raw?: unknown;
}

export interface RedditCommentState {
  id: string;
  body: string;
  author?: string;
  permalink?: string;
  score?: number;
  createdUtc?: number;
  parentId?: string;
  depth: number;
  replies?: RedditCommentState[];
}

export interface RedditThreadState {
  id: string;
  subreddit: string;
  title: string;
  body?: string;
  author?: string;
  permalink?: string;
  url?: string;
  score?: number;
  commentCount?: number;
  createdUtc?: number;
  locked?: boolean;
  archived?: boolean;
  removed?: boolean;
  alreadyParticipated?: boolean;
  comments: RedditCommentState[];
}

export interface RedditSearchResult {
  id: string;
  subreddit: string;
  title: string;
  body?: string;
  author?: string;
  permalink?: string;
  url?: string;
  score?: number;
  commentCount?: number;
  createdUtc?: number;
}

export interface RedditConversationSnapshot {
  thread: RedditThreadState;
  source: "browser" | "api" | "reddapi" | "input";
  capturedAt: string;
  /** Thread where we have prior outbound participation. */
  ownThread?: boolean;
}

export type RedditBrowserReadAction =
  | {
      id: string;
      type: "search_subreddit";
      subreddit: string;
      query: string;
      sort?: "relevance" | "hot" | "new" | "top" | "comments";
      time?: "hour" | "day" | "week" | "month" | "year" | "all";
      limit?: number;
    }
  | {
      id: string;
      type: "list_subreddit_posts";
      subreddit: string;
      sort?: "hot" | "new" | "rising" | "top";
      limit?: number;
    }
  | {
      id: string;
      type: "read_thread";
      url?: string;
      postId?: string;
      subreddit?: string;
      limit?: number;
    };

export type RedditBrowserReadResult =
  | {
      type: "search_subreddit" | "list_subreddit_posts";
      items: RedditSearchResult[];
    }
  | {
      type: "read_thread";
      thread: RedditThreadState;
    };

export interface RedditController {
  readonly id: RedditControllerKind;
  publishAction(action: VenueAction, context: RedditControllerContext): Promise<RedditPublishResult>;
}

export interface RedditBrowserBridgePublishRequest {
  requestId: string;
  createdAt: string;
  controller: "browser";
  venue: "reddit";
  action: {
    id: string;
    type: RedditPublishableActionType;
    surface?: string;
    title?: string;
    content?: string;
    parentId?: string;
    candidateId?: string;
    raw?: unknown;
  };
  context: {
    mode: OutreachAgentMode;
    allowedSurfaces: readonly string[];
    venueAccountId?: string;
  };
}

export interface RedditBrowserBridgeReadRequest {
  requestId: string;
  createdAt: string;
  controller: "browser";
  venue: "reddit";
  action: RedditBrowserReadAction;
  context: {
    mode: OutreachAgentMode;
    allowedSurfaces: readonly string[];
    venueAccountId?: string;
  };
}

export type RedditBrowserBridgeRequest =
  | RedditBrowserBridgePublishRequest
  | RedditBrowserBridgeReadRequest;

export interface RedditBrowserBridgeResponseSuccess {
  requestId: string;
  ok: true;
  remoteContentId?: string;
  remoteContentUrl?: string;
  result?: RedditBrowserReadResult;
  raw?: unknown;
}

export interface RedditBrowserBridgeResponseFailure {
  requestId: string;
  ok: false;
  code:
    | "login_required"
    | "anti_bot_challenge"
    | "editor_missing"
    | "submit_failed"
    | "unsupported_action"
    | "bridge_error";
  message: string;
  raw?: unknown;
}

export type RedditBrowserBridgeResponse =
  | RedditBrowserBridgeResponseSuccess
  | RedditBrowserBridgeResponseFailure;

export class RedditControllerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly raw?: unknown
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class RedditUnsupportedActionError extends RedditControllerError {
  constructor(actionType: VenueAction["type"]) {
    super(`Reddit controller does not support action type ${actionType}.`, "unsupported_action");
  }
}

export class RedditManualReviewRequiredError extends RedditControllerError {
  constructor() {
    super("Reddit controller is set to manual; publishing is disabled for this runtime.", "manual_review_required");
  }
}

export class RedditControllerConfigurationError extends RedditControllerError {
  constructor(message: string) {
    super(message, "invalid_configuration");
  }
}

export class RedditLoginRequiredError extends RedditControllerError {
  constructor(message = "Reddit browser controller requires an authenticated browser session.", raw?: unknown) {
    super(message, "login_required", raw);
  }
}

export class RedditAntiBotChallengeError extends RedditControllerError {
  constructor(message = "Reddit browser controller was blocked by an anti-bot challenge.", raw?: unknown) {
    super(message, "anti_bot_challenge", raw);
  }
}

export class RedditBrowserEditorError extends RedditControllerError {
  constructor(message = "Reddit browser controller could not find the editor UI.", raw?: unknown) {
    super(message, "editor_missing", raw);
  }
}

export class RedditBrowserSubmitError extends RedditControllerError {
  constructor(message = "Reddit browser controller failed to submit the action.", raw?: unknown) {
    super(message, "submit_failed", raw);
  }
}

export class RedditBrowserBridgeTimeoutError extends RedditControllerError {
  constructor(bridgeDir: string, timeoutMs: number) {
    super(
      `Timed out waiting for Reddit browser response in ${bridgeDir} after ${timeoutMs}ms.`,
      "bridge_timeout"
    );
  }
}

export function createRedditController(
  config: MoltbookRuntimeConfig,
  dependencies: { fetchImpl?: typeof fetch } = {}
): RedditController {
  const redditConfig = getRedditControllerConfig(config);
  switch (redditConfig.controller) {
    case "manual":
      return new RedditManualController();
    case "browser":
      return new RedditBrowserController(config);
    case "api":
      return new RedditApiController(config, dependencies.fetchImpl ?? fetch);
    case "reddapi":
      return new RedditReddapiController(config, dependencies.fetchImpl ?? fetch);
  }
}

export class RedditManualController implements RedditController {
  readonly id = "manual" as const;

  async publishAction(_action: VenueAction, _context: RedditControllerContext): Promise<RedditPublishResult> {
    throw new RedditManualReviewRequiredError();
  }
}

export class RedditApiController implements RedditController {
  readonly id = "api" as const;

  constructor(
    private readonly config: MoltbookRuntimeConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async publishAction(action: VenueAction, context: RedditControllerContext): Promise<RedditPublishResult> {
    const publishableAction = assertRedditPublishableAction(action);
    const apiConfig = getRedditControllerConfig(this.config).api;
    if (!apiConfig.accessToken) {
      throw new RedditControllerConfigurationError(
        "Reddit API controller requires REDDIT_ACCESS_TOKEN."
      );
    }
    if (!apiConfig.userAgent) {
      throw new RedditControllerConfigurationError(
        "Reddit API controller requires REDDIT_USER_AGENT."
      );
    }

    switch (publishableAction.type) {
      case "create_post":
        return this.submitSelfPost(publishableAction, context);
      case "comment_on_post":
        return this.submitComment({
          action: publishableAction,
          thingId: toRedditThingId(publishableAction.parentId, "t3")
        });
      case "reply_to_comment":
        return this.submitComment({
          action: publishableAction,
          thingId: toRedditThingId(publishableAction.candidateId, "t1")
        });
    }
  }

  private async submitSelfPost(
    action: RedditCreatePostAction,
    context: RedditControllerContext
  ): Promise<RedditPublishResult> {
    const surface = action.surface;
    if (!surface) {
      throw new RedditControllerConfigurationError("Reddit create_post requires action.surface (subreddit).");
    }
    assertSurfaceAllowed(surface, context.allowedSurfaces);

    return this.postForm("/api/submit", {
      api_type: "json",
      kind: "self",
      sr: surface,
      title: action.title,
      text: action.content,
      resubmit: "true"
    });
  }

  private async submitComment(input: {
    action: RedditCommentOnPostAction | RedditReplyToCommentAction;
    thingId: string;
  }): Promise<RedditPublishResult> {
    return this.postForm("/api/comment", {
      api_type: "json",
      thing_id: input.thingId,
      text: input.action.content
    });
  }

  private async postForm(endpoint: string, body: Record<string, string>): Promise<RedditPublishResult> {
    const apiConfig = getRedditControllerConfig(this.config).api;
    const response = await this.fetchImpl(new URL(endpoint, apiConfig.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiConfig.accessToken!}`,
        "User-Agent": apiConfig.userAgent!,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams(body).toString()
    });

    if (!response.ok) {
      throw new RedditControllerError(
        `Reddit API request failed with ${response.status}: ${await response.text()}`,
        "api_http_error"
      );
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const errors = extractApiErrors(payload);
    if (errors.length > 0) {
      throw new RedditControllerError(
        `Reddit API rejected the request: ${errors.join("; ")}`,
        "api_error",
        payload
      );
    }

    const thing = extractRedditThing(payload);
    return {
      remoteContentId: stringValue(thing?.id) ?? stringValue(thing?.name),
      remoteContentUrl: normalizeRedditUrl(
        stringValue(thing?.permalink) ?? stringValue((payload.json as Record<string, unknown> | undefined)?.data)
      ),
      raw: payload
    };
  }
}

export class RedditReddapiController implements RedditController {
  readonly id = "reddapi" as const;
  private client?: RedditReddapiClient;

  constructor(
    private readonly config: MoltbookRuntimeConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async publishAction(action: VenueAction, _context: RedditControllerContext): Promise<RedditPublishResult> {
    const publishableAction = assertRedditPublishableAction(action);
    const redditConfig = getRedditControllerConfig(this.config).reddapi;
    if (!redditConfig.rapidApiKey || !redditConfig.proxy) {
      throw new RedditControllerConfigurationError(
        "ReddAPI controller requires RAPIDAPI_REDDAPI_KEY and REDDAPI_PROXY."
      );
    }

    const client = this.getClient();
    switch (publishableAction.type) {
      case "create_post":
        throw new RedditControllerConfigurationError(
          "ReddAPI controller does not support create_post yet — use browser or official API."
        );
      case "comment_on_post":
      case "reply_to_comment": {
        const postUrl = resolveReddapiPostUrl({
          raw: publishableAction.raw,
          surface: publishableAction.surface,
          parentId:
            publishableAction.type === "comment_on_post"
              ? publishableAction.parentId
              : publishableAction.parentId,
          candidateId:
            publishableAction.type === "reply_to_comment" ? publishableAction.candidateId : undefined,
          type: publishableAction.type
        });
        return client.postComment(postUrl, publishableAction.content);
      }
    }
  }

  private getClient(): RedditReddapiClient {
    if (!this.client) {
      const redditConfig = getRedditControllerConfig(this.config).reddapi;
      if (!redditConfig.rapidApiKey || !redditConfig.proxy) {
        throw new RedditControllerConfigurationError(
          "ReddAPI controller requires RAPIDAPI_REDDAPI_KEY and REDDAPI_PROXY."
        );
      }
      this.client = new RedditReddapiClient(
        {
          rapidApiKey: redditConfig.rapidApiKey,
          proxy: redditConfig.proxy,
          storageStatePath: redditConfig.storageStatePath,
          rapidApiHost: redditConfig.rapidApiHost,
          bearerOverride: redditConfig.bearerOverride
        },
        this.fetchImpl
      );
    }
    return this.client;
  }
}

export class RedditBrowserController implements RedditController {
  readonly id = "browser" as const;
  private requestCount = 0;

  constructor(private readonly config: MoltbookRuntimeConfig) {}

  async publishAction(action: VenueAction, context: RedditControllerContext): Promise<RedditPublishResult> {
    const publishableAction = assertRedditPublishableAction(action);
    const response = await this.sendBridgeRequest(buildBridgePublishRequest(
      `reddit-browser-${Date.now()}-${process.pid}-${this.requestCount++}`,
      publishableAction,
      context
    ));

    return {
      remoteContentId: response.remoteContentId,
      remoteContentUrl: response.remoteContentUrl,
      raw: response.raw
    };
  }

  async readAction(
    action: RedditBrowserReadAction,
    context: RedditControllerContext
  ): Promise<RedditBrowserReadResult> {
    const response = await this.sendBridgeRequest(buildBridgeReadRequest(
      `reddit-browser-read-${Date.now()}-${process.pid}-${this.requestCount++}`,
      action,
      context
    ));
    if (!response.result) {
      throw new RedditControllerError("Reddit browser read response did not include a result.", "bridge_error", response.raw);
    }
    return response.result;
  }

  private async sendBridgeRequest(
    request: RedditBrowserBridgeRequest
  ): Promise<RedditBrowserBridgeResponseSuccess> {
    const bridgeConfig = getRedditControllerConfig(this.config).browserBridge;
    const requestsDir = path.join(bridgeConfig.bridgeDir, "requests");
    const responsesDir = path.join(bridgeConfig.bridgeDir, "responses");
    const requestPath = path.join(requestsDir, `${request.requestId}.json`);
    const responsePath = path.join(responsesDir, `${request.requestId}.json`);

    await mkdir(requestsDir, { recursive: true });
    await mkdir(responsesDir, { recursive: true });
    await writeJsonAtomic(requestPath, request);

    try {
      const response = await waitForBridgeResponse(
        responsePath,
        bridgeConfig.responseTimeoutMs,
        bridgeConfig.pollIntervalMs
      );
      if (!response.ok) {
        throw mapBrowserBridgeError(response);
      }

      return response;
    } finally {
      await rm(requestPath, { force: true }).catch(() => undefined);
      await rm(responsePath, { force: true }).catch(() => undefined);
    }
  }
}

function buildBridgePublishRequest(
  requestId: string,
  action: RedditPublishableAction,
  context: RedditControllerContext
): RedditBrowserBridgePublishRequest {
  return {
    requestId,
    createdAt: new Date().toISOString(),
    controller: "browser",
    venue: "reddit",
    action: {
      id: action.id,
      type: action.type,
      surface: action.surface,
      title: action.title,
      content: action.content,
      parentId: action.parentId,
      candidateId: action.candidateId,
      raw: action.raw
    },
    context: {
      mode: context.mode,
      allowedSurfaces: [...context.allowedSurfaces],
      venueAccountId: context.venueAccountId
    }
  };
}

function buildBridgeReadRequest(
  requestId: string,
  action: RedditBrowserReadAction,
  context: RedditControllerContext
): RedditBrowserBridgeReadRequest {
  return {
    requestId,
    createdAt: new Date().toISOString(),
    controller: "browser",
    venue: "reddit",
    action,
    context: {
      mode: context.mode,
      allowedSurfaces: [...context.allowedSurfaces],
      venueAccountId: context.venueAccountId
    }
  };
}

async function waitForBridgeResponse(
  responsePath: string,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<RedditBrowserBridgeResponse> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const raw = await readFile(responsePath, "utf8");
      return JSON.parse(raw) as RedditBrowserBridgeResponse;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
    await sleep(pollIntervalMs);
  }

  throw new RedditBrowserBridgeTimeoutError(path.dirname(path.dirname(responsePath)), timeoutMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await rename(tempPath, filePath);
}

function assertRedditPublishableAction(
  action: VenueAction
): RedditPublishableAction {
  if (
    action.type !== "create_post" &&
    action.type !== "comment_on_post" &&
    action.type !== "reply_to_comment"
  ) {
    throw new RedditUnsupportedActionError(action.type);
  }
  if (action.type === "create_post") {
    if (!action.title || !action.content) {
      throw new RedditControllerConfigurationError(
        "Reddit create_post requires title and content."
      );
    }
    return action as RedditCreatePostAction;
  }
  if (action.type === "comment_on_post") {
    if (!action.parentId || !action.content) {
      throw new RedditControllerConfigurationError(
        "Reddit comment_on_post requires parentId and content."
      );
    }
    return action as RedditCommentOnPostAction;
  }
  if (!action.candidateId || !action.content) {
    throw new RedditControllerConfigurationError(
      "Reddit reply_to_comment requires candidateId and content."
    );
  }
  return action as RedditReplyToCommentAction;
}

function assertSurfaceAllowed(surface: string, allowedSurfaces: readonly string[]): void {
  if (allowedSurfaces.length === 0) {
    return;
  }
  const normalized = surface.toLowerCase();
  if (!allowedSurfaces.some((entry) => entry.toLowerCase() === normalized)) {
    throw new RedditControllerError(
      `Surface r/${surface} is not in OUTREACH_AGENT_ALLOWED_SURFACES.`,
      "surface_not_allowed"
    );
  }
}

function toRedditThingId(value: string | undefined, prefix: "t1" | "t3"): string {
  if (!value) {
    throw new RedditControllerConfigurationError(`Missing Reddit identifier for ${prefix}.`);
  }
  return value.startsWith(`${prefix}_`) ? value : `${prefix}_${value}`;
}

function extractApiErrors(payload: Record<string, unknown>): string[] {
  const errors = (payload.json as Record<string, unknown> | undefined)?.errors;
  if (!Array.isArray(errors)) {
    return [];
  }

  return errors
    .map((entry) => {
      if (!Array.isArray(entry)) {
        return undefined;
      }
      return entry.map((part) => String(part)).join(": ");
    })
    .filter((entry): entry is string => Boolean(entry));
}

function extractRedditThing(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const json = payload.json;
  if (!isRecord(json)) {
    return undefined;
  }
  const data = json.data;
  if (!isRecord(data)) {
    return undefined;
  }
  if (Array.isArray(data.things)) {
    const first = data.things[0];
    if (isRecord(first) && isRecord(first.data)) {
      return first.data;
    }
  }
  return data;
}

function normalizeRedditUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value, REDDIT_WEB_BASE_URL).toString();
  } catch {
    return undefined;
  }
}

function mapBrowserBridgeError(response: RedditBrowserBridgeResponseFailure): RedditControllerError {
  switch (response.code) {
    case "login_required":
      return new RedditLoginRequiredError(response.message, response.raw);
    case "anti_bot_challenge":
      return new RedditAntiBotChallengeError(response.message, response.raw);
    case "editor_missing":
      return new RedditBrowserEditorError(response.message, response.raw);
    case "submit_failed":
      return new RedditBrowserSubmitError(response.message, response.raw);
    case "unsupported_action":
      return new RedditUnsupportedActionError("review_only");
    default:
      return new RedditControllerError(response.message, response.code, response.raw);
  }
}

function stringValue(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}
