import { createHttpJsonLlmProvider, type JsonLlmProvider } from "./llm-client.js";

export interface MoltbookRateLimit {
  limit?: number;
  remaining?: number;
  resetAt?: number;
  retryAfterSeconds?: number;
}

export interface MoltbookVerification {
  verification_code: string;
  challenge_text: string;
  expires_at?: string;
  instructions?: string;
}

export interface MoltbookPost {
  id: string;
  post_id?: string;
  title: string;
  content?: string;
  content_preview?: string;
  url?: string;
  submolt_name?: string;
  author_name?: string;
  created_at?: string;
  upvotes?: number;
  comment_count?: number;
  verification_status?: string;
  verification?: MoltbookVerification;
}

export interface MoltbookComment {
  id: string;
  post_id?: string;
  parent_id?: string | null;
  author_name?: string;
  author?: {
    name?: string;
  };
  content: string;
  created_at?: string;
  replies?: MoltbookComment[];
  upvotes?: number;
  verification_status?: string;
  verification?: MoltbookVerification;
}

export interface MoltbookActivityItem {
  post_id: string;
  post_title: string;
  submolt_name?: string;
  new_notification_count: number;
  latest_at?: string;
  latest_commenters?: string[];
  preview?: string;
  suggested_actions?: string[];
}

export interface MoltbookHomeResponse {
  your_account: {
    name: string;
    karma?: number;
    unread_notification_count?: number;
  };
  activity_on_your_posts: MoltbookActivityItem[];
  your_direct_messages?: {
    pending_request_count?: number;
    unread_message_count?: number;
  };
  latest_moltbook_announcement?: {
    post_id?: string;
    title?: string;
    preview?: string;
  };
  posts_from_accounts_you_follow?: {
    posts?: MoltbookPost[];
    total_following?: number;
    see_more?: string;
    hint?: string;
  };
  explore?: {
    description?: string;
    endpoint?: string;
  };
  what_to_do_next?: string[];
  quick_links?: Record<string, string>;
}

export interface MoltbookFeedResponse {
  success?: boolean;
  posts?: MoltbookPost[];
  has_more?: boolean;
  next_cursor?: string;
}

export interface MoltbookCommentsResponse {
  success?: boolean;
  comments?: MoltbookComment[];
  has_more?: boolean;
  next_cursor?: string;
}

export interface MoltbookRegistrationResponse {
  success?: boolean;
  agent: {
    api_key: string;
    claim_url?: string;
    verification_code?: string;
  };
  important?: string;
}

export interface MoltbookAgentProfile {
  name?: string;
  description?: string;
  karma?: number;
  follower_count?: number;
  following_count?: number;
  posts_count?: number;
  comments_count?: number;
  is_claimed?: boolean;
  is_active?: boolean;
  created_at?: string;
  last_active?: string;
}

export interface MoltbookAgentProfileResponse {
  success?: boolean;
  agent?: MoltbookAgentProfile;
  recentPosts?: MoltbookPost[];
  recentComments?: MoltbookComment[];
}

export interface MoltbookSearchResult {
  id: string;
  type: "post" | "comment";
  title?: string | null;
  content?: string;
  post_id?: string;
  post?: {
    id?: string;
    title?: string;
  };
}

export interface MoltbookSearchResponse {
  success?: boolean;
  query?: string;
  type?: "posts" | "comments" | "all";
  results?: MoltbookSearchResult[];
  count?: number;
  has_more?: boolean;
  next_cursor?: string;
}

export interface MoltbookVerifyResponse {
  success?: boolean;
  message?: string;
  content_type?: string;
  content_id?: string;
}

export interface MoltbookAuthStatusResponse {
  status?: string;
  success?: boolean;
}

export interface MoltbookRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  authenticated?: boolean;
}

export interface MoltbookApiClientOptions {
  baseUrl: string;
  apiKey?: string;
  autoVerify?: boolean;
  verificationLlm?: {
    apiKey: string;
    baseUrl: string;
    model: string;
    timeoutMs?: number;
  };
  verificationLlmProvider?: JsonLlmProvider;
  fetchImpl?: typeof fetch;
  llmFetchImpl?: typeof fetch;
}

