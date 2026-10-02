/** Which judge a run uses: Clef by default, its two models, and no alias for the removed one. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cacheModel, judgeName } from "../src/judge.js";
import { chooseJudge, parseJudge } from "../src/settings.js";

describe("judge settings", () => {
  it("defaults to Clef, model clef", () => {
    assert.deepEqual(chooseJudge(undefined, {}), { ok: true, choice: { kind: "clef", model: "clef" } });
  });

  it("takes clef-flash from the file, and a flag beats the file", () => {
    assert.deepEqual(chooseJudge({ kind: "clef", model: "clef-flash" }, {}), {
      ok: true,
      choice: { kind: "clef", model: "clef-flash" },
    });
    assert.deepEqual(chooseJudge({ kind: "clef", model: "clef-flash" }, { model: "clef" }), {
      ok: true,
      choice: { kind: "clef", model: "clef" },
    });
  });

  it("refuses a model Clef does not have, and an effort", () => {
    const model = chooseJudge(undefined, { model: "gpt-6-luna" });
    assert.equal(model.ok, false);
    assert.match(!model.ok ? model.reason : "", /clef or clef-flash/);
    const effort = chooseJudge(undefined, { effort: "low" });
    assert.equal(effort.ok, false);
    assert.match(!effort.ok ? effort.reason : "", /--effort is for the openai judge/);
  });

  it("reads {kind: clef} with or without a model", () => {
    assert.deepEqual(parseJudge("f", { kind: "clef" }), { ok: true, judge: { kind: "clef" } });
    assert.deepEqual(parseJudge("f", { kind: "clef", model: "clef-flash" }), {
      ok: true,
      judge: { kind: "clef", model: "clef-flash" },
    });
  });

  it("refuses the removed judge's kind, with no alias kept, a wrong model and an effort", () => {
    const old = parseJudge("f", { kind: "jev" });
    assert.equal(old.ok, false);
    assert.match(!old.ok ? old.reason : "", /must be "clef" or "openai"/);
    const model = parseJudge("f", { kind: "clef", model: "llama" });
    assert.match(!model.ok ? model.reason : "", /"clef" or "clef-flash"/);
    const effort = parseJudge("f", { kind: "clef", effort: "low" });
    assert.match(!effort.ok ? effort.reason : "", /does not take/);
  });

  it("keys the cache on the Workers AI model, so the two Clef models never mix", () => {
    assert.equal(cacheModel({ kind: "clef", model: "clef" }), "@cf/cloudflare/clef");
    assert.equal(cacheModel({ kind: "clef", model: "clef-flash" }), "@cf/cloudflare/clef-flash");
    assert.equal(judgeName({ kind: "clef", model: "clef" }), "Clef");
    assert.equal(judgeName({ kind: "clef", model: "clef-flash" }), "Clef Flash");
  });
});
