/**
 * The OpenAI judge's review form, the default: one Responses API call per change, every piece
 * of the change in it, grouped by file, and the model reports every rule the added lines break
 * as `{"findings": [{"ruleId", "line", "reason", "confidence"}]}` under a strict JSON schema.
 * `line` is the offending added line quoted verbatim, and a rule that is not broken is not
 * reported at all.
 *
 * The engine wants a score per (piece, rule), so a verdict is mapped to one: sure 1.0, likely
 * 0.75, unsure 0.5, not reported 0. That is a verdict written as a number, not a probability,
 * and it is why the bar, the report and the hook protocols work unchanged.
 *
 * Plain logic, no Node-only imports.
 */

import { MAX_OUTPUT_TOKENS, readOutputJson, rulesBlock, type OpenAiRule, type ResponsesBody } from "./openai.js";
import type { Effort } from "./judge.js";
import type { JevView } from "./types.js";

/** The system instruction, word for word as it was measured. */
export const REVIEW_INSTRUCTION =
  "You are reviewing a code change against a team's rules. Report every rule that the added lines in the diff break. For each finding give the ruleId, the exact added line quoted verbatim from the diff, a one-sentence reason, and your confidence: sure, likely or unsure. Report nothing for rules that are not broken.";

export const VERDICTS = ["sure", "likely", "unsure"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** The number a verdict stands for. A rule that is not reported scores 0. */
export const VERDICT_SCORE: Record<Verdict, number> = { sure: 1, likely: 0.75, unsure: 0.5 };

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ruleId: { type: "string" },
          line: { type: "string" },
          reason: { type: "string" },
          confidence: { type: "string", enum: [...VERDICTS] },
        },
        required: ["ruleId", "line", "reason", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;

export interface ReviewFinding {
  ruleId: string;
  line: string;
  reason: string;
  confidence: Verdict;
}

/** What a finding says beside its score, for the report. */
export interface FindingDetail {
  verdict: Verdict;
  /** The added line, as the model quoted it. */
  line: string;
  /** One sentence from the model on why the line breaks the rule. */
  reason: string;
}

/** A finding the tool refused, and why. It is reported, and it never fails the run. */
export interface RejectedFinding {
  ruleId: string;
  line: string;
  why: string;
}

/**
 * Reads the findings out of a completed answer. Only the shape is checked here. Whether each
 * finding names a real rule and quotes a real added line is the engine's to judge, one finding
 * at a time, because one bad finding must not throw the others away.
 */
export function readReview(body: ResponsesBody): ReviewFinding[] | string {
  const read = readOutputJson(body);
  if (typeof read === "string") return read;
  const verdict = read.json;
  if (typeof verdict !== "object" || verdict === null || Array.isArray(verdict)) {
    return "the answer is not a JSON object";
  }
  const keys = Object.keys(verdict);
  if (keys.length !== 1 || keys[0] !== "findings") {
    return `the answer has the keys ${keys.join(", ")}, not just findings`;
  }
  const list = (verdict as { findings: unknown }).findings;
  if (!Array.isArray(list)) return "the answer's findings are not a list";
  const findings: ReviewFinding[] = [];
  for (const entry of list as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return "the answer has a finding that is not an object";
    }
    const row = entry as Record<string, unknown>;
    const extra = Object.keys(row).filter((key) => !["ruleId", "line", "reason", "confidence"].includes(key));
    if (extra.length > 0) return `the answer has a finding with extra fields ${extra.join(", ")}`;
    const { ruleId, line, reason, confidence } = row;
    if (typeof ruleId !== "string" || typeof line !== "string" || typeof reason !== "string") {
      return "the answer has a finding whose ruleId, line or reason is not a string";
    }
    if (!(VERDICTS as readonly unknown[]).includes(confidence)) {
      return `the answer gives the confidence ${JSON.stringify(confidence)}, not sure, likely or unsure`;
    }
    findings.push({ ruleId, line, reason, confidence: confidence as Verdict });
  }
  return findings;
}

/** A diff line that belongs to the git header rather than to a hunk. */
function isHeaderLine(line: string): boolean {
  return !line.startsWith("@@") && !line.startsWith(" ") && !line.startsWith("+") && !line.startsWith("-") && !line.startsWith("\\");
}

/**
 * One file's pieces as one diff: the first piece's git header, then every piece's hunks in
 * line order. Each piece keeps the 25 lines around it that it has in the probability form.
 */
export function fileDiff(views: readonly JevView[]): string {
  const blocks: string[] = [];
  views.forEach((view, index) => {
    const lines = view.diff.replace(/\n$/, "").split("\n");
    const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
    const header = firstHunk < 0 ? lines.filter(isHeaderLine) : lines.slice(0, firstHunk);
    const body = firstHunk < 0 ? lines.filter((line) => !isHeaderLine(line)) : lines.slice(firstHunk);
    blocks.push([...(index === 0 ? header : []), ...body].join("\n"));
  });
  let text = `${blocks.join("\n")}\n`;
  for (const view of views) {
    for (const unit of view.function ?? []) {
      text += `\nThe whole function ${unit.name} after the change, lines ${unit.fromLine}-${unit.toLine}:\n${unit.text}\n`;
    }
  }
  return text;
}

/**
 * The user message, in the measured order: each file's diff under its own "File:" line, one
 * file after another, then the rules.
 */
export function reviewInput(files: readonly { file: string; views: readonly JevView[] }[], rules: readonly OpenAiRule[]): string {
  const blocks = files.map((entry) => `File: ${entry.file}\n\nDiff:\n${fileDiff(entry.views)}`);
  return `${blocks.join("\n")}\n${rulesBlock(rules)}`;
}

export function reviewBody(model: string, effort: Effort, input: string): string {
  return JSON.stringify({
    model,
    reasoning: { effort },
    instructions: REVIEW_INSTRUCTION,
    input,
    text: {
      format: { type: "json_schema", name: "review", strict: true, schema: REVIEW_SCHEMA },
    },
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
  });
}

/** A quoted line as compared: whitespace trimmed and one leading "+" dropped. */
export function normaliseQuote(text: string): string {
  const trimmed = text.trim();
  return (trimmed.startsWith("+") ? trimmed.slice(1) : trimmed).trim();
}

/** The added lines of a piece's own diff, each without its "+" and trimmed. */
export function addedLines(pieceDiff: string): string[] {
  return pieceDiff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1).trim())
    .filter((line) => line.length > 0);
}

/**
 * Whether a quote is in a piece: every line of it, trimmed and without a leading "+", is an
 * added line of that piece or a part of one.
 */
export function quoteInPiece(quote: string, added: readonly string[]): boolean {
  const parts = quote
    .split("\n")
    .map(normaliseQuote)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return false;
  return parts.every((part) => added.some((line) => line === part || line.includes(part)));
}