interface NumberMatch {
  value: number;
  consumed: number;
}

interface VerificationLlmResult {
  answer: string;
  provider: string;
}

interface VerificationSolveResult extends VerificationLlmResult {
  confidence: "high" | "low";
}

type VerificationCarrier =
  | { type: "post"; value: MoltbookPost }
  | { type: "comment"; value: MoltbookComment };

function parseRateLimit(headers: Headers): MoltbookRateLimit {
  const asNumber = (value: string | null) => {
    if (!value) {
      return undefined;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  return {
    limit: asNumber(headers.get("x-ratelimit-limit")),
    remaining: asNumber(headers.get("x-ratelimit-remaining")),
    resetAt: asNumber(headers.get("x-ratelimit-reset")),
    retryAfterSeconds: asNumber(headers.get("retry-after"))
  };
}

function buildUrl(
  baseUrl: string,
  requestPath: string,
  query?: Record<string, string | number | boolean | undefined>
): URL {
  const url = new URL(requestPath.replace(/^\//, ""), `${baseUrl.replace(/\/+$/, "")}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) {
        continue;
      }

      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

function assertSecureAuthTarget(url: URL, apiKey: string | undefined): void {
  if (!apiKey) {
    return;
  }

  if (url.hostname !== "www.moltbook.com") {
    throw new Error(
      `Refusing to send Moltbook credentials to ${url.hostname}. Only www.moltbook.com is allowed.`
    );
  }
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function normalizeChallengeText(challengeText: string): string {
  return challengeText
    .replace(/[^a-z0-9.\s]+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function denoiseChallengeText(challengeText: string): string {
  return normalizeChallengeText(challengeText)
    .split(" ")
    .map((token) => token.replace(/([a-z])\1+/g, "$1"))
    .join(" ");
}

function levenshteinDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let row = 0; row < rows; row += 1) {
    matrix[row]![0] = row;
  }

  for (let col = 0; col < cols; col += 1) {
    matrix[0]![col] = col;
  }

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      matrix[row]![col] = Math.min(
        matrix[row - 1]![col]! + 1,
        matrix[row]![col - 1]! + 1,
        matrix[row - 1]![col - 1]! + cost
      );
    }
  }

  return matrix[rows - 1]![cols - 1]!;
}

const NUMBER_WORDS = new Map<string, number>([
  ["zero", 0],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
  ["thirteen", 13],
  ["fourteen", 14],
  ["fifteen", 15],
  ["sixteen", 16],
  ["seventeen", 17],
  ["eighteen", 18],
  ["nineteen", 19],
  ["twenty", 20],
  ["thirty", 30],
  ["forty", 40],
  ["fifty", 50],
  ["sixty", 60],
  ["seventy", 70],
  ["eighty", 80],
  ["ninety", 90],
  ["hundred", 100]
]);

const NON_NUMBER_TOKENS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "her",
  "his",
  "in",
  "is",
  "it",
  "new",
  "of",
  "on",
  "per",
  "the",
  "their",
  "what",
  "whats",
  "with"
]);

function fuzzyNumberValue(token: string): number | undefined {
  if (/^-?\d+(?:\.\d+)?$/.test(token)) {
    return Number(token);
  }

  const exactValue = NUMBER_WORDS.get(token);
  if (exactValue !== undefined) {
    return exactValue;
  }

  // Short non-number words like "for" from "force" create garbage matches ("four").
  if (token.length < 4) {
    return undefined;
  }

  let bestMatch: { value: number; distance: number } | undefined;
  for (const [word, value] of NUMBER_WORDS.entries()) {
    if (token.length <= 5 && token[0] !== word[0]) {
      continue;
    }

    const distance = levenshteinDistance(token, word);
    const threshold = word.length >= 6 ? 2 : 1;
    if (distance > threshold) {
      continue;
    }

    if (!bestMatch || distance < bestMatch.distance) {
      bestMatch = { value, distance };
    }
  }

  return bestMatch?.value;
}

function extractNumbers(text: string): number[] {
  const tokens = tokenizeChallenge(text);
  const values: number[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const currentMatch = parseNumberToken(tokens, index);
    if (!currentMatch) {
      continue;
    }

    const nextIndex = index + currentMatch.consumed;
    const next = parseNumberToken(tokens, nextIndex);
    if (
      currentMatch.value >= 20 &&
      currentMatch.value % 10 === 0 &&
      next &&
      next.value >= 1 &&
      next.value <= 9
    ) {
      values.push(currentMatch.value + next.value);
      index = nextIndex + next.consumed - 1;
      continue;
    }

    values.push(currentMatch.value);
    index += currentMatch.consumed - 1;
  }

  return values;
}

function tokenizeChallenge(text: string): string[] {
  return text.split(" ").filter(Boolean);
}

function parseNumberToken(tokens: readonly string[], startIndex: number): NumberMatch | undefined {
  const directToken = tokens[startIndex];
  if (!directToken) {
    return undefined;
  }

  for (let width = 3; width >= 2; width -= 1) {
    const slice = tokens.slice(startIndex, startIndex + width);
    if (slice.length !== width) {
      continue;
    }
    if (slice.some((token) => NON_NUMBER_TOKENS.has(token))) {
      continue;
    }

    const mergedValue = fuzzyNumberValue(slice.join(""));
    if (mergedValue !== undefined) {
      return { value: mergedValue, consumed: width };
    }
  }

  const directValue = fuzzyNumberValue(directToken);
  if (directValue !== undefined) {
    return { value: directValue, consumed: 1 };
  }

  return undefined;
}

function detectOperation(text: string): ((left: number, right: number) => number) | undefined {
  const hasPattern = (patterns: readonly RegExp[]) => patterns.some((pattern) => pattern.test(text));

  if (
    hasPattern([
      /\bminus\b/,
      /\bless\b/,
      /\blost\b/,
      /\blose\w*\b/,
      /\bsubtract\w*\b/,
      /\bdecreas\w*(?:\s+\w+){0,2}\s+by\b/,
      /\bdrop\w*(?:\s+\w+){0,2}\s+by\b/,
      /\bslow\w*(?:\s+\w+){0,2}\s+by\b/
    ])
  ) {
    return (left, right) => left - right;
  }

  if (
    hasPattern([
      /\bplus\b/,
      /\badd\w*\b/,
      /\bgain\w*\b/,
      /\bincreas\w*(?:\s+\w+){0,2}\s+by\b/,
      /\bmore\b/,
      /\btotal\b/,
      /\bsum\b/,
      /\bcombined\b/,
      /\btogether\b/,
      /\baltogether\b/
    ])
  ) {
    return (left, right) => left + right;
  }

  if (
    hasPattern([
      /\btimes\b/,
      /\bmultipl\w*(?:\s+\w+){0,2}\s+by\b/,
      /\bdouble\w*\b/,
      /\btriple\w*\b/
    ])
  ) {
    return (left, right) => left * right;
  }

  // Bare "per" appears constantly in units like "meters per second", so it is too noisy
  // to treat as division on its own.
  if (
    hasPattern([/\bdivid\w*(?:\s+\w+){0,2}\s+by\b/, /\bsplit among\b/, /\bshared among\b/])
  ) {
    return (left, right) => left / right;
  }

  return undefined;
}

export function solveVerificationChallenge(challengeText: string): string {
  const variants = [...new Set([normalizeChallengeText(challengeText), denoiseChallengeText(challengeText)])];

  for (const variant of variants) {
    const numbers = extractNumbers(variant);
    const operation = detectOperation(variant);
    if (numbers.length < 2 || !operation) {
      continue;
    }

    const [left, right] = selectOperands(numbers);
    const result = operation(left, right);
    if (!Number.isFinite(result)) {
      continue;
    }

    return result.toFixed(2);
  }

  throw new Error(`Unable to solve verification challenge: ${challengeText}`);
}

function shouldPreferLlmVerification(challengeText: string): boolean {
  const normalized = normalizeChallengeText(challengeText);
  return /([a-z])\1{2,}/.test(normalized);
}

function selectOperands(numbers: readonly number[]): [number, number] {
  if (numbers.length <= 2) {
    return [numbers[0]!, numbers[1]!];
  }

  const ranked = numbers
    .map((value, index) => ({ value, index, magnitude: Math.abs(value) }))
    .sort((left, right) => right.magnitude - left.magnitude || left.index - right.index)
    .slice(0, 2)
    .sort((left, right) => left.index - right.index);

  return [ranked[0]!.value, ranked[1]!.value];
}

async function solveVerificationChallengeWithLlm(
  challengeText: string,
  verificationLlmProvider: JsonLlmProvider
): Promise<VerificationLlmResult> {
  const payload = await verificationLlmProvider.createJsonCompletion<{ answer: string }>([
    {
      role: "system",
      content:
        "You solve distorted arithmetic verification challenges. The text often repeats letters or injects noise. Recover the intended two operands and operation, ignore incidental counts, do the arithmetic, and return strict JSON like {\"answer\":\"15.00\"}."
    },
    {
      role: "user",
      content: `Raw challenge: ${challengeText}\nNormalized challenge: ${normalizeChallengeText(challengeText)}\nDenoised challenge: ${denoiseChallengeText(challengeText)}`
    }
  ]);

  const answerText = payload.answer;
  const answer = parseVerificationAnswer(answerText);
  if (!answer) {
    throw new Error(`LLM fallback returned an unusable answer: ${answerText}`);
  }

  return {
    answer,
    provider: `llm:${verificationLlmProvider.label}`
  };
}

function parseVerificationAnswer(text: string): string | undefined {
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return undefined;
  }

  const value = Number(match[0]);
  if (!Number.isFinite(value)) {
    return undefined;
  }

  return value.toFixed(2);
}

