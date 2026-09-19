/**
 * The check engine: stage 1 detect, stage 2 localise. Plain inputs, plain outputs, no
 * Node-only imports and no environment reads, so the same code runs in a CLI, a worker
 * or an edge function.
 */

import {
  addedLines,
  chunkRange,
  chunkText,
  halveChunk,
  type Chunk,
} from "./diff.js";
import {
  JevClient,
  holdsBaseline,
  type AskNode,
  type FetchLike,
  type JevQuestion,
  type JevUsage,
} from "./jev.js";
import type { AddedLine, NotChecked, Rule, Violation } from "./types.js";

const MAX_RULES_PER_CALL = 200;
const CACHE_KEY_VERSION = "v1";

/** Minimal cache seam: the caller owns storage and eviction. */
export interface CacheLike {
  get(key: string): number | undefined;
  set(key: string, noul: number): void;
}

export interface EngineInput {
  chunks: readonly Chunk[];
  rules: readonly Rule[];
  threshold: number;
  maxCalls: number;
  model: string;
  endpoint: string;
  apiKey: string;
  fetchImpl: FetchLike;
  cache: CacheLike;
  note: (message: string) => void;
  /** True for a (rule, chunk) pair the caller has already delivered once. */
  skipFinding?: (ruleId: string, chunkText: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  concurrency?: number;
}

export interface EngineResult {
  violations: Violation[];
  notChecked: NotChecked[];
  calls: number;
  cacheHits: number;
  /** Questions that got an answer, from the cache or from Jev. */
  answered: number;
  /** A transport failure that was not just the call budget running out. */
  transportFailed: boolean;
  /** A failure the next run could still succeed at. */
  holdBaseline: boolean;
  usage: JevUsage;
  /** (rule, chunk) pairs whose violations are in this result. */
  findings: { ruleId: string; chunkText: string }[];
}

export function stage1Claim(rule: Rule): string {
  return `The added lines in this diff violate this coding rule: ${rule.text}`;
}

export function stage2Claim(line: AddedLine): string {
  return `Added line ${line.line} is where this diff violates the rule: ${line.text.trim()}`;
}

const encoder = new TextEncoder();

async function sha256Hex(parts: readonly string[]): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    encoder.encode(parts.join("\u0000")),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Deterministic cache key: nothing an LLM produced takes part in it. */
export function cacheKey(model: string, claim: string, state: unknown): Promise<string> {
  return sha256Hex([CACHE_KEY_VERSION, model, claim, JSON.stringify(state)]);
}

interface Stage1Payload {
  chunk: Chunk;
  rules: Rule[];
  byQuestion: Record<string, Rule>;
}

interface Stage2Payload {
  chunk: Chunk;
  rule: Rule;
  byQuestion: Record<string, AddedLine>;
}

interface Stage1Hit {
  chunk: Chunk;
  rule: Rule;
  score: number;
}

function reasonFor(failure: string, message: string): string {
  return failure === "budget" ? "call budget exhausted" : message;
}

function notCheckedFor(chunk: Chunk, reason: string): NotChecked {
  const range = chunkRange(chunk);
  return { file: chunk.file, fromLine: range.from, toLine: range.to, reason };
}

function makeStage1Node(chunk: Chunk, rules: Rule[]): AskNode<Stage1Payload> {
  const questions: Record<string, JevQuestion> = {};
  const byQuestion: Record<string, Rule> = {};
  rules.forEach((rule, index) => {
    const id = `q${index}`;
    questions[id] = { type: "noul", instructions: stage1Claim(rule) };
    byQuestion[id] = rule;
  });
  return {
    payload: { chunk, rules, byQuestion },
    state: { file: chunk.file, diff: chunkText(chunk) },
    questions,
    halve: () => {
      const halves = halveChunk(chunk);
      if (halves === null) return null;
      return [makeStage1Node(halves[0], rules), makeStage1Node(halves[1], rules)];
    },
  };
}

function makeStage2Node(chunk: Chunk, rule: Rule, lines: AddedLine[]): AskNode<Stage2Payload> {
  const questions: Record<string, JevQuestion> = {};
  const byQuestion: Record<string, AddedLine> = {};
  lines.forEach((line, index) => {
    const id = `q${index}`;
    questions[id] = { type: "noul", instructions: stage2Claim(line) };
    byQuestion[id] = line;
  });
  return {
    payload: { chunk, rule, byQuestion },
    state: { file: chunk.file, diff: chunkText(chunk), rule: rule.text },
    questions,
    halve: () => {
      if (lines.length < 2) return null;
      const mid = Math.ceil(lines.length / 2);
      return [
        makeStage2Node(chunk, rule, lines.slice(0, mid)),
        makeStage2Node(chunk, rule, lines.slice(mid)),
      ];
    },
  };
}

/** Lines with no letter or digit (a lone brace, say) are not unique enough to score. */
function localisableLines(chunk: Chunk): AddedLine[] {
  return addedLines(chunk).filter((line) => /[A-Za-z0-9]/.test(line.text));
}

export async function runEngine(input: EngineInput): Promise<EngineResult> {
  const { cache, note, threshold, model } = input;
  const client = new JevClient({
    endpoint: input.endpoint,
    model,
    apiKey: input.apiKey,
    maxCalls: input.maxCalls,
    fetchImpl: input.fetchImpl,
    note,
    ...(input.sleep ? { sleep: input.sleep } : {}),
    ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
  });

  const notChecked: NotChecked[] = [];
  const hits: Stage1Hit[] = [];
  let cacheHits = 0;
  let answered = 0;
  let holdBaseline = false;
  let transportFailed = false;

  // Stage 1: one call per chunk, one claim per rule.
  const stage1Nodes: AskNode<Stage1Payload>[] = [];
  for (const chunk of input.chunks) {
    const chunkState = { file: chunk.file, diff: chunkText(chunk) };
    const uncached: Rule[] = [];
    for (const rule of input.rules) {
      const cached = cache.get(await cacheKey(model, stage1Claim(rule), chunkState));
      if (cached === undefined) {
        uncached.push(rule);
        continue;
      }
      cacheHits += 1;
      answered += 1;
      if (cached >= threshold) hits.push({ chunk, rule, score: cached });
    }
    for (let i = 0; i < uncached.length; i += MAX_RULES_PER_CALL) {
      stage1Nodes.push(makeStage1Node(chunk, uncached.slice(i, i + MAX_RULES_PER_CALL)));
    }
  }

  for (const result of await client.askAll(stage1Nodes)) {
    const { chunk, byQuestion } = result.node.payload;
    if (!result.outcome.ok) {
      const failure = result.outcome.failure;
      if (holdsBaseline(failure)) holdBaseline = true;
      if (failure !== "budget") transportFailed = true;
      notChecked.push(notCheckedFor(chunk, reasonFor(failure, result.outcome.message)));
      continue;
    }
    for (const [id, rule] of Object.entries(byQuestion)) {
      const noul = result.outcome.answers[id];
      if (noul === undefined) {
        // A missing answer is an error for that question, never a zero.
        note(`Jev returned no answer for rule ${rule.id} on ${chunk.file}`);
        notChecked.push(notCheckedFor(chunk, `Jev returned no answer for rule ${rule.id}`));
        continue;
      }
      answered += 1;
      cache.set(await cacheKey(model, stage1Claim(rule), result.node.state), noul);
      if (noul >= threshold) hits.push({ chunk, rule, score: noul });
    }
  }

  const fresh =
    input.skipFinding === undefined
      ? hits
      : hits.filter((hit) => !input.skipFinding?.(hit.rule.id, chunkText(hit.chunk)));

  // Stage 2: one call per flagged (chunk, rule), one claim per added line.
  const stage2Nodes: AskNode<Stage2Payload>[] = [];
  const scores = new Map<string, Map<number, number>>();
  const hitKey = (rule: Rule, chunk: Chunk): string => `${rule.id}\u0000${chunkText(chunk)}`;

  for (const hit of fresh) {
    const lineState = { file: hit.chunk.file, diff: chunkText(hit.chunk), rule: hit.rule.text };
    const perLine = new Map<number, number>();
    scores.set(hitKey(hit.rule, hit.chunk), perLine);
    const uncached: AddedLine[] = [];
    for (const line of localisableLines(hit.chunk)) {
      const cached = cache.get(await cacheKey(model, stage2Claim(line), lineState));
      if (cached === undefined) {
        uncached.push(line);
        continue;
      }
      cacheHits += 1;
      perLine.set(line.line, cached);
    }
    if (uncached.length > 0) stage2Nodes.push(makeStage2Node(hit.chunk, hit.rule, uncached));
  }

  for (const result of await client.askAll(stage2Nodes)) {
    const { chunk, rule, byQuestion } = result.node.payload;
    const target = scores.get(hitKey(rule, chunk));
    if (!result.outcome.ok) {
      const failure = result.outcome.failure;
      if (holdsBaseline(failure)) holdBaseline = true;
      // A failed localisation never drops a violation; it only makes the line approximate.
      note(
        `could not localise rule ${rule.id} in ${chunk.file}: ${reasonFor(failure, result.outcome.message)}`,
      );
      continue;
    }
    for (const [id, line] of Object.entries(byQuestion)) {
      const noul = result.outcome.answers[id];
      if (noul === undefined) {
        note(`Jev returned no answer for line ${line.line} of ${chunk.file}`);
        continue;
      }
      cache.set(await cacheKey(model, stage2Claim(line), result.node.state), noul);
      target?.set(line.line, noul);
    }
  }

  const violations: Violation[] = [];
  const findings: { ruleId: string; chunkText: string }[] = [];
  for (const hit of fresh) {
    const chunkLines = addedLines(hit.chunk);
    const perLine = scores.get(hitKey(hit.rule, hit.chunk)) ?? new Map<number, number>();
    const byScore = [...perLine.entries()].sort((a, b) => b[1] - a[1]);
    const above = byScore.filter(([, score]) => score >= threshold).slice(0, 3);
    const textOf = (lineNo: number): string =>
      (chunkLines.find((line) => line.line === lineNo)?.text ?? "").trim();

    const base = {
      file: hit.chunk.file,
      ruleId: hit.rule.id,
      rule: hit.rule.text,
      confidence: hit.score,
    };
    findings.push({ ruleId: hit.rule.id, chunkText: chunkText(hit.chunk) });

    if (above.length > 0) {
      for (const [lineNo] of above) {
        violations.push({ ...base, line: lineNo, approximate: false, lineText: textOf(lineNo) });
      }
      continue;
    }
    const best = byScore[0];
    if (best !== undefined) {
      violations.push({ ...base, line: best[0], approximate: true, lineText: textOf(best[0]) });
      continue;
    }
    const firstAdded = chunkLines[0];
    violations.push({
      ...base,
      line: firstAdded?.line ?? chunkRange(hit.chunk).from,
      approximate: true,
      lineText: (firstAdded?.text ?? "").trim(),
    });
  }

  violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  const deduped: Violation[] = [];
  const seen = new Set<string>();
  for (const violation of violations) {
    const id = `${violation.file}\u0000${violation.ruleId}\u0000${violation.line}`;
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(violation);
  }
  notChecked.sort((a, b) =>
    a.file === b.file ? a.fromLine - b.fromLine : a.file < b.file ? -1 : 1,
  );

  return {
    violations: deduped,
    notChecked,
    calls: client.calls,
    cacheHits,
    answered,
    transportFailed,
    holdBaseline,
    usage: client.usage,
    findings,
  };
}
