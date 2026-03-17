import { createHash, randomInt, randomUUID } from "node:crypto";

function hashAnswer(challengeId: string, answer: string): string {
  return createHash("sha256").update(`${challengeId}:${answer}`).digest("hex");
}

export function normalizeChallengeAnswer(answer: string): string {
  return answer.replace(/\s+/g, " ").trim().toLowerCase();
}

export function verifyChallengeAnswer(
  challengeId: string,
  answer: string,
  expectedAnswerHash: string
): boolean {
  return hashAnswer(challengeId, normalizeChallengeAnswer(answer)) === expectedAnswerHash;
}

export function buildStarterGrantChallenge(input: {
  walletAddress: string;
  installId: string;
  issuedAt: Date;
  ttlMs: number;
}) {
  const challengeId = randomUUID();
  const challengeNonce = randomUUID();
  const left = randomInt(11, 70);
  const right = randomInt(2, 17);
  const variant = randomInt(0, 3);

  const operation =
    variant === 0
      ? {
          prompt: `Starter grant check: if an agent has ${left} private messages queued and receives ${right} more, what is the total? Reply with digits only.`,
          answer: String(left + right)
        }
      : variant === 1
        ? {
            prompt: `Starter grant check: if an agent has ${left} queued messages and archives ${right}, how many remain? Reply with digits only.`,
            answer: String(left - right)
          }
        : {
            prompt: `Starter grant check: ${left} encrypted chunks spread across ${right} identical threads means how many chunk-thread pairs in total? Reply with digits only.`,
            answer: String(left * right)
          };
  const expiresAt = new Date(input.issuedAt.getTime() + input.ttlMs);
  const claimPayload = JSON.stringify({
    purpose: "starter-grant-claim",
    walletAddress: input.walletAddress,
    installId: input.installId,
    challengeId,
    challengeNonce,
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString()
  });

  return {
    challengeId,
    prompt: operation.prompt,
    expectedAnswerHash: hashAnswer(challengeId, normalizeChallengeAnswer(operation.answer)),
    claimPayload,
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString()
  };
}
