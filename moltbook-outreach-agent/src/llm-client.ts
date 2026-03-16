export interface ChatClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  appName?: string;
  siteUrl?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function createJsonChatCompletion<T>(
  config: ChatClientConfig,
  messages: readonly ChatMessage[],
  fetchImpl: typeof fetch = fetch
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const headers = new Headers({
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    });
    if (config.siteUrl) {
      headers.set("HTTP-Referer", config.siteUrl);
    }
    if (config.appName) {
      headers.set("X-Title", config.appName);
    }

    const response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        response_format: {
          type: "json_object"
        },
        messages
      })
    });

    const payload = await parseResponseBody(response);
    if (!response.ok) {
      throw new Error(`Chat completion failed with status ${response.status}.`);
    }

    const content = extractResponseText(payload);
    if (!content) {
      throw new Error("Chat completion did not return any content.");
    }

    return JSON.parse(content) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function parseResponseBody(response: Response): Promise<unknown> {
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

export function extractResponseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const record = payload as Record<string, unknown>;
  const choices = record.choices;
  if (Array.isArray(choices)) {
    const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
    if (typeof content === "string") {
      return content;
    }
  }

  const outputText = record.output_text;
  if (typeof outputText === "string") {
    return outputText;
  }

  return "";
}
