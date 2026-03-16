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
    provider: "llm:solver-mini"
  });
});

