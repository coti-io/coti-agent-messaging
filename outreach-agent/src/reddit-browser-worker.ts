#!/usr/bin/env node

import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

import {
  RedditAntiBotChallengeError,
  RedditBrowserEditorError,
  RedditBrowserSubmitError,
  RedditControllerConfigurationError,
  RedditControllerError,
  RedditLoginRequiredError,
  type RedditBrowserBridgeRequest,
  type RedditBrowserBridgeResponseFailure,
  type RedditBrowserBridgeResponseSuccess
} from "./reddit-controller.js";

export interface RedditBrowserWorkerConfig {
  bridgeDir: string;
  requestsDir: string;
  processingDir: string;
  responsesDir: string;
  statusPath: string;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  headless: boolean;
  baseUrl: string;
  executablePath?: string;
  channel?: string;
  slowMoMs?: number;
  storageStatePath?: string;
  startupUrl: string;
}

export interface RedditBrowserWorkerHandle {
  config: RedditBrowserWorkerConfig;
  close(): Promise<void>;
}

export interface RedditBrowserAutomation {
  fulfill(request: RedditBrowserBridgeRequest): Promise<{
    remoteContentId?: string;
    remoteContentUrl?: string;
    raw?: unknown;
  }>;
  close(): Promise<void>;
}

interface RedditBrowserWorkerStatus {
  phase:
    | "starting"
    | "idle"
    | "processing_request"
    | "request_succeeded"
    | "request_failed"
    | "stopped";
  pid: number;
  bridgeDir: string;
  requestId?: string;
  requestPath?: string;
  responsePath?: string;
  error?: {
    name?: string;
    message?: string;
    code?: string;
  };
}

