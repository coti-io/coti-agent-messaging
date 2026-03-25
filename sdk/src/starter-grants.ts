import type { PrivateMessagingClient } from "./client.js";
import { getOrCreateInstallId } from "./install-state.js";
import type {
  ClaimStarterGrantRequest,
  ClaimStarterGrantResult,
  GetStarterGrantChallengeResult,
  GetStarterGrantStatusResult,
  RequestStarterGrantResult,
  StarterGrantServiceConfig
} from "./types.js";

function requireStarterGrantConfig(
  config: StarterGrantServiceConfig | undefined
): StarterGrantServiceConfig {
  if (!config?.url) {
    throw new Error(
      "Starter grant service is not configured. Set STARTER_GRANT_SERVICE_URL for the MCP server."
    );
  }

  return config;
}

async function postJson<T>(
  url: string,
  body: unknown,
  config: StarterGrantServiceConfig,
  fetchImpl?: typeof fetch
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await (fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.authToken ? { Authorization: `Bearer ${config.authToken}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error(payload.error ?? `Starter grant request failed with status ${response.status}`);
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getStarterGrantChallenge(
  client: PrivateMessagingClient,
  configInput: StarterGrantServiceConfig | undefined,
  fetchImpl?: typeof fetch
): Promise<GetStarterGrantChallengeResult> {
  const config = requireStarterGrantConfig(configInput);
  const walletAddress = await client.getAddress();
  const installId = await getOrCreateInstallId(config.installIdPath);

  return postJson<GetStarterGrantChallengeResult>(
    `${config.url.replace(/\/+$/, "")}/challenge`,
    {
      walletAddress,
      installId
    },
    config,
    fetchImpl
  );
}

export async function getStarterGrantStatus(
  client: PrivateMessagingClient,
  configInput: StarterGrantServiceConfig | undefined,
  fetchImpl?: typeof fetch
): Promise<GetStarterGrantStatusResult> {
  const config = requireStarterGrantConfig(configInput);
  const walletAddress = await client.getAddress();
  const installId = await getOrCreateInstallId(config.installIdPath);

  return postJson<GetStarterGrantStatusResult>(
    `${config.url.replace(/\/+$/, "")}/status`,
    {
      walletAddress,
      installId
    },
    config,
    fetchImpl
  );
}

export async function claimStarterGrant(
  client: PrivateMessagingClient,
  configInput: StarterGrantServiceConfig | undefined,
  input: ClaimStarterGrantRequest,
  fetchImpl?: typeof fetch
): Promise<ClaimStarterGrantResult> {
  const config = requireStarterGrantConfig(configInput);
  const walletAddress = await client.getAddress();
  const installId = await getOrCreateInstallId(config.installIdPath);
  const signature = await client.signMessage(input.claimPayload);

  return postJson<ClaimStarterGrantResult>(
    `${config.url.replace(/\/+$/, "")}/claim`,
    {
      challengeId: input.challengeId,
      walletAddress,
      installId,
      challengeAnswer: input.challengeAnswer,
      claimPayload: input.claimPayload,
      signature
    },
    config,
    fetchImpl
  );
}

function solveStarterGrantPrompt(prompt: string): string {
  const numbers = [...prompt.matchAll(/\b\d+\b/g)].map((match) => Number(match[0]));
  if (numbers.length < 2) {
    throw new Error("Starter grant prompt did not contain enough numeric operands to solve.");
  }

  const [left, right] = numbers;
  if (/\bchunk-thread pairs\b/i.test(prompt)) {
    return String(left * right);
  }

  if (/\bremain\b/i.test(prompt)) {
    return String(left - right);
  }

  return String(left + right);
}

export async function requestStarterGrant(
  client: PrivateMessagingClient,
  configInput: StarterGrantServiceConfig | undefined,
  fetchImpl?: typeof fetch
): Promise<RequestStarterGrantResult> {
  const challenge = await getStarterGrantChallenge(client, configInput, fetchImpl);
  const claim = await claimStarterGrant(
    client,
    configInput,
    {
      challengeId: challenge.challengeId,
      challengeAnswer: solveStarterGrantPrompt(challenge.prompt),
      claimPayload: challenge.claimPayload
    },
    fetchImpl
  );

  return {
    ...claim,
    prompt: challenge.prompt,
    expiresAt: challenge.expiresAt
  };
}
