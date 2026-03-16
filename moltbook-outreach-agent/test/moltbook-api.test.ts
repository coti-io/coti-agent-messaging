import test from "node:test";
import assert from "node:assert/strict";

import {
  MoltbookApiClient,
  solveVerificationChallenge,
  solveVerificationChallengeWithFallback
} from "../src/moltbook-api.js";

test("refuses to send an API key to a non-Moltbook host", async () => {
  const client = new MoltbookApiClient({
    baseUrl: "https://example.com/api/v1",
    apiKey: "moltbook_secret"
  });

  await assert.rejects(() => client.getHome(), /Only www\.moltbook\.com is allowed/);
});

test("adds the bearer token for authenticated Moltbook requests", async () => {
  let authorizationHeader: string | null = null;

  const client = new MoltbookApiClient({
    baseUrl: "https://www.moltbook.com/api/v1",
    apiKey: "moltbook_secret",
    fetchImpl: async (_url, init) => {
      authorizationHeader = new Headers(init?.headers).get("Authorization");
      return new Response(JSON.stringify({ status: "claimed" }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
  });

  const result = await client.getStatus();
  assert.equal(result.status, "claimed");
  assert.equal(authorizationHeader, "Bearer moltbook_secret");
});

test("deletes a post with the documented endpoint", async () => {
  let requestPath = "";
  let requestMethod = "";

  const client = new MoltbookApiClient({
    baseUrl: "https://www.moltbook.com/api/v1",
    apiKey: "moltbook_secret",
    fetchImpl: async (url, init) => {
      requestPath = new URL(String(url)).pathname;
      requestMethod = init?.method ?? "GET";
      return new Response(JSON.stringify({ success: true, message: "Deleted." }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
  });

  const result = await client.deletePost("post-123");
  assert.equal(requestMethod, "DELETE");
  assert.equal(requestPath, "/api/v1/posts/post-123");
  assert.equal(result.success, true);
});

test("solves the documented verification challenge example", () => {
  const answer = solveVerificationChallenge(
    "A] lO^bSt-Er S[wImS aT/ tW]eNn-Tyy mE^tE[rS aNd] SlO/wS bY^ fI[vE, wH-aTs] ThE/ nEw^ SpE[eD?"
  );

  assert.equal(answer, "15.00");
});

test("solves addition challenges phrased as a total", () => {
  const answer = solveVerificationChallenge(
    "Lo]b-StErRrS' ClAaWwS ^HaVe PhYySsIx Um, LoO.oObBsStTeErRr SwImS aNd LiKe, ThE ClAaW ExErTs TwEnTy FiVe NeWtOnS ]AnD AnOtHeR ClAaW ExErTs SeVeNtEeN NeWtOnS, HoW/ ToTaL FoRcE <PlEaSe>?"
  );

  assert.equal(answer, "42.00");
});

test("solves subtraction challenges without mistaking unit text for division", () => {
  const answer = solveVerificationChallenge(
    "A] Lo-BsTeR S^wImS/ vElAwCiTeE aT< tWeN tY ThReE~ mE}tErS PeR| sEcOnD, BuT~ iT/ sLoW s By{ sEvEn] mEtErS PeR| sEcOnD, WhAt< iS> tHe/ nEw~ vElOcItY?"
  );

  assert.equal(answer, "16.00");
});

test("solves addition challenges with split number words", () => {
  const answer = solveVerificationChallenge(
    "A] lO-bS tErr S^wI mS[ aT/ tWeN tYy ThReE] mE^tE rS/ pEr\\ sEcOnD, uM| aNd# cLaW] F^oR cE aDdS[ fIvE< nEu-ToNs, wHaT/ iS] tHe^ sUm~ oF tHeSe?"
  );

  assert.equal(answer, "28.00");
});

test("ignores incidental small counts when larger operands are present", () => {
  const answer = solveVerificationChallenge(
    "A] LoB-sT eR ExErTs^ FiFtY ] nEwToNs- WiTh/ OnE ClAw, Um~ AnD OtHeR ClAw ExErTs^ TwEnTy FiVe ] NeWToNs; WhAt- Is/ ToTaL FoRcE?"
  );

  assert.equal(answer, "75.00");
});

test("solves subtraction phrased as slows down by", () => {
  const answer = solveVerificationChallenge(
    "A] lO^bSt-Er S[wImS aT tW/eNtY tHrEe mE^tErS pEr] sEcOnD, uM{ lOoObssster~ sLoWwS dOwN- bY sEvEn mE^tErS PeR\\ sEcOnD, wHaT< iS tHe- nEw^ vElAwCiTyyy?"
  );

  assert.equal(answer, "16.00");
});

test("solves noisy addition after denoising repeated letters", () => {
  const answer = solveVerificationChallenge(
    "A] Lo.OoBb-SsSttEeRr ] ClAaWw ] ExXrRtSs ] ThIrTy ] NoOoToOnSs ] Um~ ] AnNd ] An ] AlLlLy ] AdDdSs ] TwEeNnTtYy ] FiIvVeEe ] MoOrRe ] , ] WhHaTtSs ] ThHe ] ToOtAaLl ] FoOrRcEe ] ? }"
  );

  assert.equal(answer, "55.00");
});

test("solves velocity challenges phrased as gains toward a new velocity", () => {
  const answer = solveVerificationChallenge(
    "A] Lo.bSt-Er S^wImS[ iN/ CoOl WaTeR, HeR VeLoOciTy Is TwEnTy FiVe CeNtImEtErS PeR SeCoNd] AnD GaInS~ SeVeN CeNtImEtErS PeR SeCoNd FrOm DoMiNaNcE FiGhT, WhAt] Is ThE NeW VeLoCiTy?"
  );

  assert.equal(answer, "32.00");
});

test("uses the LLM fallback when deterministic parsing fails", async () => {
  const result = await solveVerificationChallengeWithFallback(
    "utter nonsense captcha text that the local parser cannot solve",
    {
      verificationLlm: {
        apiKey: "llm-secret",
        baseUrl: "https://example-llm.test/v1",
        model: "solver-mini",
        timeoutMs: 5000
      },
      fetchImpl: async (url, init) => {
        assert.equal(String(url), "https://example-llm.test/v1/chat/completions");
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer llm-secret");

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ answer: "42.00" })
                }
              }
            ]
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }
    }
  );

  assert.deepEqual(result, {
    answer: "42.00",
    provider: "llm:solver-mini",
    confidence: "low"
  });
});

test("uses an injected verification provider before any HTTP fallback", async () => {
  let providerCalls = 0;

  const result = await solveVerificationChallengeWithFallback(
    "utter nonsense captcha text that the local parser cannot solve",
    {
      verificationLlmProvider: {
        label: "self-solver",
        async createJsonCompletion<T>() {
          providerCalls += 1;
          return { answer: "39.00" } as T;
        }
      }
    }
  );

  assert.equal(providerCalls, 1);
  assert.deepEqual(result, {
    answer: "39.00",
    provider: "llm:self-solver",
    confidence: "low"
  });
});

test("prefers the LLM for noisy verification challenges", async () => {
  let llmCalls = 0;

  const result = await solveVerificationChallengeWithFallback(
    "A] lOoObsT-Er^ swImS[ iN~ cOoLmY wAtEr| anD um, cLaW fOrCeS <thIrTy fIvE> + {sEeVeNtEeN} nOoToNs~ duR|inG tErRiToRy fIgHtS, hOw/ mUcH ToTaL fOrCe?",
    {
      verificationLlm: {
        apiKey: "llm-secret",
        baseUrl: "https://example-llm.test/v1",
        model: "solver-mini",
        timeoutMs: 5000
      },
      fetchImpl: async () => {
        llmCalls += 1;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ answer: "52.00" })
                }
              }
            ]
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }
    }
  );

  assert.equal(llmCalls, 1);
  assert.deepEqual(result, {
    answer: "52.00",
    provider: "llm:solver-mini",
    confidence: "low"
  });
});