const DEFAULT_BROWSER_BASE_URL = "https://www.reddit.com";
const COMMENT_URL_PATTERN = /\/comments\/([^/?#]+)(?:\/[^/?#]+)?(?:\/([^/?#]+))?/i;
const LOGIN_URL_PATTERN = /\/login\b|\/register\b/i;
const ANTIBOT_URL_PATTERN = /captcha|challenge|verify/i;
const LOGIN_TEXT_PATTERNS = [/log in/i, /continue with google/i, /continue with email/i];
const ANTIBOT_TEXT_PATTERNS = [
  /verify you are human/i,
  /are you a human/i,
  /captcha/i,
  /unusual activity/i,
  /challenge/i
];

function defaultBridgeDir(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const packageRoot = path.resolve(path.dirname(currentFile), "..", "..");
  return path.join(packageRoot, ".bridge", "reddit-browser");
}

function defaultStorageStatePath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const packageRoot = path.resolve(path.dirname(currentFile), "..", "..");
  return path.join(packageRoot, ".browser", "reddit-storage-state.json");
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export function resolveRedditBrowserWorkerConfig(): RedditBrowserWorkerConfig {
  const bridgeDir = process.env.OUTREACH_REDDIT_BROWSER_BRIDGE_DIR ?? defaultBridgeDir();
  return {
    bridgeDir,
    requestsDir: path.join(bridgeDir, "requests"),
    processingDir: path.join(bridgeDir, "processing"),
    responsesDir: path.join(bridgeDir, "responses"),
    statusPath: path.join(bridgeDir, "status.json"),
    pollIntervalMs: parseNumber(process.env.OUTREACH_REDDIT_BROWSER_POLL_INTERVAL_MS, 500),
    requestTimeoutMs: parseNumber(process.env.OUTREACH_REDDIT_BROWSER_REQUEST_TIMEOUT_MS, 45_000),
    headless: parseBoolean(process.env.OUTREACH_REDDIT_BROWSER_HEADLESS, true),
    baseUrl: process.env.OUTREACH_REDDIT_BROWSER_BASE_URL ?? DEFAULT_BROWSER_BASE_URL,
    executablePath: getOptionalEnv("OUTREACH_REDDIT_BROWSER_EXECUTABLE_PATH"),
    channel: getOptionalEnv("OUTREACH_REDDIT_BROWSER_CHANNEL"),
    slowMoMs: Number.isFinite(Number(process.env.OUTREACH_REDDIT_BROWSER_SLOWMO_MS))
      ? Number(process.env.OUTREACH_REDDIT_BROWSER_SLOWMO_MS)
      : undefined,
    storageStatePath:
      getOptionalEnv("OUTREACH_REDDIT_BROWSER_STORAGE_STATE_PATH") ?? defaultStorageStatePath(),
    startupUrl: process.env.OUTREACH_REDDIT_BROWSER_STARTUP_URL ?? DEFAULT_BROWSER_BASE_URL
  };
}

export async function startRedditBrowserWorker(
  configInput: Partial<RedditBrowserWorkerConfig> = {},
  automationInput?: RedditBrowserAutomation
): Promise<RedditBrowserWorkerHandle> {
  const config = { ...resolveRedditBrowserWorkerConfig(), ...configInput };
  const automation = automationInput ?? new PlaywrightRedditBrowserAutomation(config);
  let closed = false;
  let loopPromise: Promise<void> | undefined;
  let lastIdleWriteAt = 0;

  await mkdir(config.requestsDir, { recursive: true });
  await mkdir(config.processingDir, { recursive: true });
  await mkdir(config.responsesDir, { recursive: true });
  await restoreProcessingFiles(config);
  await writeStatus(config.statusPath, {
    phase: "starting",
    pid: process.pid,
    bridgeDir: config.bridgeDir
  });

  loopPromise = (async () => {
    while (!closed) {
      const claimed = await claimNextRequest(config);
      if (!claimed) {
        if (Date.now() - lastIdleWriteAt >= config.pollIntervalMs * 4) {
          lastIdleWriteAt = Date.now();
          await writeStatus(config.statusPath, {
            phase: "idle",
            pid: process.pid,
            bridgeDir: config.bridgeDir
          });
        }
        await sleep(config.pollIntervalMs);
        continue;
      }

      const responsePath = path.join(config.responsesDir, `${stripJsonExtension(claimed.fileName)}.json`);
      try {
        const request = JSON.parse(await readFile(claimed.processingPath, "utf8")) as RedditBrowserBridgeRequest;
        await writeStatus(config.statusPath, {
          phase: "processing_request",
          pid: process.pid,
          bridgeDir: config.bridgeDir,
          requestId: request.requestId,
          requestPath: claimed.processingPath,
          responsePath
        });
        const result = await automation.fulfill(request);
        await writeJsonAtomic(responsePath, {
          requestId: request.requestId,
          ok: true,
          remoteContentId: result.remoteContentId,
          remoteContentUrl: result.remoteContentUrl,
          raw: result.raw
        } satisfies RedditBrowserBridgeResponseSuccess);
        await writeStatus(config.statusPath, {
          phase: "request_succeeded",
          pid: process.pid,
          bridgeDir: config.bridgeDir,
          requestId: request.requestId,
          requestPath: claimed.processingPath,
          responsePath
        });
      } catch (error) {
        const requestId = stripJsonExtension(claimed.fileName);
        const failure = toFailureResponse(requestId, error);
        await writeJsonAtomic(responsePath, failure);
        await writeStatus(config.statusPath, {
          phase: "request_failed",
          pid: process.pid,
          bridgeDir: config.bridgeDir,
          requestId,
          requestPath: claimed.processingPath,
          responsePath,
          error: {
            name: error instanceof Error ? error.name : undefined,
            message: error instanceof Error ? error.message : String(error),
            code: error instanceof RedditControllerError ? error.code : failure.code
          }
        });
      } finally {
        await unlink(claimed.processingPath).catch(() => undefined);
      }
    }
  })();

  return {
    config,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await loopPromise;
      await automation.close();
      await writeStatus(config.statusPath, {
        phase: "stopped",
        pid: process.pid,
        bridgeDir: config.bridgeDir
      });
    }
  };
}

async function restoreProcessingFiles(config: RedditBrowserWorkerConfig): Promise<void> {
  for (const fileName of await readdir(config.processingDir).catch(() => [] as string[])) {
    if (!fileName.endsWith(".json")) {
      continue;
    }
    await rename(
      path.join(config.processingDir, fileName),
      path.join(config.requestsDir, fileName)
    ).catch(() => undefined);
  }
}

async function claimNextRequest(
  config: RedditBrowserWorkerConfig
): Promise<{ fileName: string; processingPath: string } | undefined> {
  const entries = await readdir(config.requestsDir).catch(() => [] as string[]);
  const requestFiles = entries.filter((entry) => entry.endsWith(".json")).sort();
  for (const fileName of requestFiles) {
    const requestPath = path.join(config.requestsDir, fileName);
    const processingPath = path.join(config.processingDir, fileName);
    try {
      await rename(requestPath, processingPath);
      return {
        fileName,
        processingPath
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return undefined;
}

function toFailureResponse(requestId: string, error: unknown): RedditBrowserBridgeResponseFailure {
  if (error instanceof RedditControllerError) {
    return {
      requestId,
      ok: false,
      code: isSupportedBridgeErrorCode(error.code) ? error.code : "bridge_error",
      message: error.message,
      raw: error.raw
    };
  }
  return {
    requestId,
    ok: false,
    code: "bridge_error",
    message: error instanceof Error ? error.message : String(error)
  };
}

function isSupportedBridgeErrorCode(code: string): code is RedditBrowserBridgeResponseFailure["code"] {
  return (
    code === "login_required" ||
    code === "anti_bot_challenge" ||
    code === "editor_missing" ||
    code === "submit_failed" ||
    code === "unsupported_action" ||
    code === "bridge_error"
  );
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await rename(tempPath, filePath);
}

async function writeStatus(statusPath: string, value: RedditBrowserWorkerStatus): Promise<void> {
  await writeJsonAtomic(statusPath, value);
}

function stripJsonExtension(fileName: string): string {
  return fileName.endsWith(".json") ? fileName.slice(0, -5) : fileName;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class PlaywrightRedditBrowserAutomation implements RedditBrowserAutomation {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;

  constructor(private readonly config: RedditBrowserWorkerConfig) {}

  async fulfill(request: RedditBrowserBridgeRequest): Promise<{
    remoteContentId?: string;
    remoteContentUrl?: string;
    raw?: unknown;
  }> {
    const page = await this.getPage();
    switch (request.action.type) {
      case "create_post":
        return this.submitCreatePost(page, request);
      case "comment_on_post":
        return this.submitComment(page, request, false);
      case "reply_to_comment":
        return this.submitComment(page, request, true);
      default:
        throw new RedditControllerConfigurationError(
          `Reddit browser worker cannot fulfill action type ${request.action.type}.`
        );
    }
  }

  async close(): Promise<void> {
    await this.page?.close().catch(() => undefined);
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
  }

  private async getPage(): Promise<Page> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: this.config.headless,
        executablePath: this.config.executablePath,
        channel: this.config.channel,
        slowMo: this.config.slowMoMs
      });
    }

    if (!this.context) {
      this.context = await this.browser.newContext({
        storageState: await this.resolveStorageStateInput()
      });
    }

    if (!this.page) {
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(this.config.requestTimeoutMs);
      await this.page.goto(this.config.startupUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    }

    return this.page;
  }

  private async resolveStorageStateInput(): Promise<string | undefined> {
    if (!this.config.storageStatePath) {
      return undefined;
    }
    try {
      await stat(this.config.storageStatePath);
      return this.config.storageStatePath;
    } catch {
      return undefined;
    }
  }

  private async persistStorageState(): Promise<void> {
    if (!this.context || !this.config.storageStatePath) {
      return;
    }
    await mkdir(path.dirname(this.config.storageStatePath), { recursive: true });
    await this.context.storageState({ path: this.config.storageStatePath });
  }

  private async submitCreatePost(page: Page, request: RedditBrowserBridgeRequest) {
    const surface = request.action.surface;
    if (!surface) {
      throw new RedditControllerConfigurationError(
        "Reddit browser create_post requires action.surface."
      );
    }

    await this.gotoAndGuard(page, new URL(`/r/${surface}/submit`, this.config.baseUrl).toString());
    await this.maybeClickFirst(page, [
      '[role="tab"]:has-text("Text")',
      '[role="tab"]:has-text("Post")'
    ]);
    await this.fillFirst(page, [
      '[data-testid="post-title-input"] textarea',
      'textarea[placeholder*="Title"]',
      'input[name="title"]',
      'textarea'
    ], request.action.title ?? "", "post title");
    await this.fillRichTextEditor(page, request.action.content ?? "");
    await this.clickEnabledButton(page, [
      'button:has-text("Post")',
      'button[type="submit"]:has-text("Post")'
    ], "Reddit browser worker could not find the submit Post button.");
    await page.waitForURL(/\/comments\//i, {
      timeout: this.config.requestTimeoutMs
    }).catch(() => undefined);
    await this.guardPage(page);
    await this.persistStorageState();
    return this.buildSubmitResult(page, request.action.type, request.action.content);
  }

  private async submitComment(page: Page, request: RedditBrowserBridgeRequest, isReply: boolean) {
    const targetUrl = resolveRequestUrl(this.config.baseUrl, request, isReply);
    await this.gotoAndGuard(page, targetUrl);
    if (isReply) {
      await this.maybeClickFirst(page, [
        'button:has-text("Reply")',
        '[data-testid="comment_reply_button"]'
      ]);
    } else {
      await this.maybeClickFirst(page, [
        'button:has-text("Add a comment")',
        'button:has-text("Comment")'
      ]);
    }
    await this.fillRichTextEditor(page, request.action.content ?? "");
    await this.clickEnabledButton(
      page,
      isReply
        ? ['button:has-text("Reply")', 'button[type="submit"]:has-text("Reply")']
        : ['button:has-text("Comment")', 'button[type="submit"]:has-text("Comment")'],
      isReply
        ? "Reddit browser worker could not find the submit Reply button."
        : "Reddit browser worker could not find the submit Comment button."
    );
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    await this.guardPage(page);
    await this.persistStorageState();
    return this.buildSubmitResult(page, request.action.type, request.action.content);
  }

  private async gotoAndGuard(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("domcontentloaded");
    await this.guardPage(page);
  }

  private async guardPage(page: Page): Promise<void> {
    const url = page.url();
    if (LOGIN_URL_PATTERN.test(url) || (await this.pageHasAnyText(page, LOGIN_TEXT_PATTERNS))) {
      throw new RedditLoginRequiredError();
    }
    if (ANTIBOT_URL_PATTERN.test(url) || (await this.pageHasAnyText(page, ANTIBOT_TEXT_PATTERNS))) {
      throw new RedditAntiBotChallengeError();
    }
  }

  private async pageHasAnyText(page: Page, patterns: readonly RegExp[]): Promise<boolean> {
    for (const pattern of patterns) {
      const body = page.getByText(pattern).first();
      if (await body.isVisible().catch(() => false)) {
        return true;
      }
    }
    return false;
  }

  private async fillFirst(
    page: Page,
    selectors: readonly string[],
    value: string,
    label: string
  ): Promise<void> {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        await locator.fill(value);
        return;
      }
    }
    throw new RedditBrowserEditorError(`Reddit browser worker could not find the ${label} field.`);
  }

  private async fillRichTextEditor(page: Page, value: string): Promise<void> {
    const selectors = [
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'textarea[placeholder*="comment"]',
      'textarea[placeholder*="body"]',
      'textarea'
    ];

    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        await this.fillLocator(locator, value);
        return;
      }
    }
    throw new RedditBrowserEditorError();
  }

  private async fillLocator(locator: Locator, value: string): Promise<void> {
    try {
      await locator.fill(value);
      return;
    } catch {
      await locator.click();
      await locator.press(`${process.platform === "darwin" ? "Meta" : "Control"}+A`).catch(() => undefined);
      await locator.press("Backspace").catch(() => undefined);
      await locator.type(value);
    }
  }

  private async maybeClickFirst(page: Page, selectors: readonly string[]): Promise<boolean> {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        await locator.click().catch(() => undefined);
        return true;
      }
    }
    return false;
  }

  private async clickEnabledButton(
    page: Page,
    selectors: readonly string[],
    missingMessage: string
  ): Promise<void> {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (!(await locator.isVisible().catch(() => false))) {
        continue;
      }
      if (await locator.isDisabled().catch(() => false)) {
        continue;
      }
      await locator.click();
      return;
    }
    throw new RedditBrowserSubmitError(missingMessage);
  }

  private async buildSubmitResult(
    page: Page,
    actionType: RedditBrowserBridgeRequest["action"]["type"],
    content: string | undefined
  ) {
    const currentUrl = page.url();
    const permalink = content ? await findPermalinkForContent(page, content) : undefined;
    const remoteContentUrl = normalizeUrl(permalink ?? currentUrl, this.config.baseUrl);
    return {
      remoteContentId: extractRemoteContentId(remoteContentUrl, actionType),
      remoteContentUrl,
      raw: {
        pageUrl: currentUrl,
        permalink
      }
    };
  }
}

