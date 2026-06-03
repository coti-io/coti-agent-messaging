import type { BridgeLlmClientConfig, ChatClientConfig } from "../llm-client.js";
import { defaultLlmDebugDir } from "./runtime-paths.js";

function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface LlmRuntimeBundle {
  llm?: ChatClientConfig;
  llmBridge?: BridgeLlmClientConfig;
  verificationLlm?: ChatClientConfig;
  verificationLlmBridge?: BridgeLlmClientConfig;
  llmDebugDir: string;
}

export function buildLlmRuntimeConfig(statePath: string, resolvePath: (value: string) => string): LlmRuntimeBundle {
  const llmApiKey = getOptionalEnv("MOLTBOOK_LLM_API_KEY") ?? getOptionalEnv("OPENROUTER_API_KEY");
  const llm = llmApiKey
    ? {
        apiKey: llmApiKey,
        baseUrl:
          process.env.MOLTBOOK_LLM_BASE_URL ??
          process.env.OPENROUTER_BASE_URL ??
          "https://openrouter.ai/api/v1",
        model:
          process.env.MOLTBOOK_LLM_MODEL ??
          process.env.OPENROUTER_MODEL ??
          "openai/gpt-4o-mini",
        timeoutMs: parseNumber(process.env.MOLTBOOK_LLM_TIMEOUT_MS, 20_000),
        appName: process.env.MOLTBOOK_LLM_APP_NAME ?? "outreach-agent",
        siteUrl: process.env.MOLTBOOK_LLM_SITE_URL
      }
    : undefined;
  const llmBridgeUrl = getOptionalEnv("MOLTBOOK_LLM_BRIDGE_URL");
  const llmBridge = llmBridgeUrl
    ? {
        url: llmBridgeUrl,
        timeoutMs: parseNumber(process.env.MOLTBOOK_LLM_BRIDGE_TIMEOUT_MS, llm?.timeoutMs ?? 20_000),
        label: process.env.MOLTBOOK_LLM_BRIDGE_LABEL ?? "local-bridge",
        authToken: getOptionalEnv("MOLTBOOK_LLM_BRIDGE_AUTH_TOKEN")
      }
    : undefined;
  const verificationLlmApiKey = getOptionalEnv("MOLTBOOK_VERIFY_LLM_API_KEY") ?? llm?.apiKey;
  const verificationLlmBridgeUrl = getOptionalEnv("MOLTBOOK_VERIFY_LLM_BRIDGE_URL") ?? llmBridge?.url;

  return {
    llm,
    llmBridge,
    verificationLlm: verificationLlmApiKey
      ? {
          apiKey: verificationLlmApiKey,
          baseUrl:
            process.env.MOLTBOOK_VERIFY_LLM_BASE_URL ??
            llm?.baseUrl ??
            "https://openrouter.ai/api/v1",
          model:
            process.env.MOLTBOOK_VERIFY_LLM_MODEL ??
            llm?.model ??
            "openai/gpt-4o-mini",
          timeoutMs: parseNumber(
            process.env.MOLTBOOK_VERIFY_LLM_TIMEOUT_MS,
            llm?.timeoutMs ?? 10_000
          )
        }
      : undefined,
    verificationLlmBridge: verificationLlmBridgeUrl
      ? {
          url: verificationLlmBridgeUrl,
          timeoutMs: parseNumber(
            process.env.MOLTBOOK_VERIFY_LLM_BRIDGE_TIMEOUT_MS,
            llmBridge?.timeoutMs ?? llm?.timeoutMs ?? 10_000
          ),
          label:
            process.env.MOLTBOOK_VERIFY_LLM_BRIDGE_LABEL ??
            llmBridge?.label ??
            "local-bridge",
          authToken:
            getOptionalEnv("MOLTBOOK_VERIFY_LLM_BRIDGE_AUTH_TOKEN") ?? llmBridge?.authToken
        }
      : undefined,
    llmDebugDir: resolvePath(
      getOptionalEnv("MOLTBOOK_LLM_DEBUG_DIR") ?? defaultLlmDebugDir(statePath)
    )
  };
}