test("auto-verify retries once with the LLM after an incorrect deterministic answer", async () => {
  const verifyAnswers: string[] = [];
  let llmCalls = 0;

  const client = new MoltbookApiClient({
    baseUrl: "https://www.moltbook.com/api/v1",
    apiKey: "moltbook_secret",
    autoVerify: true,
    verificationLlm: {
      apiKey: "llm-secret",
      baseUrl: "https://example-llm.test/v1",
      model: "solver-mini",
      timeoutMs: 5000
    },
    fetchImpl: async (url, init) => {
      const requestUrl = new URL(String(url));
      const method = init?.method ?? "GET";

      if (requestUrl.pathname === "/api/v1/posts/post-1/comments" && method === "POST") {
        return new Response(
          JSON.stringify({
            success: true,
            comment: {
              id: "comment-1",
              post_id: "post-1",
              content: "hello",
              verification: {
                verification_code: "verify-123",
                challenge_text: "A lobster swims at twenty meters per second and slows by five what is the new speed"
              }
            }
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }

      if (requestUrl.pathname === "/api/v1/verify" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { answer?: string };
        verifyAnswers.push(body.answer ?? "");
        if (verifyAnswers.length === 1) {
          return new Response(
            JSON.stringify({
              success: false,
              message: "Incorrect answer"
            }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json"
              }
            }
          );
        }

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }

      throw new Error(`Unhandled fetch: ${method} ${requestUrl.pathname}`);
    },
    llmFetchImpl: async () => {
      llmCalls += 1;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ answer: "42.00" })
              }
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }
  });

  const result = await client.createComment("post-1", { content: "hello" });
  assert.equal(result.success, true);
  assert.deepEqual(verifyAnswers, ["15.00", "42.00"]);
  assert.equal(llmCalls, 1);
});