export async function solveVerificationChallengeWithFallback(
  challengeText: string,
  options: {
    verificationLlmProvider?: JsonLlmProvider;
    verificationLlm?: MoltbookApiClientOptions["verificationLlm"];
    fetchImpl?: typeof fetch;
  } = {}
): Promise<VerificationSolveResult> {
  const verificationLlmProvider =
    options.verificationLlmProvider ??
    (options.verificationLlm
      ? createHttpJsonLlmProvider(
          {
            ...options.verificationLlm,
            timeoutMs: options.verificationLlm.timeoutMs ?? 10_000
          },
          options.fetchImpl ?? fetch
        )
      : undefined);

  if (verificationLlmProvider && shouldPreferLlmVerification(challengeText)) {
    const result = await solveVerificationChallengeWithLlm(
      challengeText,
      verificationLlmProvider
    );
    return {
      ...result,
      confidence: "low"
    };
  }

  try {
    return {
      answer: solveVerificationChallenge(challengeText),
      provider: "deterministic",
      confidence: "high"
    };
  } catch (error) {
    if (!verificationLlmProvider) {
      throw error;
    }

    const result = await solveVerificationChallengeWithLlm(
      challengeText,
      verificationLlmProvider
    );
    return {
      ...result,
      confidence: "low"
    };
  }
}

