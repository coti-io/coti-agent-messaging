import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export interface RepoContextBundle {
  baseSummary: string;
  relevantSnippets: Array<{
    path: string;
    excerpt: string;
  }>;
}

interface RepoChunk {
  path: string;
  excerpt: string;
  searchText: string;
}

interface RepoCorpus {
  baseSummary: string;
  chunks: RepoChunk[];
}

interface RepoEntry {
  path: string;
  content: string;
}

const CORPUS_CACHE = new Map<string, Promise<RepoCorpus>>();
const REMOTE_DOCS_CACHE = new Map<string, Promise<RepoEntry[]>>();
const require = createRequire(import.meta.url);
const INCLUDED_EXTENSIONS = new Set([".ts", ".js", ".sol", ".md"]);
const IGNORED_DIRS = new Set(["node_modules", "dist", "artifacts", "cache", ".git"]);
const MAX_SUMMARY_LINES = 4;
const MAX_CHUNK_LENGTH = 900;
const CHUNK_OVERLAP = 180;
const REMOTE_DOC_FETCH_TIMEOUT_MS = 2_500;
const PRIVATE_MESSAGING_DOCS: ReadonlyArray<{ path: string; url: string }> = [
  {
    path: "coti-docs/private-messaging/README.md",
    url: "https://raw.githubusercontent.com/coti-io/documentation/main/private-messaging/README.md"
  },
  {
    path: "coti-docs/private-messaging/typescript-sdk.md",
    url: "https://raw.githubusercontent.com/coti-io/documentation/main/private-messaging/typescript-sdk.md"
  },
  {
    path: "coti-docs/private-messaging/messages.md",
    url: "https://raw.githubusercontent.com/coti-io/documentation/main/private-messaging/messages.md"
  },
  {
    path: "coti-docs/private-messaging/rewards.md",
    url: "https://raw.githubusercontent.com/coti-io/documentation/main/private-messaging/rewards.md"
  },
  {
    path: "coti-docs/private-messaging/starter-grant.md",
    url: "https://raw.githubusercontent.com/coti-io/documentation/main/private-messaging/starter-grant.md"
  }
];

export async function buildRepoContext(
  projectRoot: string,
  queryText: string,
  maxSnippets = 6
): Promise<RepoContextBundle> {
  const corpus = await loadRepoCorpus(projectRoot);
  const queryTerms = extractSearchTerms(queryText);
  const relevantSnippets = corpus.chunks
    .map((chunk) => ({
      chunk,
      score: scoreChunk(chunk, queryTerms)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxSnippets)
    .map((entry) => ({
      path: entry.chunk.path,
      excerpt: entry.chunk.excerpt
    }));

  return {
    baseSummary: corpus.baseSummary,
    relevantSnippets
  };
}

async function loadRepoCorpus(projectRoot: string): Promise<RepoCorpus> {
  if (!CORPUS_CACHE.has(projectRoot)) {
    CORPUS_CACHE.set(projectRoot, buildRepoCorpus(projectRoot));
  }

  return CORPUS_CACHE.get(projectRoot)!;
}

async function buildRepoCorpus(projectRoot: string): Promise<RepoCorpus> {
  const [projectEntries, dependencyEntries, remoteDocEntries] = await Promise.all([
    loadProjectEntries(projectRoot),
    loadDependencyEntries(),
    loadRemoteDocEntries()
  ]);
  const entries = [...projectEntries, ...dependencyEntries, ...remoteDocEntries];

  const baseSummary = entries
    .map((entry) => `${entry.path}: ${summarizeFile(entry.content)}`)
    .join("\n");
  const chunks = entries.flatMap((entry) => chunkFile(entry.path, entry.content));

  return {
    baseSummary,
    chunks
  };
}

async function loadProjectEntries(projectRoot: string): Promise<RepoEntry[]> {
  const directories = [path.join(projectRoot, "contracts"), path.join(projectRoot, "docs")];
  const filePaths = (await Promise.all(directories.map((directory) => collectFiles(directory)))).flat();
  return readRepoEntries(filePaths, projectRoot);
}

async function loadDependencyEntries(): Promise<RepoEntry[]> {
  const sdkRoot = resolvePrivateMessagingSdkRoot();
  if (!sdkRoot) {
    return [];
  }

  const filePaths = await collectFiles(sdkRoot);
  return readRepoEntries(filePaths, sdkRoot, "sdk-package");
}

async function loadRemoteDocEntries(): Promise<RepoEntry[]> {
  const cacheKey = PRIVATE_MESSAGING_DOCS.map((entry) => entry.path).join("|");
  if (!REMOTE_DOCS_CACHE.has(cacheKey)) {
    REMOTE_DOCS_CACHE.set(cacheKey, fetchRemoteDocEntries(PRIVATE_MESSAGING_DOCS));
  }

  return REMOTE_DOCS_CACHE.get(cacheKey)!;
}

async function fetchRemoteDocEntries(
  documents: ReadonlyArray<{ path: string; url: string }>
): Promise<RepoEntry[]> {
  return (
    await Promise.all(
      documents.map(async (document) => {
        const content = await fetchText(document.url);
        if (!content) {
          return undefined;
        }

        return {
          path: document.path,
          content
        };
      })
    )
  ).filter((entry): entry is RepoEntry => Boolean(entry));
}

function resolvePrivateMessagingSdkRoot(): string | undefined {
  try {
    const packageJsonPath = require.resolve("@coti-io/coti-sdk-private-messaging/package.json");
    return path.dirname(packageJsonPath);
  } catch {
    return undefined;
  }
}

async function readRepoEntries(
  filePaths: readonly string[],
  rootPath: string,
  pathPrefix?: string
): Promise<RepoEntry[]> {
  return Promise.all(
    filePaths.map(async (filePath) => {
      const relativePath = path.relative(rootPath, filePath);
      return {
        path: pathPrefix ? path.posix.join(pathPrefix, normalizePath(relativePath)) : normalizePath(relativePath),
        content: await readFile(filePath, "utf8")
      };
    })
  );
}

async function collectFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          return [];
        }

        return collectFiles(fullPath);
      }

      if (!INCLUDED_EXTENSIONS.has(path.extname(entry.name))) {
        return [];
      }

      return [fullPath];
    })
  );

  return files.flat();
}

async function fetchText(url: string): Promise<string | undefined> {
  if (typeof fetch !== "function") {
    return undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_DOC_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal
    });
    if (!response.ok) {
      return undefined;
    }

    return await response.text();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeFile(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("import "))
    .slice(0, MAX_SUMMARY_LINES)
    .join(" ")
    .slice(0, 320);
}

function chunkFile(relativePath: string, content: string): RepoChunk[] {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) {
    return [];
  }

  const chunks: RepoChunk[] = [];
  for (let start = 0; start < compact.length; start += MAX_CHUNK_LENGTH - CHUNK_OVERLAP) {
    const excerpt = compact.slice(start, start + MAX_CHUNK_LENGTH).trim();
    if (!excerpt) {
      continue;
    }

    chunks.push({
      path: relativePath,
      excerpt,
      searchText: `${relativePath} ${excerpt}`.toLowerCase()
    });
  }

  return chunks;
}

function extractSearchTerms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).slice(0, 40))];
}

function scoreChunk(chunk: RepoChunk, queryTerms: readonly string[]): number {
  return queryTerms.reduce((score, term) => {
    return chunk.searchText.includes(term) ? score + Math.min(term.length, 8) : score;
  }, 0);
}

function normalizePath(relativePath: string): string {
  return relativePath.split(path.sep).join(path.posix.sep);
}