function resolveRequestUrl(baseUrl: string, request: RedditBrowserBridgeRequest, isReply: boolean): string {
  const raw = isRecord(request.action.raw) ? request.action.raw : undefined;
  const permalink = stringValue(raw?.permalink);
  const url = stringValue(raw?.url);
  if (permalink) {
    return normalizeUrl(permalink, baseUrl);
  }
  if (url) {
    return normalizeUrl(url, baseUrl);
  }
  if (request.action.type === "comment_on_post" && request.action.parentId) {
    return new URL(`/comments/${request.action.parentId}`, baseUrl).toString();
  }
  if (request.action.type === "reply_to_comment" && request.action.parentId && request.action.candidateId) {
    return new URL(`/comments/${request.action.parentId}/_/${request.action.candidateId}`, baseUrl).toString();
  }
  throw new RedditControllerConfigurationError(
    "Reddit browser worker requires action.raw.permalink/url, or enough ids to construct a thread URL."
  );
}

async function findPermalinkForContent(page: Page, content: string): Promise<string | undefined> {
  return page
    .evaluate((text) => {
      const normalized = text.trim().toLowerCase();
      if (!normalized) {
        return undefined;
      }
      const links = Array.from(document.querySelectorAll('a[href*="/comments/"]'));
      for (const link of links) {
        const container =
          link.closest("article") ??
          link.closest('[data-testid="comment"]') ??
          link.parentElement;
        const textContent = container?.textContent?.trim().toLowerCase() ?? "";
        if (textContent.includes(normalized)) {
          return (link as HTMLAnchorElement).href;
        }
      }
      return undefined;
    }, content)
    .catch(() => undefined);
}

