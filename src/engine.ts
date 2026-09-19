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
  isLongLineMarker,
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
import type { AddedLine, NotChecked, Rule, Violation, ViolationLine } from "./types.js";

const MAX_LINES_PER_VIOLATION = 3;

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
  /**
   * Set when nothing the agent can do would help: the credential was rejected, or the Jev
   * account has no credits. The caller reports it to the human and keeps the baseline.
   */
  blocked: "auth" | "billing" | null;
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

/** One report entry under construction: a (file, rule) pair and its candidate lines. */
interface Entry {
  file: string;
  ruleId: string;
  rule: string;
  confidence: number;
  fromLine: number;
  toLine: number;
  /** Plain reasons, one per chunk that could not be narrowed to a line. */
  unlocalised: string[];
  candidates: Map<number, { text: string; score: number }>;
}

/** The reason an entry names no line, or null when it names at least one. */
function unlocalisedFor(entry: Entry): string | null {
  if (entry.candidates.size > 0) return null;
  const first = entry.unlocalised[0];
  if (first === undefined) {
    throw new Error(`internal error: ${entry.file} has neither a line nor a reason for having none`);
  }
  return first;
}

function entryKey(file: string, ruleId: string): string {
  return `${file}\u0000${ruleId}`;
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

/**
 * Lines with no letter or digit (a lone brace, say) are not unique enough to score, and a
 * line whose payload was left out as data has no text to point at.
 */
function localisableLines(chunk: Chunk): AddedLine[] {
  return addedLines(chunk).filter(
    (line) => /[A-Za-z0-9]/.test(line.text) && !isLongLineMarker(line.text),
  );
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
  let blocked: "auth" | "billing" | null = null;

  const noteFailure = (failure: string): void => {
    if (blocked !== null) return;
    if (failure === "auth") blocked = "auth";
    else if (failure === "billing") blocked = "billing";
  };

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
      noteFailure(failure);
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
  const localiseFailures = new Map<string, string>();
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
      noteFailure(failure);
      // A failed localisation never drops the violation and never guesses a line: the
      // finding says the call failed and why.
      const why = `the question about which line failed: ${reasonFor(failure, result.outcome.message)}`;
      note(`could not localise rule ${rule.id} in ${chunk.file}: ${why}`);
      localiseFailures.set(hitKey(rule, chunk), why);
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

  // One entry per (file, rule), with its localised lines grouped under it. Two chunks of
  // the same file that flag the same rule are one finding for the reader.
  const entries = new Map<string, Entry>();
  const findings: { ruleId: string; chunkText: string }[] = [];

  for (const hit of fresh) {
    const key2 = hitKey(hit.rule, hit.chunk);
    const perLine = scores.get(key2);
    if (perLine === undefined) {
      // Set for every hit a few lines above. Never silently carry on with an empty score
      // table, because that would look like "no line matched".
      throw new Error(`internal error: no line scores were recorded for ${hit.chunk.file}`);
    }
    const textByLine = new Map(addedLines(hit.chunk).map((line) => [line.line, line.text.trim()]));
    const byScore = [...perLine.entries()].sort((a, b) => b[1] - a[1]);
    const above = byScore
      .filter(([, score]) => score >= threshold)
      .slice(0, MAX_LINES_PER_VIOLATION);
    findings.push({ ruleId: hit.rule.id, chunkText: chunkText(hit.chunk) });
    const range = chunkRange(hit.chunk);

    // Why this chunk names no line, when it names none. Never a guessed line.
    let unlocalised: string | null = null;
    if (above.length === 0) {
      const failed = localiseFailures.get(key2);
      if (failed !== undefined) unlocalised = failed;
      else if (byScore.length > 0) {
        unlocalised = `no added line reached the ${threshold} cutoff`;
      } else if (localisableLines(hit.chunk).length === 0) {
        unlocalised = "no added line in this block has text to point at";
      } else {
        unlocalised = "no line scores came back for this block";
      }
    }

    const key = entryKey(hit.chunk.file, hit.rule.id);
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = {
        file: hit.chunk.file,
        ruleId: hit.rule.id,
        rule: hit.rule.text,
        confidence: hit.score,
        fromLine: range.from,
        toLine: range.to,
        unlocalised: [],
        candidates: new Map(),
      };
      entries.set(key, entry);
    }
    entry.confidence = Math.max(entry.confidence, hit.score);
    entry.fromLine = Math.min(entry.fromLine, range.from);
    entry.toLine = Math.max(entry.toLine, range.to);
    if (unlocalised !== null) entry.unlocalised.push(unlocalised);
    for (const [lineNo, score] of above) {
      const text = textByLine.get(lineNo);
      if (text === undefined) {
        throw new Error(`internal error: line ${lineNo} is not an added line of ${hit.chunk.file}`);
      }
      const existing = entry.candidates.get(lineNo);
      if (existing === undefined || existing.score < score) {
        entry.candidates.set(lineNo, { text, score });
      }
    }
  }

  const violations: Violation[] = [...entries.values()].map((entry) => ({
    file: entry.file,
    lines: [...entry.candidates.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, MAX_LINES_PER_VIOLATION)
      .map(([line, value]): ViolationLine => ({ line, text: value.text }))
      .sort((a, b) => a.line - b.line),
    fromLine: entry.fromLine,
    toLine: entry.toLine,
    // One line named is enough for the entry; the reason is only reported when none is.
    unlocalised: unlocalisedFor(entry),
    ruleId: entry.ruleId,
    rule: entry.rule,
    confidence: entry.confidence,
  }));

  const firstLine = (violation: Violation): number => {
    const first = violation.lines[0];
    return first === undefined ? violation.fromLine : first.line;
  };
  violations.sort((a, b) =>
    a.file === b.file ? firstLine(a) - firstLine(b) : a.file < b.file ? -1 : 1,
  );
  // An entry with no line range is about the whole file, so it comes first for that file.
  const fromLineOf = (entry: NotChecked): number => (entry.fromLine === undefined ? 0 : entry.fromLine);
  notChecked.sort((a, b) =>
    a.file === b.file ? fromLineOf(a) - fromLineOf(b) : a.file < b.file ? -1 : 1,
  );

  return {
    violations,
    notChecked,
    calls: client.calls,
    cacheHits,
    answered,
    transportFailed,
    holdBaseline,
    blocked,
    usage: client.usage,
    findings,
  };
}
