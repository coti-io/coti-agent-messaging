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
  fetchImpl?: typeof fetch;
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

function fuzzyNumberValue(token: string): number | undefined {
  if (/^-?\d+(?:\.\d+)?$/.test(token)) {
    return Number(token);
  }

  let bestMatch: { value: number; distance: number } | undefined;
  for (const [word, value] of NUMBER_WORDS.entries()) {
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
  const tokens = text.split(" ").filter(Boolean);
  const values: number[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const current = fuzzyNumberValue(tokens[index]!);
    if (current === undefined) {
      continue;
    }

    const next = tokens[index + 1] ? fuzzyNumberValue(tokens[index + 1]!) : undefined;
    if (
      current >= 20 &&
      current % 10 === 0 &&
      next !== undefined &&
      next >= 1 &&
      next <= 9
    ) {
      values.push(current + next);
      index += 1;
      continue;
    }

    values.push(current);
  }

  return values;
}

function detectOperation(text: string): ((left: number, right: number) => number) | undefined {
  const hasWord = (candidates: readonly string[]) =>
    candidates.some((candidate) => text.includes(candidate));

  if (
    hasWord([
      "slows by",
      "slow by",
      "minus",
      "decrease",
      "decreases by",
      "drops by",
      "lost",
      "lose",
      "loses",
      "less"
    ])
  ) {
    return (left, right) => left - right;
  }

  if (
    hasWord([
      "plus",
      "add",
      "adds",
      "gains",
      "gain",
      "increase",
      "increases by",
      "more"
    ])
  ) {
    return (left, right) => left + right;
  }

  if (hasWord(["times", "multiplied by", "double", "doubles", "triple", "triples"])) {
    return (left, right) => left * right;
  }

  if (hasWord(["divided by", "divide", "per", "split among", "shared among"])) {
    return (left, right) => left / right;
  }

  return undefined;
}

export function solveVerificationChallenge(challengeText: string): string {
  const normalized = normalizeChallengeText(challengeText);
  const numbers = extractNumbers(normalized);
  const operation = detectOperation(normalized);

  if (numbers.length < 2 || !operation) {
    throw new Error(`Unable to solve verification challenge: ${challengeText}`);
  }

  const result = operation(numbers[0]!, numbers[1]!);
  if (!Number.isFinite(result)) {
    throw new Error(`Verification challenge produced a non-finite result: ${challengeText}`);
  }

  return result.toFixed(2);
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

  constructor(options: MoltbookApiClientOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.autoVerify = options.autoVerify ?? true;
    this.fetchImpl = options.fetchImpl ?? fetch;
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

    const answer = solveVerificationChallenge(carrier.value.verification.challenge_text);
    await this.verify(carrier.value.verification.verification_code, answer);
    return payload;
  }
}