function isIncorrectVerificationAnswer(error: unknown): error is MoltbookApiError {
  if (!(error instanceof MoltbookApiError) || error.statusCode !== 400) {
    return false;
  }

  const payload = error.payload as Record<string, unknown> | undefined;
  const message = String(payload?.message ?? payload?.error ?? "");
  return /incorrect answer/i.test(message);
}

function getVerificationCarrier(payload: unknown): VerificationCarrier | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const post = record.post as MoltbookPost | undefined;
  if (post?.verification?.verification_code) {
    return { type: "post", value: post };
  }

  const comment = record.comment as MoltbookComment | undefined;
  if (comment?.verification?.verification_code) {
    return { type: "comment", value: comment };
  }

  return undefined;
}

export class MoltbookApiError extends Error {
  readonly statusCode: number;
  readonly payload: unknown;
  readonly rateLimit: MoltbookRateLimit;

  constructor(message: string, statusCode: number, payload: unknown, rateLimit: MoltbookRateLimit) {
    super(message);
    this.name = "MoltbookApiError";
    this.statusCode = statusCode;
    this.payload = payload;
    this.rateLimit = rateLimit;
  }
}

export class MoltbookApiClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly autoVerify: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly verificationLlmProvider?: JsonLlmProvider;

  constructor(options: MoltbookApiClientOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.autoVerify = options.autoVerify ?? true;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.verificationLlmProvider =
      options.verificationLlmProvider ??
      (options.verificationLlm
        ? createHttpJsonLlmProvider(
            {
              ...options.verificationLlm,
              timeoutMs: options.verificationLlm.timeoutMs ?? 10_000
            },
            options.llmFetchImpl ?? fetch
          )
        : undefined);
  }

  async registerAgent(input: {
    name: string;
    description: string;
  }): Promise<MoltbookRegistrationResponse> {
    return this.request<MoltbookRegistrationResponse>({
      method: "POST",
      path: "/agents/register",
      body: input,
      authenticated: false
    });
  }

  async getStatus(): Promise<MoltbookAuthStatusResponse> {
    return this.request<MoltbookAuthStatusResponse>({
      path: "/agents/status"
    });
  }

  async getMe(): Promise<{ success?: boolean; agent?: MoltbookAgentProfile }> {
    return this.request<{ success?: boolean; agent?: MoltbookAgentProfile }>({
      path: "/agents/me"
    });
  }

  async getAgentProfile(name: string): Promise<MoltbookAgentProfileResponse> {
    return this.request<MoltbookAgentProfileResponse>({
      path: "/agents/profile",
      query: { name }
    });
  }

  async search(query: {
    q: string;
    type?: "posts" | "comments" | "all";
    limit?: number;
    cursor?: string;
  }): Promise<MoltbookSearchResponse> {
    return this.request<MoltbookSearchResponse>({
      path: "/search",
      query
    });
  }

  async updateProfile(input: {
    description?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ success?: boolean; agent?: MoltbookAgentProfile }> {
    return this.request<{ success?: boolean; agent?: MoltbookAgentProfile }>({
      method: "PATCH",
      path: "/agents/me",
      body: input
    });
  }

  async getHome(): Promise<MoltbookHomeResponse> {
    return this.request<MoltbookHomeResponse>({
      path: "/home"
    });
  }

  async getFeed(query: {
    sort?: "hot" | "new" | "top" | "rising";
    limit?: number;
    filter?: "all" | "following";
    cursor?: string;
  } = {}): Promise<MoltbookFeedResponse> {
    return this.request<MoltbookFeedResponse>({
      path: "/feed",
      query
    });
  }

  async getPostComments(
    postId: string,
    query: {
      sort?: "best" | "new" | "old";
      limit?: number;
      cursor?: string;
    } = {}
  ): Promise<MoltbookCommentsResponse> {
    return this.request<MoltbookCommentsResponse>({
      path: `/posts/${postId}/comments`,
      query
    });
  }

  async createPost(input: {
    submolt_name: string;
    title: string;
    content?: string;
    url?: string;
    type?: "text" | "link" | "image";
  }): Promise<{ success?: boolean; message?: string; post?: MoltbookPost }> {
    const payload = await this.request<{ success?: boolean; message?: string; post?: MoltbookPost }>({
      method: "POST",
      path: "/posts",
      body: input
    });

    return this.autoVerifyIfNeeded(payload);
  }

  async deletePost(postId: string): Promise<{ success?: boolean; message?: string }> {
    return this.request<{ success?: boolean; message?: string }>({
      method: "DELETE",
      path: `/posts/${postId}`
    });
  }

  async createComment(
    postId: string,
    input: {
      content: string;
      parent_id?: string;
    }
  ): Promise<{ success?: boolean; message?: string; comment?: MoltbookComment }> {
    const payload = await this.request<{
      success?: boolean;
      message?: string;
      comment?: MoltbookComment;
    }>({
      method: "POST",
      path: `/posts/${postId}/comments`,
      body: input
    });

    return this.autoVerifyIfNeeded(payload);
  }

  async upvotePost(postId: string): Promise<{ success?: boolean; message?: string }> {
    return this.request<{ success?: boolean; message?: string }>({
      method: "POST",
      path: `/posts/${postId}/upvote`
    });
  }

  async upvoteComment(commentId: string): Promise<{ success?: boolean; message?: string }> {
    return this.request<{ success?: boolean; message?: string }>({
      method: "POST",
      path: `/comments/${commentId}/upvote`
    });
  }

  async followAgent(agentName: string): Promise<{ success?: boolean; message?: string }> {
    return this.request<{ success?: boolean; message?: string }>({
      method: "POST",
      path: `/agents/${agentName}/follow`
    });
  }

  async unfollowAgent(agentName: string): Promise<{ success?: boolean; message?: string }> {
    return this.request<{ success?: boolean; message?: string }>({
      method: "DELETE",
      path: `/agents/${agentName}/follow`
    });
  }

  async markNotificationsReadByPost(postId: string): Promise<{ success?: boolean }> {
    return this.request<{ success?: boolean }>({
      method: "POST",
      path: `/notifications/read-by-post/${postId}`
    });
  }

  async markAllNotificationsRead(): Promise<{ success?: boolean }> {
    return this.request<{ success?: boolean }>({
      method: "POST",
      path: "/notifications/read-all"
    });
  }

  async verify(verificationCode: string, answer: string): Promise<MoltbookVerifyResponse> {
    return this.request<MoltbookVerifyResponse>({
      method: "POST",
      path: "/verify",
      body: {
        verification_code: verificationCode,
        answer
      }
    });
  }

  async request<T>(options: MoltbookRequestOptions): Promise<T> {
    const method = options.method ?? "GET";
    const url = buildUrl(this.baseUrl, options.path, options.query);
    const authenticated = options.authenticated ?? true;
    assertSecureAuthTarget(url, authenticated ? this.apiKey : undefined);

    const headers = new Headers();
    if (authenticated) {
      if (!this.apiKey) {
        throw new Error(`Moltbook API key is required for ${method} ${options.path}`);
      }

      headers.set("Authorization", `Bearer ${this.apiKey}`);
    }

    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const rateLimit = parseRateLimit(response.headers);
    const payload = await parseBody(response);

    if (!response.ok) {
      const message =
        typeof payload === "object" && payload && "error" in payload
          ? String((payload as Record<string, unknown>).error)
          : `${method} ${options.path} failed with status ${response.status}`;
      throw new MoltbookApiError(message, response.status, payload, rateLimit);
    }

    return payload as T;
  }

  private async autoVerifyIfNeeded<T>(payload: T): Promise<T> {
    if (!this.autoVerify) {
      return payload;
    }

    const carrier = getVerificationCarrier(payload);
    if (!carrier?.value.verification?.verification_code) {
      return payload;
    }

    const challengeText = carrier.value.verification.challenge_text;
    const solved = await solveVerificationChallengeWithFallback(challengeText, {
      verificationLlmProvider: this.verificationLlmProvider
    });
    try {
      await this.verify(carrier.value.verification.verification_code, solved.answer);
    } catch (error) {
      if (
        solved.provider === "deterministic" &&
        this.verificationLlmProvider &&
        isIncorrectVerificationAnswer(error)
      ) {
        const llmSolved = await solveVerificationChallengeWithLlm(challengeText, this.verificationLlmProvider);
        try {
          await this.verify(carrier.value.verification.verification_code, llmSolved.answer);
          return payload;
        } catch (llmError) {
          throw new Error(
            `Failed to auto-verify ${carrier.type} challenge "${challengeText}" after deterministic answer "${solved.answer}" and LLM retry "${llmSolved.answer}" via ${llmSolved.provider}.`,
            { cause: llmError }
          );
        }
      }

      throw new Error(
        `Failed to auto-verify ${carrier.type} challenge "${challengeText}" with answer "${solved.answer}" via ${solved.provider}.`,
        { cause: error }
      );
    }
    return payload;
  }
}

