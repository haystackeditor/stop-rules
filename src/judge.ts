/**
 * Which service scores the pieces, as one resolved value. Clef, Cloudflare's decision model on
 * Workers AI, is the default. The OpenAI judge asks one model through the Responses API. Plain
 * values, no Node-only imports, so the engine can use them too.
 */

/**
 * The two Clef models Workers AI serves, and the one place they are written. `clef` (27B) is the
 * default. `clef-flash` (9B) costs less but is poorly calibrated for this question: at a bar of
 * 0.5 it caught 2 of the 32 real breaks `clef` caught 22 of (2 October 2026, docs/TUNING.md).
 */
export const CLEF_MODELS = ["clef", "clef-flash"] as const;
export type ClefModel = (typeof CLEF_MODELS)[number];
export const DEFAULT_CLEF_MODEL: ClefModel = "clef";

/** The reasoning effort the OpenAI judge may be asked for. */
export const EFFORTS = ["none", "low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * The OpenAI judge's defaults, and the one place they are written. The model is the one that
 * was measured against the scoring service of the time. The effort is `low` on the owner's
 * ruling: reasoning on, at the cheapest level that has it. docs/TUNING.md has what each effort
 * measured.
 */
export const DEFAULT_OPENAI_MODEL = "gpt-6-luna";
export const DEFAULT_EFFORT: Effort = "low";
/**
 * OpenAI calls one run keeps open at once. Each call carries one piece. Measured on 22
 * September 2026 on a 52 piece diff at effort low: 1 took 90.9 s, 4 took 23.4 s, 8 took 14.9 s.
 */
export const DEFAULT_IN_FLIGHT = 4;
/**
 * The most calls one run may keep open. Every stop-rules process on a machine shares eight
 * slots per judge (slots.ts), so a higher number cannot be used: 16 took 14.9 s on the same
 * diff, the same as 8.
 */
export const MAX_IN_FLIGHT = 8;

export type JudgeKind = "clef" | "openai";

/**
 * How the OpenAI judge is asked. `review`, the default: one call per change, and the model
 * reports each rule the added lines break, with the line quoted. `scores`: one call per piece,
 * and the model gives a probability per rule, which is the form the tool shipped first.
 */
export const FORMS = ["review", "scores"] as const;
export type Form = (typeof FORMS)[number];
export const DEFAULT_FORM: Form = "review";

/** A judge with every value filled in. */
export type Judge =
  | { kind: "clef"; model: ClefModel }
  | { kind: "openai"; model: string; effort: Effort; inFlight: number; form: Form };

/** What a judge is called in a sentence the user reads: "Clef", "Clef Flash", or the model name. */
export function judgeName(judge: Judge | JudgeInfo): string {
  if (judge.kind === "openai") return judge.model;
  return judge.model === "clef-flash" ? "Clef Flash" : "Clef";
}

/**
 * The model string the answer cache is keyed on. Clef is keyed on its Workers AI model name and
 * the OpenAI judge on its kind, model and effort, so answers from the two judges, from the two
 * Clef models, or from two efforts, never mix.
 */
export function cacheModel(judge: Judge): string {
  if (judge.kind === "clef") return `@cf/cloudflare/${judge.model}`;
  const base = `openai:${judge.model}:${judge.effort}`;
  return judge.form === "scores" ? base : `${base}:review`;
}

/** The judge as `check --json` and `score --json` print it. */
export interface JudgeInfo {
  kind: JudgeKind;
  model: string;
  effort?: Effort;
  form?: Form;
}

export function judgeInfo(judge: Judge): JudgeInfo {
  return judge.kind === "clef"
    ? { kind: "clef", model: judge.model }
    : { kind: "openai", model: judge.model, effort: judge.effort, form: judge.form };
}

/**
 * One line for a human: "clef, model clef" or
 * "openai, model gpt-6-luna at effort low, review form".
 */
export function describeJudge(judge: JudgeInfo): string {
  if (judge.effort === undefined) return `${judge.kind}, model ${judge.model}`;
  const form = judge.form === undefined ? "" : `, ${judge.form} form`;
  return `${judge.kind}, model ${judge.model} at effort ${judge.effort}${form}`;
}
