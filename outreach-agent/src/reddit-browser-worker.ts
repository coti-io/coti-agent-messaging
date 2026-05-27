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
  type RedditBrowserBridgeResponseSuccess,
  type RedditBrowserReadResult,
  type RedditCommentState,
  type RedditPublishableActionType,
  type RedditSearchResult,
  type RedditThreadState
} from "./reddit-controller.js";
import { resolveRedditBrowserStorageStatePath } from "./config.js";
import { parseRedditListing, type RedditSourceItem } from "./reddit-outreach.js";

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
    result?: RedditBrowserReadResult;
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
const OLD_REDDIT_BASE_URL = "https://old.reddit.com";
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
    headless: parseBoolean(process.env.OUTREACH_REDDIT_BROWSER_HEADLESS, false),
    baseUrl: process.env.OUTREACH_REDDIT_BROWSER_BASE_URL ?? DEFAULT_BROWSER_BASE_URL,
    executablePath: getOptionalEnv("OUTREACH_REDDIT_BROWSER_EXECUTABLE_PATH"),
    channel: getOptionalEnv("OUTREACH_REDDIT_BROWSER_CHANNEL"),
    slowMoMs: Number.isFinite(Number(process.env.OUTREACH_REDDIT_BROWSER_SLOWMO_MS))
      ? Number(process.env.OUTREACH_REDDIT_BROWSER_SLOWMO_MS)
      : undefined,
    storageStatePath: resolveRedditBrowserStorageStatePath(
      getOptionalEnv("OUTREACH_REDDIT_BROWSER_STORAGE_STATE_PATH")
    ),
    startupUrl: process.env.OUTREACH_REDDIT_BROWSER_STARTUP_URL ?? DEFAULT_BROWSER_BASE_URL
  };
}

function workerLockPath(bridgeDir: string): string {
  return path.join(bridgeDir, "worker.lock");
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireWorkerLock(lockPath: string): Promise<void> {
  try {
    const existing = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };
    if (existing.pid && isProcessAlive(existing.pid) && existing.pid !== process.pid) {
      throw new Error(
        `Reddit browser worker already running (pid ${existing.pid}). Stop it with: npm run reddit:browser-worker:stop`
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("already running")) {
      throw error;
    }
  }

  await writeJsonAtomic(lockPath, {
    pid: process.pid,
    startedAt: new Date().toISOString()
  });
}

async function releaseWorkerLock(lockPath: string): Promise<void> {
  try {
    const existing = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };
    if (existing.pid === process.pid) {
      await unlink(lockPath);
    }
  } catch {
    // Ignore missing or unreadable lock files.
  }
}