function extractRemoteContentId(
  remoteUrl: string | undefined,
  actionType: RedditBrowserBridgeRequest["action"]["type"]
): string | undefined {
  if (!remoteUrl) {
    return undefined;
  }
  const match = remoteUrl.match(COMMENT_URL_PATTERN);
  if (!match) {
    return undefined;
  }
  if (actionType === "create_post") {
    return match[1];
  }
  return match[2] ?? undefined;
}

function normalizeUrl(value: string, baseUrl: string): string {
  return new URL(value, baseUrl).toString();
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function stringValue(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined;
}

export async function runRedditBrowserWorkerCli(): Promise<void> {
  const handle = await startRedditBrowserWorker();
  let shuttingDown = false;
  const shutdown = async (signal?: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await handle.close();
    } finally {
      if (signal) {
        process.exit(0);
      }
    }
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGHUP", () => {
    void shutdown("SIGHUP");
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        bridgeDir: handle.config.bridgeDir,
        requestsDir: handle.config.requestsDir,
        processingDir: handle.config.processingDir,
        responsesDir: handle.config.responsesDir,
        statusPath: handle.config.statusPath,
        headless: handle.config.headless,
        baseUrl: handle.config.baseUrl,
        storageStatePath: handle.config.storageStatePath
      },
      null,
      2
    )
  );
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  runRedditBrowserWorkerCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
