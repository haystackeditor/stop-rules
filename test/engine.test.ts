/** The engine with Clef as the judge: one piece per call, never more than 64 questions in one. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clefEndpoint, MAX_QUESTIONS } from "../src/clef.js";
import { cutFiles } from "../src/cut.js";
import { parseDiff } from "../src/diff.js";
import { runEngine, type CacheLike } from "../src/engine.js";
import type { Rule } from "../src/types.js";
import { answerAll, noSleep, scriptedFetch, type Scripted } from "./fake.js";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " export const one = 1;",
  "+export const two = 2;",
  " export const three = 3;",
  " export const four = 4;",
  "@@ -20,3 +21,4 @@",
  " export const twenty = 20;",
  "+export const extra = 21;",
  " export const twentyOne = 21;",
  " export const twentyTwo = 22;",
  "",
].join("\n");

function rules(count: number): Rule[] {
  return Array.from({ length: count }, (_, i) => ({ id: `r${i}`, text: `Rule number ${i}.` }));
}

function memoryCache(): CacheLike {
  const entries = new Map<string, number>();
  return {
    get: (key) => {
      const noul = entries.get(key);
      return noul === undefined ? undefined : { noul };
    },
    set: (key, noul) => {
      entries.set(key, noul);
    },
  };
}

async function pieces(): Promise<Awaited<ReturnType<typeof cutFiles>>["pieces"]> {
  const parsed = parseDiff(DIFF);
  return (await cutFiles(parsed.files, { cut: "hunks", readSource: null })).pieces;
}

describe("the engine with Clef", () => {
  it("asks one piece per call, with every rule as a question", async () => {
    const cut = await pieces();
    assert.equal(cut.length, 2);
    const script: Scripted[] = [answerAll(0.1, 400), answerAll(0.8, 400)];
    const { fetchImpl, sent } = scriptedFetch(script);
    const result = await runEngine({
      pieces: cut,
      rules: rules(3),
      threshold: 0.6,
      maxCalls: 10,
      judge: { kind: "clef", model: "clef" },
      endpoint: clefEndpoint("0123456789abcdef0123456789abcdef", "clef"),
      apiKey: "token",
      fetchImpl,
      cache: memoryCache(),
      note: () => undefined,
      sleep: noSleep,
      concurrency: 1,
    });
    assert.equal(sent.length, 2);
    for (const request of sent) {
      assert.equal(request.body["model"], "clef");
      assert.deepEqual(Object.keys((request.body["state"] as { pieces: object }).pieces), ["p0"]);
      assert.equal(Object.keys(request.body["questions"] as object).length, 3);
    }
    assert.deepEqual(result.piecesPerCall, [1, 1]);
    assert.equal(result.answered, 6);
    assert.equal(result.pieces.length, 1);
    assert.equal(result.pieces[0]?.rules.length, 3);
  });

  it(`splits a piece's rules so no call carries more than ${MAX_QUESTIONS} questions`, async () => {
    const cut = (await pieces()).slice(0, 1);
    const script: Scripted[] = [answerAll(0.1, 900), answerAll(0.1, 900)];
    const { fetchImpl, sent } = scriptedFetch(script);
    const result = await runEngine({
      pieces: cut,
      rules: rules(70),
      threshold: 0.6,
      maxCalls: 10,
      judge: { kind: "clef", model: "clef" },
      endpoint: clefEndpoint("0123456789abcdef0123456789abcdef", "clef"),
      apiKey: "token",
      fetchImpl,
      cache: memoryCache(),
      note: () => undefined,
      sleep: noSleep,
      concurrency: 1,
    });
    assert.deepEqual(
      sent.map((request) => Object.keys(request.body["questions"] as object).length),
      [64, 6],
    );
    assert.equal(result.answered, 70);
    assert.equal(result.notChecked.length, 0);
  });
});