export async function stopRedditBrowserWorkers(
  configInput: Partial<RedditBrowserWorkerConfig> = {}
): Promise<{ stoppedPids: number[]; killedPlaywrightChrome: boolean }> {
  const config = { ...resolveRedditBrowserWorkerConfig(), ...configInput };
  const stoppedPids = new Set<number>();
  const lockPath = workerLockPath(config.bridgeDir);

  for (const pidSource of [lockPath, config.statusPath]) {
    try {
      const raw = JSON.parse(await readFile(pidSource, "utf8")) as { pid?: number };
      if (raw.pid && isProcessAlive(raw.pid)) {
        process.kill(raw.pid, "SIGTERM");
        stoppedPids.add(raw.pid);
      }
    } catch {
      // Ignore missing status/lock files.
    }
  }

  try {
    const { execSync } = await import("node:child_process");
    const output = execSync('pgrep -f "index.js reddit-browser-worker" || true', {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    for (const line of output.split("\n")) {
      const pid = Number(line.trim());
      if (pid && pid !== process.pid && isProcessAlive(pid)) {
        process.kill(pid, "SIGTERM");
        stoppedPids.add(pid);
      }
    }
  } catch {
    // pgrep is best-effort.
  }

  await sleep(400);

  let killedPlaywrightChrome = false;
  try {
    const { execSync } = await import("node:child_process");
    execSync('pkill -f "Google Chrome for Testing" >/dev/null 2>&1 || true', {
      shell: "/bin/bash"
    });
    killedPlaywrightChrome = true;
  } catch {
    // pkill is best-effort.
  }

  await releaseWorkerLock(lockPath);
  await writeStatus(config.statusPath, {
    phase: "stopped",
    pid: process.pid,
    bridgeDir: config.bridgeDir
  }).catch(() => undefined);

  return {
    stoppedPids: [...stoppedPids],
    killedPlaywrightChrome
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
  const lockPath = workerLockPath(config.bridgeDir);

  await mkdir(config.requestsDir, { recursive: true });
  await acquireWorkerLock(lockPath);
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
          result: result.result,
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
      await releaseWorkerLock(lockPath);
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

function isBrokenPlaywrightBrowserError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /has been closed|Target page, context or browser has been closed|browser has been closed/i.test(
    message
  );
}

class PlaywrightRedditBrowserAutomation implements RedditBrowserAutomation {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;

  constructor(private readonly config: RedditBrowserWorkerConfig) {}

  async fulfill(request: RedditBrowserBridgeRequest): Promise<{
    remoteContentId?: string;
    remoteContentUrl?: string;
    result?: RedditBrowserReadResult;
    raw?: unknown;
  }> {
    try {
      const page = await this.getPage();
      switch (request.action.type) {
        case "search_subreddit":
          return {
            result: await this.searchSubreddit(page, request)
          };
        case "list_subreddit_posts":
          return {
            result: await this.listSubredditPosts(page, request)
          };
        case "read_thread":
          return {
            result: await this.readThread(page, request)
          };
        case "create_post":
          return this.submitCreatePost(page, request);
        case "comment_on_post":
          return this.submitComment(page, request, false);
        case "reply_to_comment":
          return this.submitComment(page, request, true);
        default:
          throw new RedditControllerConfigurationError(
            "Reddit browser worker cannot fulfill the requested action type."
          );
      }
    } catch (error) {
      if (isBrokenPlaywrightBrowserError(error)) {
        await this.close();
      }
      throw error;
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
    if (request.action.type !== "create_post") {
      throw new RedditControllerConfigurationError("Expected create_post action.");
    }
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
    if (!/\/comments\//i.test(page.url())) {
      throw new RedditBrowserSubmitError("Reddit browser worker did not reach the new post page after submit.");
    }
    await this.guardPage(page);
    await this.persistStorageState();
    return this.buildSubmitResult(page, request.action.type, request.action.content);
  }

  private async submitComment(page: Page, request: RedditBrowserBridgeRequest, isReply: boolean) {
    if (request.action.type !== "comment_on_post" && request.action.type !== "reply_to_comment") {
      throw new RedditControllerConfigurationError("Expected comment/reply action.");
    }
    const content = request.action.content ?? "";
    if (!content.trim()) {
      throw new RedditControllerConfigurationError("Reddit comment/reply requires action.content.");
    }

    try {
      return await this.submitCommentViaOldReddit(page, request, isReply, content);
    } catch (error) {
      if (
        error instanceof RedditLoginRequiredError ||
        error instanceof RedditAntiBotChallengeError ||
        error instanceof RedditControllerConfigurationError
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new RedditBrowserSubmitError(
        `Reddit browser worker could not publish the comment via old.reddit.com: ${message}`,
        error
      );
    }
  }

  private async submitCommentViaOldReddit(
    page: Page,
    request: RedditBrowserBridgeRequest,
    isReply: boolean,
    content: string
  ): Promise<{
    remoteContentId?: string;
    remoteContentUrl: string;
    raw: unknown;
  }> {
    const threadUrl = resolveOldRedditThreadUrl(request, isReply);
    await this.gotoAndGuard(page, threadUrl);
    await page.waitForLoadState("domcontentloaded");

    if (isReply) {
      await this.openOldRedditReplyForm(page, request);
    }

    const textarea = page.locator("form.usertext textarea[name='text']").first();
    if (!(await textarea.isVisible({ timeout: 10_000 }).catch(() => false))) {
      throw new RedditBrowserEditorError("old.reddit comment form was not available.");
    }
    await textarea.fill(content);
    await page.locator("form.usertext button[type='submit']").first().click();
    const permalink = await this.waitForOldRedditCommentPermalink(page, content);
    await this.guardPage(page);
    await this.persistStorageState();
    const remoteContentUrl = normalizeOldRedditPermalink(permalink, this.config.baseUrl);
    return {
      remoteContentId: extractRemoteContentId(remoteContentUrl, request.action.type as RedditPublishableActionType),
      remoteContentUrl,
      raw: {
        publishSurface: "old.reddit",
        pageUrl: page.url(),
        permalink
      }
    };
  }

  private async openOldRedditReplyForm(page: Page, request: RedditBrowserBridgeRequest): Promise<void> {
    if (request.action.type !== "reply_to_comment") {
      return;
    }
    const commentId = request.action.candidateId;
    const replyLink = page.locator(`form[id^="commentform"] a[data-event-action="comment"]`).filter({
      has: page.locator(`input[name="parent"][value="t1_${commentId}"], input[name="parent"][value="${commentId}"]`)
    });
    if (await replyLink.count()) {
      await replyLink.first().click();
      return;
    }
    const fallback = page.locator(`a[data-event-action="comment"][href*="${commentId}"]`).first();
    if (await fallback.isVisible().catch(() => false)) {
      await fallback.click();
      return;
    }
    throw new RedditBrowserEditorError(`old.reddit reply form for comment ${commentId} was not available.`);
  }

  private async waitForOldRedditCommentPermalink(page: Page, content: string): Promise<string> {
    const snippet = commentVerificationSnippet(content);
    const deadline = Date.now() + this.config.requestTimeoutMs;
    while (Date.now() < deadline) {
      const permalink = await page
        .evaluate((needle) => {
          const normalized = needle.toLowerCase();
          const bodies = Array.from(document.querySelectorAll(".comment .usertext-body"));
          for (const body of bodies) {
            const text = body.textContent?.trim().toLowerCase() ?? "";
            if (!text.includes(normalized)) {
              continue;
            }
            const comment = body.closest(".comment");
            const link = comment?.querySelector("a.bylink[href*='/comments/']") as HTMLAnchorElement | null;
            if (link?.href) {
              return link.href;
            }
          }
          return undefined;
        }, snippet)
        .catch(() => undefined);
      if (permalink) {
        return permalink;
      }
      await page.waitForTimeout(1_000);
    }
    throw new RedditBrowserSubmitError(
      "Reddit browser worker submitted the comment form, but the comment did not appear on the thread."
    );
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
      "shreddit-composer [contenteditable='true']",
      "comment-composer-host [contenteditable='true']",
      '[data-testid="comment-composer"] [contenteditable="true"]',
      '[aria-label*="comment" i][contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      "faceplate-textarea-input textarea",
      '[contenteditable="true"]',
      'textarea[placeholder*="comment" i]',
      'textarea[placeholder*="body" i]',
      "textarea"
    ];

    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        await locator.scrollIntoViewIfNeeded().catch(() => undefined);
        await this.fillLocator(locator, value);
        return;
      }
    }

    const roleTextbox = page.getByRole("textbox").first();
    if (await roleTextbox.isVisible().catch(() => false)) {
      await roleTextbox.scrollIntoViewIfNeeded().catch(() => undefined);
      await this.fillLocator(roleTextbox, value);
      return;
    }

    throw new RedditBrowserEditorError();
  }

  private async fillLocator(locator: Locator, value: string): Promise<void> {
    try {
      await locator.fill(value);
    } catch {
      await locator.click();
      await locator.press(`${process.platform === "darwin" ? "Meta" : "Control"}+A`).catch(() => undefined);
      await locator.press("Backspace").catch(() => undefined);
      await locator.type(value);
    }
    await locator
      .evaluate((element) => {
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      })
      .catch(() => undefined);
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
      const locator = page.locator(selector).last();
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
    actionType: RedditPublishableActionType,
    content: string | undefined
  ) {
    const currentUrl = page.url();
    const permalink = content ? await findPermalinkForContent(page, content) : undefined;
    if (!permalink) {
      throw new RedditBrowserSubmitError(
        "Reddit browser worker did not find the published post on the page after submit."
      );
    }
    const remoteContentUrl = normalizeUrl(permalink, this.config.baseUrl);
    return {
      remoteContentId: extractRemoteContentId(remoteContentUrl, actionType),
      remoteContentUrl,
      raw: {
        pageUrl: currentUrl,
        permalink
      }
    };
  }

  private async searchSubreddit(
    page: Page,
    request: RedditBrowserBridgeRequest
  ): Promise<RedditBrowserReadResult> {
    if (request.action.type !== "search_subreddit") {
      throw new RedditControllerConfigurationError("Expected search_subreddit action.");
    }
    const url = new URL(`/r/${encodeURIComponent(request.action.subreddit)}/search/`, this.config.baseUrl);
    url.searchParams.set("q", request.action.query);
    url.searchParams.set("restrict_sr", "1");
    url.searchParams.set("sort", request.action.sort ?? "new");
    url.searchParams.set("t", request.action.time ?? "month");
    await this.gotoAndGuard(page, url.toString());
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    const jsonUrl = new URL(`/r/${encodeURIComponent(request.action.subreddit)}/search.json`, this.config.baseUrl);
    jsonUrl.searchParams.set("q", request.action.query);
    jsonUrl.searchParams.set("restrict_sr", "1");
    jsonUrl.searchParams.set("sort", request.action.sort ?? "new");
    jsonUrl.searchParams.set("t", request.action.time ?? "month");
    jsonUrl.searchParams.set("limit", String(request.action.limit ?? 10));
    const jsonItems = normalizeSearchResultsFromSourceItems(
      parseRedditListing(await tryFetchJsonInPage(page, jsonUrl.toString()))
    );
    if (jsonItems.length > 0) {
      return {
        type: "search_subreddit",
        items: jsonItems.slice(0, request.action.limit ?? 10)
      };
    }
    return {
      type: "search_subreddit",
      items: (await extractSearchResults(page)).slice(0, request.action.limit ?? 10)
    };
  }

  private async listSubredditPosts(
    page: Page,
    request: RedditBrowserBridgeRequest
  ): Promise<RedditBrowserReadResult> {
    if (request.action.type !== "list_subreddit_posts") {
      throw new RedditControllerConfigurationError("Expected list_subreddit_posts action.");
    }
    const sort = request.action.sort ?? "new";
    const url = new URL(`/r/${encodeURIComponent(request.action.subreddit)}/${sort}/`, this.config.baseUrl);
    await this.gotoAndGuard(page, url.toString());
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    const jsonUrl = new URL(`/r/${encodeURIComponent(request.action.subreddit)}/${sort}.json`, this.config.baseUrl);
    jsonUrl.searchParams.set("limit", String(request.action.limit ?? 10));
    const jsonItems = normalizeSearchResultsFromSourceItems(
      parseRedditListing(await tryFetchJsonInPage(page, jsonUrl.toString()))
    );
    if (jsonItems.length > 0) {
      return {
        type: "list_subreddit_posts",
        items: jsonItems.slice(0, request.action.limit ?? 10)
      };
    }
    return {
      type: "list_subreddit_posts",
      items: (await extractSearchResults(page)).slice(0, request.action.limit ?? 10)
    };
  }

  private async readThread(
    page: Page,
    request: RedditBrowserBridgeRequest
  ): Promise<RedditBrowserReadResult> {
    if (request.action.type !== "read_thread") {
      throw new RedditControllerConfigurationError("Expected read_thread action.");
    }
    const targetUrl = request.action.url
      ? normalizeUrl(request.action.url, this.config.baseUrl)
      : request.action.subreddit && request.action.postId
        ? new URL(`/r/${request.action.subreddit}/comments/${request.action.postId}/`, this.config.baseUrl).toString()
        : request.action.postId
          ? new URL(`/comments/${request.action.postId}/`, this.config.baseUrl).toString()
          : undefined;
    if (!targetUrl) {
      throw new RedditControllerConfigurationError("read_thread requires url or postId.");
    }
    await this.gotoAndGuard(page, targetUrl);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    const jsonThread = normalizeThreadStateFromJson(
      await tryFetchJsonInPage(page, ensureJsonThreadUrl(targetUrl, request.action.limit ?? 35)),
      this.config.baseUrl
    );
    if (jsonThread) {
      return {
        type: "read_thread",
        thread: jsonThread
      };
    }
    return {
      type: "read_thread",
      thread: await extractThreadState(page, this.config.baseUrl, request.action.limit ?? 35)
    };
  }
}

function commentVerificationSnippet(content: string): string {
  const normalized = content.trim().replace(/\s+/g, " ");
  if (normalized.length <= 80) {
    return normalized;
  }
  return normalized.slice(0, 80);
}

function resolveOldRedditThreadUrl(request: RedditBrowserBridgeRequest, isReply: boolean): string {
  if (request.action.type !== "comment_on_post" && request.action.type !== "reply_to_comment") {
    throw new RedditControllerConfigurationError("Expected comment/reply action.");
  }
  if (isReply) {
    return resolveRequestUrl(OLD_REDDIT_BASE_URL, request, true);
  }
  const surface = request.action.surface;
  const postId = request.action.parentId;
  if (!postId) {
    throw new RedditControllerConfigurationError("Reddit comment_on_post requires action.parentId.");
  }
  if (surface) {
    return new URL(
      `/r/${encodeURIComponent(surface)}/comments/${encodeURIComponent(postId)}/`,
      OLD_REDDIT_BASE_URL
    ).toString();
  }
  return new URL(`/comments/${encodeURIComponent(postId)}/`, OLD_REDDIT_BASE_URL).toString();
}

function normalizeOldRedditPermalink(permalink: string, baseUrl: string): string {
  try {
    const url = new URL(permalink);
    if (url.hostname === "old.reddit.com") {
      url.hostname = new URL(baseUrl).hostname;
    }
    return url.toString();
  } catch {
    return normalizeUrl(permalink, baseUrl);
  }
}

function resolveRequestUrl(baseUrl: string, request: RedditBrowserBridgeRequest, isReply: boolean): string {
  if (request.action.type !== "comment_on_post" && request.action.type !== "reply_to_comment") {
    throw new RedditControllerConfigurationError("Expected comment/reply action.");
  }
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
    if (request.action.surface) {
      return new URL(
        `/r/${encodeURIComponent(request.action.surface)}/comments/${encodeURIComponent(request.action.parentId)}/`,
        baseUrl
      ).toString();
    }
    return new URL(`/comments/${request.action.parentId}/`, baseUrl).toString();
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
  actionType: RedditPublishableActionType
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

async function extractSearchResults(page: Page): Promise<RedditSearchResult[]> {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/comments/"]')) as HTMLAnchorElement[];
    const seen = new Set<string>();
    const results: RedditSearchResult[] = [];
    for (const anchor of anchors) {
      const href = anchor.href;
      const match = href.match(/\/r\/([^/]+)\/comments\/([^/]+)/i) ?? href.match(/\/comments\/([^/]+)/i);
      if (!match) {
        continue;
      }
      const subreddit = match.length > 2 ? decodeURIComponent(match[1]!) : "";
      const id = match.length > 2 ? match[2]! : match[1]!;
      const title = (anchor.textContent ?? "").trim();
      if (!id || !title || seen.has(id)) {
        continue;
      }
      seen.add(id);
      const container =
        anchor.closest("article") ??
        anchor.closest('[data-testid="post-container"]') ??
        anchor.closest("shreddit-post") ??
        anchor.parentElement;
      const text = container?.textContent?.replace(/\s+/g, " ").trim();
      results.push({
        id,
        subreddit,
        title,
        body: text && text !== title ? text.slice(0, 1200) : undefined,
        permalink: new URL(href).pathname,
        url: href
      });
    }
    return results;
  });
}

async function extractThreadState(page: Page, baseUrl: string, limit: number): Promise<RedditThreadState> {
  const url = page.url();
  const fallback = parseThreadUrl(url);
  const extracted = await page.evaluate((commentLimit) => {
    const postContainer =
      document.querySelector("shreddit-post") ??
      document.querySelector("article") ??
      document.body;
    const title =
      document.querySelector("h1")?.textContent?.trim() ??
      postContainer?.querySelector('[slot="title"]')?.textContent?.trim() ??
      document.title.replace(/\s*:\s*reddit\s*$/i, "").trim();
    const body =
      postContainer?.querySelector('[slot="text-body"]')?.textContent?.trim() ??
      postContainer?.textContent?.trim();
    const comments = Array.from(
      document.querySelectorAll("shreddit-comment, [data-testid='comment'], article")
    )
      .slice(0, commentLimit)
      .map((node, index) => {
        const element = node as HTMLElement;
        const link = element.querySelector('a[href*="/comments/"]') as HTMLAnchorElement | null;
        const text = element.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const author =
          element.getAttribute("author") ??
          element.querySelector('[data-testid="comment_author_link"], a[href^="/user/"], a[href*="/user/"]')?.textContent?.trim() ??
          undefined;
        const parentId =
          element.getAttribute("parentid") ??
          element.getAttribute("parent-id") ??
          element.getAttribute("parent_id") ??
          undefined;
        return {
          id: element.id || element.getAttribute("thingid") || link?.href?.split("/").filter(Boolean).at(-1) || `comment-${index}`,
          body: text.slice(0, 2000),
          author,
          permalink: link ? new URL(link.href).pathname : undefined,
          parentId,
          depth: Number(element.getAttribute("depth") ?? "0") || 0
        };
      })
      .filter((comment) => comment.body.length > 0);
    const alreadyParticipated = /you|your comment|profile-card/i.test(postContainer?.textContent ?? "");
    return {
      title,
      body,
      comments,
      alreadyParticipated
    };
  }, limit);

  return {
    id: fallback.id,
    subreddit: fallback.subreddit,
    title: extracted.title || "Reddit thread",
    body: extracted.body,
    permalink: new URL(url).pathname,
    url: normalizeUrl(url, baseUrl),
    commentCount: extracted.comments.length,
    alreadyParticipated: extracted.alreadyParticipated,
    comments: extracted.comments.map((comment): RedditCommentState => ({
      id: comment.id,
      body: comment.body,
      author: comment.author,
      permalink: comment.permalink,
      parentId: comment.parentId,
      depth: comment.depth,
      replies: []
    }))
  };
}

function parseThreadUrl(url: string): { subreddit: string; id: string } {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  const subredditIndex = parts.findIndex((part) => part.toLowerCase() === "r");
  const commentsIndex = parts.findIndex((part) => part.toLowerCase() === "comments");
  return {
    subreddit: subredditIndex >= 0 ? parts[subredditIndex + 1] ?? "" : "",
    id: commentsIndex >= 0 ? parts[commentsIndex + 1] ?? parsed.pathname : parsed.pathname
  };
}

function normalizeUrl(value: string, baseUrl: string): string {
  return new URL(value, baseUrl).toString();
}

function ensureJsonThreadUrl(value: string, limit: number): string {
  const url = new URL(value);
  const pathname = url.pathname.endsWith(".json") ? url.pathname : `${url.pathname.replace(/\/$/, "")}.json`;
  url.pathname = pathname;
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("raw_json", "1");
  return url.toString();
}

async function fetchJsonInPage(page: Page, url: string): Promise<unknown> {
  const result = await page.evaluate(async (targetUrl) => {
    const response = await fetch(targetUrl, {
      credentials: "include",
      headers: {
        Accept: "application/json"
      }
    });
    if (!response.ok) {
      throw new Error(`Fetch failed with ${response.status} for ${targetUrl}`);
    }
    return response.json();
  }, url);
  return result;
}

async function tryFetchJsonInPage(page: Page, url: string): Promise<unknown | undefined> {
  try {
    return await fetchJsonInPage(page, url);
  } catch {
    return undefined;
  }
}

function normalizeSearchResultsFromSourceItems(items: readonly RedditSourceItem[]): RedditSearchResult[] {
  return items
    .filter((item) => item.kind === "post")
    .map((item) => ({
      id: item.id,
      subreddit: item.subreddit,
      title: item.title,
      body: item.body,
      author: item.author,
      permalink: item.permalink,
      url: item.url,
      score: item.score,
      commentCount: item.commentCount,
      createdUtc: item.createdUtc
    }));
}

function normalizeThreadStateFromJson(input: unknown, baseUrl: string): RedditThreadState | undefined {
  if (!Array.isArray(input) || input.length === 0) {
    return undefined;
  }
  const postItems = parseRedditListing(input[0]);
  const post = postItems.find((item) => item.kind === "post");
  if (!post) {
    return undefined;
  }
  const comments = Array.isArray(input[1]) ? normalizeCommentListing(input[1]) : [];
  return {
    id: post.id,
    subreddit: post.subreddit,
    title: post.title,
    body: post.body,
    author: post.author,
    permalink: post.permalink,
    url: post.url ? normalizeUrl(post.url, baseUrl) : post.permalink ? normalizeUrl(post.permalink, baseUrl) : undefined,
    score: post.score,
    commentCount: post.commentCount,
    createdUtc: post.createdUtc,
    comments
  };
}

function normalizeCommentListing(input: unknown): RedditCommentState[] {
  if (!isRecord(input) || !isRecord(input.data) || !Array.isArray(input.data.children)) {
    return [];
  }
  return input.data.children.flatMap((child) => normalizeCommentNode(child, 0));
}

function normalizeCommentNode(input: unknown, depth: number): RedditCommentState[] {
  if (!isRecord(input) || input.kind !== "t1" || !isRecord(input.data)) {
    return [];
  }
  const data = input.data;
  const replies =
    isRecord(data.replies) && isRecord(data.replies.data) && Array.isArray(data.replies.data.children)
      ? data.replies.data.children.flatMap((child) => normalizeCommentNode(child, depth + 1))
      : [];
  return [
    {
      id: stringValue(data.id) ?? stringValue(data.name) ?? `comment-depth-${depth}`,
      body: stringValue(data.body) ?? "",
      author: stringValue(data.author),
      permalink: stringValue(data.permalink),
      score: numberValue(data.score),
      createdUtc: numberValue(data.created_utc),
      parentId: stringValue(data.parent_id),
      depth,
      replies
    }
  ].filter((comment) => comment.body.length > 0);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function stringValue(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined;
}

function numberValue(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

export async function runRedditBrowserWorkerStopCli(): Promise<void> {
  const result = await stopRedditBrowserWorkers();
  console.log(
    JSON.stringify(
      {
        ok: true,
        stoppedPids: result.stoppedPids,
        killedPlaywrightChrome: result.killedPlaywrightChrome
      },
      null,
      2
    )
  );
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

  if (handle.config.headless) {
    console.warn(
      "OUTREACH_REDDIT_BROWSER_HEADLESS=true: Reddit often returns empty listings in headless mode. Use a visible browser for discovery unless you know your environment works headless."
    );
  }

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
