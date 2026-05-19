#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { chromium } from "playwright";

import { RedditAntiBotChallengeError, RedditLoginRequiredError } from "./reddit-controller.js";
import { resolveRedditBrowserWorkerConfig } from "./reddit-browser-worker.js";

interface RedditBrowserLoginCliOptions {
  storageStatePath?: string;
  headless?: boolean;
  startupUrl?: string;
}

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

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export async function runRedditBrowserLoginCli(
  options: RedditBrowserLoginCliOptions = {}
): Promise<void> {
  const workerConfig = resolveRedditBrowserWorkerConfig();
  const storageStatePath = options.storageStatePath ?? getArg("--storage-state") ?? workerConfig.storageStatePath;
  if (!storageStatePath) {
    throw new Error(
      "Missing storage state path. Set OUTREACH_REDDIT_BROWSER_STORAGE_STATE_PATH or pass --storage-state FILE."
    );
  }

  const headless =
    options.headless ??
    (hasFlag("--headless") || parseBoolean(process.env.OUTREACH_REDDIT_BROWSER_LOGIN_HEADLESS, false));
  const startupUrl = options.startupUrl ?? getArg("--startup-url") ?? `${workerConfig.baseUrl.replace(/\/$/, "")}/login/`;

  await mkdir(path.dirname(storageStatePath), { recursive: true });

  const browser = await chromium.launch({
    headless,
    executablePath: workerConfig.executablePath,
    channel: workerConfig.channel,
    slowMo: workerConfig.slowMoMs
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(workerConfig.requestTimeoutMs);

  const rl = createInterface({ input, output });
  try {
    await page.goto(startupUrl, { waitUntil: "domcontentloaded" });
    output.write(
      [
        "",
        "Reddit browser login bootstrap",
        `Storage state target: ${storageStatePath}`,
        headless
          ? "Headless mode is on. This is usually a bad way to do first-time login."
          : "A visible Playwright browser is open. Complete Reddit login there.",
        "After login succeeds, return here and press Enter.",
        "Type 'q' and press Enter to abort.",
        ""
      ].join("\n")
    );

    while (true) {
      const answer = (await rl.question("> ")).trim().toLowerCase();
      if (answer === "q" || answer === "quit" || answer === "exit") {
        throw new Error("Reddit login bootstrap aborted.");
      }

      const username = await detectAuthenticatedUsername(page, workerConfig.baseUrl);
      if (!username) {
        output.write(
          "No authenticated Reddit session detected yet. Finish login in the browser and press Enter again.\n"
        );
        continue;
      }

      await context.storageState({ path: storageStatePath });
      output.write(`Saved Reddit browser session for u/${username} to ${storageStatePath}\n`);
      break;
    }
  } finally {
    rl.close();
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

async function detectAuthenticatedUsername(page: import("playwright").Page, baseUrl: string): Promise<string | undefined> {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const url = page.url();
  if (/\/login\b|\/register\b/i.test(url)) {
    throw new RedditLoginRequiredError();
  }
  if (/captcha|challenge|verify/i.test(url)) {
    throw new RedditAntiBotChallengeError();
  }

  const result = await page
    .evaluate(async () => {
      const extractUsername = (value: unknown): string | undefined => {
        if (!value || typeof value !== "object") {
          return undefined;
        }
        const record = value as Record<string, unknown>;
        const directName = typeof record.name === "string" && record.name.length > 0 ? record.name : undefined;
        if (directName) {
          return directName;
        }
        const data = record.data;
        if (data && typeof data === "object") {
          const nestedName = (data as Record<string, unknown>).name;
          if (typeof nestedName === "string" && nestedName.length > 0) {
            return nestedName;
          }
        }
        return undefined;
      };

      const response = await fetch("/api/me.json", {
        credentials: "include"
      });
      if (!response.ok) {
        const profileAnchor = document.querySelector('a[href^="/user/"], a[href^="/u/"]');
        const href = profileAnchor?.getAttribute("href");
        if (!href) {
          return undefined;
        }
        const match = href.match(/^\/(?:u|user)\/([^/?#]+)/i);
        return match?.[1];
      }
      const payload = (await response.json()) as unknown;
      return extractUsername(payload);
    })
    .catch(() => undefined);

  return result;
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  runRedditBrowserLoginCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
