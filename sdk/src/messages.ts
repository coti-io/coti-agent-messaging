import type {
  AccountStats,
  CtString,
  ListMessagesRequest,
  ListMessagesResult,
  MessageView,
  MessageMetadata,
  ReadMessageRequest,
  ReadMessageResult,
  SendMessageRequest,
  SendMessageResult
} from "./types.js";
import { PrivateMessagingClient } from "./client.js";

export const DEFAULT_MAX_MESSAGE_CHUNK_BYTES = 24;
export const DEFAULT_MULTIPART_GAS_BUFFER_BPS = 2_000;

function normalizeBigInt(
  value: bigint | number | string | undefined
): bigint | undefined {
  if (value === undefined) {
    return undefined;
  }

  return BigInt(value);
}

function applyGasBuffer(estimatedGas: bigint, gasBufferBps: number): bigint {
  if (!Number.isInteger(gasBufferBps) || gasBufferBps < 0) {
    throw new Error("gasBufferBps must be a non-negative integer.");
  }

  return (estimatedGas * BigInt(10_000 + gasBufferBps) + 9_999n) / 10_000n;
}

async function resolveMultipartGasLimit(
  client: PrivateMessagingClient,
  to: string,
  encryptedChunks: any[],
  requestedGasLimit: bigint | number | string | undefined,
  requestedGasBufferBps: number | undefined
): Promise<bigint | undefined> {
  const gasLimit = normalizeBigInt(requestedGasLimit);
  if (gasLimit !== undefined) {
    return gasLimit;
  }

  const estimateGas = client.contract?.sendMultipartMessage?.estimateGas;
  if (typeof estimateGas !== "function") {
    return undefined;
  }

  const estimatedGas = BigInt(await estimateGas(to, encryptedChunks));
  return applyGasBuffer(
    estimatedGas,
    requestedGasBufferBps ?? DEFAULT_MULTIPART_GAS_BUFFER_BPS
  );
}

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
    chunkCount: BigInt(raw.chunkCount ?? 1),
    ciphertext: {
      value: asBigIntArray(raw.ciphertext.value ?? [])
    }
  };
}

function normalizeMessageMetadata(raw: any): MessageMetadata {
  return {
    from: raw.from,
    to: raw.to,
    timestamp: BigInt(raw.timestamp),
    epoch: BigInt(raw.epoch)
  };
}

function normalizeCiphertext(raw: any): CtString {
  return {
    value: asBigIntArray(raw.value ?? [])
  };
}

