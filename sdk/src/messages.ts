import type {
  ListMessagesRequest,
  ListMessagesResult,
  MessageView,
  ReadMessageRequest,
  ReadMessageResult,
  SendMessageRequest,
  SendMessageResult
} from "./types.js";
import { PrivateAgentMessagingClient } from "./client.js";

function asBigIntArray(values: readonly unknown[]): bigint[] {
  return values.map((value) => BigInt(value as string | number | bigint));
}

function normalizeMessageView(raw: any): MessageView {
  return {
    id: BigInt(raw.id),
    from: raw.from,
    to: raw.to,
    timestamp: BigInt(raw.timestamp),
    epoch: BigInt(raw.epoch),
    ciphertext: {
      value: asBigIntArray(raw.ciphertext.value ?? [])
    }
  };
}

async function maybeDecryptMessage(
  client: PrivateAgentMessagingClient,
  message: MessageView,
  decrypt: boolean
): Promise<string | undefined> {
  if (!decrypt || typeof client.runner?.decryptValue !== "function") {
    return undefined;
  }

  return client.runner.decryptValue(message.ciphertext);
}

function extractMessageId(client: PrivateAgentMessagingClient, receipt: any): bigint | undefined {
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = client.contract.interface.parseLog(log);
      if (parsed?.name === "MessageSent") {
        return BigInt(parsed.args.messageId);
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

export async function encryptMessageInput(
  client: PrivateAgentMessagingClient,
  plaintext: string
) {
  if (typeof client.runner?.encryptValue !== "function") {
    throw new Error("Runner does not support encryptValue().");
  }

  return client.runner.encryptValue(
    plaintext,
    client.contractAddress,
    client.sendMessageSelector
  );
}

export async function sendMessage(
  client: PrivateAgentMessagingClient,
  request: SendMessageRequest
): Promise<SendMessageResult> {
  const encryptedMessage = await encryptMessageInput(client, request.plaintext);
  const tx = await client.contract.sendMessage(request.to, encryptedMessage);
  const receipt = await tx.wait();

  return {
    transactionHash: receipt.hash ?? tx.hash,
    messageId: extractMessageId(client, receipt)
  };
}

export async function readMessage(
  client: PrivateAgentMessagingClient,
  request: ReadMessageRequest
): Promise<ReadMessageResult> {
  const raw = await client.contract.getMessage(request.messageId);
  const message = normalizeMessageView(raw);
  const plaintext = await maybeDecryptMessage(client, message, request.decrypt ?? true);

  return {
    message,
    plaintext
  };
}

async function listMessageIds(
  client: PrivateAgentMessagingClient,
  direction: "getInboxPage" | "getSentPage",
  request: ListMessagesRequest
): Promise<bigint[]> {
  const rawIds = await client.contract[direction](
    request.account,
    request.offset ?? 0,
    request.limit ?? 20
  );

  return (rawIds as readonly unknown[]).map((value) => BigInt(value as string | number | bigint));
}

export async function listInbox(
  client: PrivateAgentMessagingClient,
  request: ListMessagesRequest
): Promise<ListMessagesResult> {
  const ids = await listMessageIds(client, "getInboxPage", request);
  if (request.decrypt === false) {
    return { ids };
  }

  const messages = await Promise.all(ids.map((messageId) => readMessage(client, { messageId })));
  return { ids, messages };
}

export async function listSent(
  client: PrivateAgentMessagingClient,
  request: ListMessagesRequest
): Promise<ListMessagesResult> {
  const ids = await listMessageIds(client, "getSentPage", request);
  if (request.decrypt === false) {
    return { ids };
  }

  const messages = await Promise.all(ids.map((messageId) => readMessage(client, { messageId })));
  return { ids, messages };
}
