/** The Clef transport: Workers AI's envelope, its errors, and the check that Clef read the whole state. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTH_REJECTED,
  BILLING_EXHAUSTED,
  ClefClient,
  clefEndpoint,
  MAX_QUESTIONS,
  MOST_STATE_BYTES,
  STATE_TOKENS,
  type AskNode,
  type ClefQuestion,
  type FetchLike,
} from "../src/clef.js";
import { answerAll, noSleep, scriptedFetch, workersAi, type Scripted } from "./fake.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-token-for-tests-only";

function client(fetchImpl: FetchLike, maxCalls = 20): { client: ClefClient; notes: string[] } {
  const notes: string[] = [];
  return {
    client: new ClefClient({
      endpoint: clefEndpoint(ACCOUNT, "clef"),
      model: "clef",
      apiKey: TOKEN,
      maxCalls,
      fetchImpl,
      note: (message) => notes.push(message),
      sleep: noSleep,
    }),
    notes,
  };
}

function questions(count: number): Record<string, ClefQuestion> {
  const out: Record<string, ClefQuestion> = {};
  for (let i = 0; i < count; i += 1) out[`q${i}`] = { type: "noul", instructions: `claim ${i}` };
  return out;
}

const STATE = { pieces: { p0: { file: "a.ts", diff: "@@ -0,0 +1 @@\n+export const answer = 42;" } } };

describe("Clef transport", () => {
  it("posts to the account's Workers AI URL and unwraps the answer", async () => {
    const { fetchImpl, sent } = scriptedFetch([workersAi({ q0: 0.2836 }, 193)]);
    const { client: clef } = client(fetchImpl);
    const outcome = await clef.send(STATE, questions(1));
    assert.deepEqual(outcome, { ok: true, answers: { q0: 0.2836 }, usage: { inputTokens: 193, outputTokens: 0 } });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/cloudflare/clef`);
    assert.equal(sent[0]?.headers["Authorization"], `Bearer ${TOKEN}`);
    assert.deepEqual(sent[0]?.body, { model: "clef", state: STATE, questions: questions(1) });
    assert.deepEqual(clef.usage, { inputTokens: 193, outputTokens: 0 });
  });

  it("does not read an answer that is not wrapped in result", async () => {
    const bare: Scripted = { status: 200, body: { answers: { q0: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 10 } } };
    const { fetchImpl, sent } = scriptedFetch([bare, bare, bare]);
    const outcome = await client(fetchImpl).client.send(STATE, questions(1));
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.failure, "server");
    assert.equal(sent.length, 3);
  });

  it("never passes an answer without a token count", async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 200, body: { success: true, result: { answers: { q0: { type: "noul", noul: 0.1 } } } } },
    ]);
    const outcome = await client(fetchImpl).client.send(STATE, questions(1));
    assert.equal(!outcome.ok && outcome.failure, "server");
    assert.match(!outcome.ok ? outcome.message : "", /input_tokens/);
  });

  it("reads a 401 as a rejected token or account, and does not retry it", async () => {
    const { fetchImpl, sent } = scriptedFetch([
      { status: 401, body: { result: null, success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [] } },
    ]);
    const outcome = await client(fetchImpl).client.send(STATE, questions(1));
    assert.deepEqual(outcome, { ok: false, failure: "auth", message: AUTH_REJECTED });
    assert.equal(sent.length, 1);
  });

  it("slows down on a 429 and tries again after Retry-After", async () => {
    const { fetchImpl, sent } = scriptedFetch([
      { status: 429, body: { errors: [{ code: 3040, message: "Capacity temporarily exceeded" }] }, headers: { "retry-after": "2" } },
      workersAi({ q0: 0.9 }, 150),
    ]);
    const waits: number[] = [];
    const clef = new ClefClient({
      endpoint: clefEndpoint(ACCOUNT, "clef"),
      model: "clef",
      apiKey: TOKEN,
      maxCalls: 5,
      fetchImpl,
      concurrency: 4,
      note: () => undefined,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    const outcome = await clef.send(STATE, questions(1));
    assert.equal(outcome.ok, true);
    assert.deepEqual(waits, [2000]);
    assert.equal(clef.inFlightLimit, 2);
    assert.equal(sent.length, 2);
  });

  it("gives up as rate limited after three 429s", async () => {
    const limited: Scripted = { status: 429, body: { errors: [] } };
    const { fetchImpl } = scriptedFetch([limited, limited, limited]);
    const outcome = await client(fetchImpl).client.send(STATE, questions(1));
    assert.equal(!outcome.ok && outcome.failure, "rate_limit");
  });

  it("retries a 5xx and then reports it", async () => {
    const down: Scripted = { status: 503, body: { errors: [] } };
    const { fetchImpl, sent } = scriptedFetch([down, down, down]);
    const outcome = await client(fetchImpl).client.send(STATE, questions(1));
    assert.deepEqual(outcome, { ok: false, failure: "server", message: "Clef returned 503" });
    assert.equal(sent.length, 3);
  });

  it("reports a 4xx as the client's mistake, with the token taken out of the snippet", async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 422, body: { errors: [{ code: 5012, message: `Request body failed validation for ${TOKEN}` }] } },
    ]);
    const outcome = await client(fetchImpl).client.send(STATE, questions(1));
    assert.equal(!outcome.ok && outcome.failure, "client");
    const message = !outcome.ok ? outcome.message : "";
    assert.match(message, /^Clef returned 422: .*5012/);
    assert.equal(message.includes(TOKEN), false);
    assert.match(message, /\[redacted\]/);
  });

  it("reads a 402, or Workers AI's daily allowance code, as billing", async () => {
    const paid = scriptedFetch([{ status: 402, body: { errors: [] } }]);
    assert.deepEqual(await client(paid.fetchImpl).client.send(STATE, questions(1)), {
      ok: false,
      failure: "billing",
      message: BILLING_EXHAUSTED,
    });
    const allowance = scriptedFetch([{ status: 429, body: { errors: [{ code: 4006, message: "daily free allocation used up" }] } }]);
    const outcome = await client(allowance.fetchImpl).client.send(STATE, questions(1));
    assert.equal(!outcome.ok && outcome.failure, "billing");
    assert.equal(allowance.sent.length, 1);
  });

  it(`refuses more than ${MAX_QUESTIONS} questions without sending anything`, async () => {
    const { fetchImpl, sent } = scriptedFetch([]);
    const outcome = await client(fetchImpl).client.send(STATE, questions(MAX_QUESTIONS + 1));
    assert.equal(!outcome.ok && outcome.failure, "client");
    assert.match(!outcome.ok ? outcome.message : "", /at most 64/);
    assert.equal(sent.length, 0);
  });

  it("sends exactly 64 questions", async () => {
    const { fetchImpl, sent } = scriptedFetch([answerAll(0.1, 900)]);
    const outcome = await client(fetchImpl).client.send(STATE, questions(MAX_QUESTIONS));
    assert.equal(outcome.ok, true);
    assert.equal(Object.keys(sent[0]?.body["questions"] as object).length, 64);
  });
});

describe("the check that Clef read the whole state", () => {
  it("needs no measurement when the whole count is under the cut", async () => {
    const { fetchImpl, sent } = scriptedFetch([workersAi({ q0: 0.4 }, STATE_TOKENS - 1)]);
    const outcome = await client(fetchImpl).client.send(STATE, questions(1));
    assert.equal(outcome.ok, true);
    assert.equal(sent.length, 1);
  });

  it("keeps an answer whose state, net of the questions, is under the cut", async () => {
    // 2,600 in all, of which the questions alone cost 600 - 1: 2,001 tokens of state.
    const { fetchImpl, sent } = scriptedFetch([answerAll(0.7, 2600), answerAll(0.01, 600)]);
    const outcome = await client(fetchImpl).client.send(STATE, questions(6));
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && outcome.answers["q0"], 0.7);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1]?.body["state"], {});
    assert.deepEqual(sent[1]?.body["questions"], questions(6));
  });

  it("throws away an answer on a cut state and calls it too large", async () => {
    // 600 - 1 for the questions, 2,048 for the state: exactly what a cut state counts.
    const { fetchImpl } = scriptedFetch([answerAll(0.9, 599 + STATE_TOKENS), answerAll(0.01, 600)]);
    const outcome = await client(fetchImpl).client.send(STATE, questions(6));
    assert.deepEqual(outcome, {
      ok: false,
      failure: "too_large",
      message: `Clef read only the first ${STATE_TOKENS} tokens of the state`,
    });
  });

  it("measures each set of questions once per run", async () => {
    const { fetchImpl, sent } = scriptedFetch([answerAll(0.5, 2500), answerAll(0.01, 600), answerAll(0.5, 2400)]);
    const { client: clef } = client(fetchImpl);
    assert.equal((await clef.send(STATE, questions(6))).ok, true);
    assert.equal((await clef.send(STATE, questions(6))).ok, true);
    assert.equal(sent.length, 3);
    assert.equal(clef.calls, 3);
  });
});

describe("askAll halving", () => {
  interface Payload {
    lines: number[];
  }

  /** A node over some lines; it halves until it holds one line. */
  function node(lines: number[], padding = 0): AskNode<Payload> {
    return {
      payload: { lines },
      state: { pieces: { p0: { file: "a.ts", diff: lines.join("\n") + "x".repeat(padding) } } },
      questions: questions(2),
      halve: () => {
        if (lines.length < 2) return null;
        const mid = Math.ceil(lines.length / 2);
        return [node(lines.slice(0, mid)), node(lines.slice(mid))];
      },
    };
  }

  /** Cut when a request carries more than `fit` lines; the question set costs 300 tokens. */
  function cutPast(fit: number): Scripted {
    return (request) => {
      const state = request.body["state"] as { pieces?: { p0?: { diff?: string } } };
      const diff = state.pieces?.p0?.diff;
      const ids = Object.keys(request.body["questions"] as object);
      const answers = Object.fromEntries(ids.map((id) => [id, 0.3]));
      if (diff === undefined) return workersAi(answers, 301);
      const count = diff.split("\n").length;
      return workersAi(answers, 300 + (count > fit ? STATE_TOKENS : 1000 + count));
    };
  }

  it("halves a node Clef read only part of, and answers with the halves", async () => {
    const script: Scripted[] = Array.from({ length: 12 }, () => cutPast(2));
    const { fetchImpl, sent } = scriptedFetch(script);
    const { client: clef, notes } = client(fetchImpl);
    const results = await clef.askAll([node([1, 2, 3, 4])]);
    assert.deepEqual(
      results.map((result) => result.node.payload.lines).sort(),
      [
        [1, 2],
        [3, 4],
      ],
    );
    assert.ok(results.every((result) => result.outcome.ok));
    // The whole node, one measurement of the questions, then the two halves.
    assert.equal(sent.length, 4);
    assert.equal(notes.filter((note) => note.includes("asking again in two halves")).length, 1);
  });

  it("fails a piece that is still too large at one line, and never answers on it", async () => {
    const script: Scripted[] = Array.from({ length: 12 }, () => cutPast(0));
    const { fetchImpl } = scriptedFetch(script);
    const results = await client(fetchImpl).client.askAll([node([1])]);
    assert.equal(results.length, 1);
    const outcome = results[0]?.outcome;
    assert.equal(outcome?.ok, false);
    assert.equal(outcome !== undefined && !outcome.ok && outcome.failure, "client");
    assert.match(outcome !== undefined && !outcome.ok ? outcome.message : "", /larger than Clef reads/);
  });

  it("halves a state plainly too big before sending it at all", async () => {
    const script: Scripted[] = Array.from({ length: 4 }, () => cutPast(10));
    const { fetchImpl, sent } = scriptedFetch(script);
    const big = node([1, 2], MOST_STATE_BYTES);
    const results = await client(fetchImpl).client.askAll([big]);
    assert.deepEqual(results.map((result) => result.node.payload.lines).sort(), [[1], [2]]);
    // Only the two halves went out.
    assert.equal(sent.length, 2);
  });
});