function splitPlaintextIntoChunks(
  plaintext: string,
  maxChunkBytes: number = DEFAULT_MAX_MESSAGE_CHUNK_BYTES
): string[] {
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes <= 0) {
    throw new Error("maxChunkBytes must be a positive integer.");
  }

  const chunks: string[] = [];
  let currentChunk = "";
  let currentBytes = 0;

  for (const char of plaintext) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (charBytes > maxChunkBytes) {
      throw new Error("A single character exceeds the configured chunk size.");
    }

    if (currentBytes + charBytes > maxChunkBytes) {
      chunks.push(currentChunk);
      currentChunk = char;
      currentBytes = charBytes;
      continue;
    }

    currentChunk += char;
    currentBytes += charBytes;
  }

  if (currentChunk.length > 0 || chunks.length === 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

async function encryptChunkInput(
  client: PrivateMessagingClient,
  plaintext: string,
  functionSelector: string
) {
  if (typeof client.runner?.encryptString === "function") {
    return client.runner.encryptString(
      plaintext,
      client.contractAddress,
      functionSelector
    );
  }

  if (typeof client.runner?.encryptValue === "function") {
    return client.runner.encryptValue(
      plaintext,
      client.contractAddress,
      functionSelector
    );
  }

  throw new Error("Runner does not support string encryption.");
}

async function maybeDecryptMessage(
  client: PrivateMessagingClient,
  chunks: CtString[],
  decrypt: boolean
): Promise<string | undefined> {
  if (!decrypt) {
    return undefined;
  }

  if (typeof client.runner?.decryptString === "function") {
    const plaintextChunks = await Promise.all(
      chunks.map((chunk) => client.runner.decryptString(chunk))
    );
    return plaintextChunks.join("");
  }

  if (typeof client.runner?.decryptValue === "function") {
    const plaintextChunks = await Promise.all(
      chunks.map((chunk) => client.runner.decryptValue(chunk))
    );
    return plaintextChunks.join("");
  }

  return undefined;
}

function extractMessageId(client: PrivateMessagingClient, receipt: any): bigint | undefined {
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
  client: PrivateMessagingClient,
  plaintext: string
) {
  return encryptChunkInput(client, plaintext, client.sendMessageSelector);
}

export async function sendMessage(
  client: PrivateMessagingClient,
  request: SendMessageRequest
): Promise<SendMessageResult> {
  const plaintextChunks = splitPlaintextIntoChunks(
    request.plaintext,
    request.maxChunkBytes ?? DEFAULT_MAX_MESSAGE_CHUNK_BYTES
  );
  const functionSelector =
    plaintextChunks.length === 1
      ? client.sendMessageSelector
      : client.sendMultipartMessageSelector;

  const encryptedChunks = await Promise.all(
    plaintextChunks.map((chunk) => encryptChunkInput(client, chunk, functionSelector))
  );
  const multipartGasLimit =
    encryptedChunks.length > 1
      ? await resolveMultipartGasLimit(
          client,
          request.to,
          encryptedChunks,
          request.gasLimit,
          request.gasBufferBps
        )
      : normalizeBigInt(request.gasLimit);
  const txOverrides =
    multipartGasLimit === undefined ? undefined : { gasLimit: multipartGasLimit };

  const tx =
    encryptedChunks.length === 1
      ? await client.contract.sendMessage(request.to, encryptedChunks[0], txOverrides)
      : await client.contract.sendMultipartMessage(
          request.to,
          encryptedChunks,
          txOverrides
        );
  const receipt = await tx.wait();

  return {
    transactionHash: receipt.hash ?? tx.hash,
    messageId: extractMessageId(client, receipt)
  };
}

export async function readMessage(
  client: PrivateMessagingClient,
  request: ReadMessageRequest
): Promise<ReadMessageResult> {
  const raw = await client.contract.getMessage(request.messageId);
  const message = normalizeMessageView(raw);
  const chunks: CtString[] = [message.ciphertext];

  for (let chunkIndex = 1; chunkIndex < Number(message.chunkCount); chunkIndex += 1) {
    const rawChunk = await client.contract.getMessageChunk(request.messageId, chunkIndex);
    chunks.push(normalizeCiphertext(rawChunk));
  }

  const plaintext = await maybeDecryptMessage(client, chunks, request.decrypt ?? true);

  return {
    message,
    chunks,
    plaintext
  };
}

export async function getMessageMetadata(
  client: PrivateMessagingClient,
  messageId: bigint | number | string
): Promise<MessageMetadata> {
  return normalizeMessageMetadata(await client.contract.getMessageMetadata(messageId));
}

async function listMessageIds(
  client: PrivateMessagingClient,
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
  client: PrivateMessagingClient,
  request: ListMessagesRequest
): Promise<ListMessagesResult> {
  const ids = await listMessageIds(client, "getInboxPage", request);
  if (request.decrypt === false) {
    return { ids };
  }

  const messages = await Promise.all(ids.map((messageId) => readMessage(client, { messageId })));
  return { ids, messages };
}

export async function getAccountStats(
  client: PrivateMessagingClient,
  account: string
): Promise<AccountStats> {
  const [inboxCount, sentCount] = await Promise.all([
    client.contract.inboxCount(account),
    client.contract.sentCount(account)
  ]);

  return {
    account,
    inboxCount: BigInt(inboxCount),
    sentCount: BigInt(sentCount)
  };
}

export async function listSent(
  client: PrivateMessagingClient,
  request: ListMessagesRequest
): Promise<ListMessagesResult> {
  const ids = await listMessageIds(client, "getSentPage", request);
  if (request.decrypt === false) {
    return { ids };
  }

  const messages = await Promise.all(ids.map((messageId) => readMessage(client, { messageId })));
  return { ids, messages };
}
