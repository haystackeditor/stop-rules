/** The team server's Clef route: what it forwards to Workers AI, and what it refuses. */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { handle } from "../src/server/handler.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ENV = {
  STOP_RULES_CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  STOP_RULES_CLOUDFLARE_API_TOKEN: "server-cf-token",
  STOP_RULES_TOKEN: "team-token",
};

interface Forwarded {
  url: string;
  authorization: string | null;
  body: unknown;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stands in for Workers AI and records what reached it. */
function upstream(status = 200): Forwarded[] {
  const seen: Forwarded[] = [];
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)),
    });
    return Promise.resolve(
      new Response(JSON.stringify({ success: status === 200, result: { answers: {}, usage: { input_tokens: 1 } } }), {
        status,
        headers: { "content-type": "application/json", "retry-after": "3" },
      }),
    );
  };
  return seen;
}

function ask(body: unknown, env: Record<string, string> = ENV, token = "team-token"): Promise<Response> {
  return handle(
    new Request("https://rules.example.com/v1/clef", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

const QUESTIONS = { q0: { type: "noul", instructions: "claim" } };

describe("the team server's Clef route", () => {
  it("forwards the question set to the account's Clef with the server's token", async () => {
    const seen = upstream();
    const response = await ask({ model: "clef-flash", state: { pieces: {} }, questions: QUESTIONS, extra: "dropped" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("retry-after"), "3");
    assert.deepEqual(seen, [
      {
        url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/cloudflare/clef-flash`,
        authorization: "Bearer server-cf-token",
        body: { model: "clef-flash", state: { pieces: {} }, questions: QUESTIONS },
      },
    ]);
  });

  it("relays Workers AI's status untouched", async () => {
    upstream(429);
    const response = await ask({ model: "clef", state: {}, questions: QUESTIONS });
    assert.equal(response.status, 429);
  });

  it("refuses a wrong team token, a bad model and more than 64 questions", async () => {
    const seen = upstream();
    assert.equal((await ask({ model: "clef", state: {}, questions: QUESTIONS }, ENV, "wrong")).status, 401);
    assert.equal((await ask({ model: "gpt-6-luna", state: {}, questions: QUESTIONS })).status, 400);
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q${i}`, { type: "noul", instructions: "c" }]));
    const response = await ask({ model: "clef", state: {}, questions: many });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { message: string }).message, /at most 64/);
    assert.equal(seen.length, 0);
  });

  it("answers only with the model it is pinned to", async () => {
    const seen = upstream();
    const pinned = { ...ENV, STOP_RULES_CLEF_MODEL: "clef" };
    const refused = await ask({ model: "clef-flash", state: {}, questions: QUESTIONS }, pinned);
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { message: string }).message, /answers with clef only/);
    assert.equal((await ask({ model: "clef", state: {}, questions: QUESTIONS }, pinned)).status, 200);
    assert.equal(seen.length, 1);
    const broken = await ask({ model: "clef", state: {}, questions: QUESTIONS }, { ...ENV, STOP_RULES_CLEF_MODEL: "big" });
    assert.equal(broken.status, 503);
  });

  it("names what a fresh deploy is missing, never the values", async () => {
    const response = await ask({ model: "clef", state: {}, questions: QUESTIONS }, { STOP_RULES_TOKEN: "team-token" });
    assert.equal(response.status, 503);
    const body = (await response.json()) as { missing: string[] };
    assert.deepEqual(body.missing, ["STOP_RULES_CLOUDFLARE_ACCOUNT_ID", "STOP_RULES_CLOUDFLARE_API_TOKEN"]);
    const health = await handle(new Request("https://rules.example.com/health"), ENV);
    assert.deepEqual(((await health.json()) as { judges: unknown }).judges, { clef: true, openai: false });
  });
});
