import { readdir, readFile } from "node:fs/promises";
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

const CORPUS_CACHE = new Map<string, Promise<RepoCorpus>>();
const INCLUDED_EXTENSIONS = new Set([".ts", ".sol", ".md"]);
const IGNORED_DIRS = new Set(["node_modules", "dist", "artifacts", "cache", ".git"]);
const MAX_SUMMARY_LINES = 4;
const MAX_CHUNK_LENGTH = 900;
const CHUNK_OVERLAP = 180;

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
  const directories = [path.join(projectRoot, "sdk"), path.join(projectRoot, "contracts")];
  const filePaths = (
    await Promise.all(directories.map((directory) => collectFiles(directory)))
  ).flat();

  const entries = await Promise.all(
    filePaths.map(async (filePath) => {
      const content = await readFile(filePath, "utf8");
      return {
        path: path.relative(projectRoot, filePath),
        content
      };
    })
  );

  const baseSummary = entries
    .map((entry) => `${entry.path}: ${summarizeFile(entry.content)}`)
    .join("\n");
  const chunks = entries.flatMap((entry) => chunkFile(entry.path, entry.content));

  return {
    baseSummary,
    chunks
  };
}

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
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
