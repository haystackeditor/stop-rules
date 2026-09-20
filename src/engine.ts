/**
 * The check engine. Stage 1 asks, for every piece and rule, whether the added lines break
 * the rule. Up to four pieces ride in one call. Plain inputs, plain outputs, no Node-only
 * imports and no environment reads, so the same code runs in a CLI, a worker or an edge
 * function. Parsing happens above this file; here a piece is just text.
 */

import { chunkText, halvePiece, utf8Bytes, type Piece } from "./diff.js";
import {
  JevClient,
  holdsBaseline,
  type AskNode,
  type FetchLike,
  type JevQuestion,
  type JevUsage,
  type SlotGate,
} from "./jev.js";
import type { BrokenRule, NotChecked, PieceFinding, PieceScore, Rule } from "./types.js";

/**
 * The one cutoff. Measured on 240 real agent written changes: whole functions as pieces
 * score higher than big chunks, so 0.6 on pieces matches 0.5 on chunks.
 */
export const DEFAULT_THRESHOLD = 0.6;

/** The one ceiling on Jev requests in one run. Raise it with `maxCalls` or `--max-calls`. */
export const DEFAULT_MAX_CALLS = 60;

/** Measured: four pieces per call moved scores by 0.03 on average, eight was worse. */
export const PIECES_PER_CALL = 4;
/** And a call is bounded by its body size, whatever the piece count. */
export const PACK_MAX_BYTES = 60_000;

const MAX_RULES_PER_CALL = 200;
const CACHE_KEY_VERSION = "v1";
/**
 * The key a piece has when it is alone in a call. Cache keys always use it, so an answer
 * stays valid however the pieces are packed on the next run.
 */
const CACHE_PIECE_KEY = "p0";

/** Minimal cache seam: the caller owns storage and eviction. */
export interface CacheLike {
  get(key: string): number | undefined;
  set(key: string, noul: number): void;
}

export interface EngineInput {
  pieces: readonly Piece[];
  rules: readonly Rule[];
  threshold: number;
  maxCalls: number;
  model: string;
  endpoint: string;
  apiKey: string;
  fetchImpl: FetchLike;
  cache: CacheLike;
  note: (message: string) => void;
  /** True for a (rule, piece) pair the caller has already delivered once. */
  skipFinding?: (ruleId: string, pieceText: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  concurrency?: number;
  slot?: SlotGate;
}

export interface EngineResult {
  pieces: PieceFinding[];
  /** Every piece with every rule's score, highest first. No cutoff applied. */
  scores: PieceScore[];
  notChecked: NotChecked[];
  calls: number;
  cacheHits: number;
  /** Questions that got an answer, from the cache or from Jev. */
  answered: number;
  /** Pieces that rode in each call, in call order, for the run log. */
  piecesPerCall: number[];
  /** A transport failure that was not just the call budget running out. */
  transportFailed: boolean;
  /** A failure the next run could still succeed at. */
  holdBaseline: boolean;
  /**
   * Set when nothing the agent can do would help: the credential was rejected, the Jev
   * account has no credits, or every Jev slot on this machine is busy.
   */
  blocked: "auth" | "billing" | "busy" | null;
  usage: JevUsage;
  /** (rule, piece) pairs whose violations are in this result. */
  findings: { ruleId: string; pieceText: string }[];
}

/** The stage 1 claim. `key` names the piece inside the call's state. */
export function stage1Claim(rule: Rule, key: string): string {
  return `The added lines in the diff state.pieces.${key} violate this coding rule: ${rule.text}`;
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

/** What one piece looks like in a call of its own. The cache is keyed on this shape. */
function soloState(piece: Piece): unknown {
  return { pieces: { [CACHE_PIECE_KEY]: { file: piece.file, diff: chunkText(piece) } } };
}

/** One piece and the rules it still needs an answer for. */
interface Work {
  piece: Piece;
  rules: Rule[];
}

interface PackPayload {
  work: Work[];
  byQuestion: Record<string, { piece: Piece; rule: Rule }>;
}

interface Hit {
  piece: Piece;
  rule: Rule;
  score: number;
}

function reasonFor(failure: string, message: string): string {
  return failure === "budget" ? "call budget exhausted" : message;
}

function notCheckedFor(piece: Piece, reason: string): NotChecked {
  return { file: piece.file, fromLine: piece.fromLine, toLine: piece.toLine, reason };
}

function packQuestions(work: readonly Work[]): {
  state: unknown;
  questions: Record<string, JevQuestion>;
  byQuestion: Record<string, { piece: Piece; rule: Rule }>;
} {
  const pieces: Record<string, { file: string; diff: string }> = {};
  const questions: Record<string, JevQuestion> = {};
  const byQuestion: Record<string, { piece: Piece; rule: Rule }> = {};
  work.forEach((item, index) => {
    const key = `p${index}`;
    pieces[key] = { file: item.piece.file, diff: chunkText(item.piece) };
    item.rules.forEach((rule, ruleIndex) => {
      const id = `q${index}_${ruleIndex}`;
      questions[id] = { type: "noul", instructions: stage1Claim(rule, key) };
      byQuestion[id] = { piece: item.piece, rule };
    });
  });
  return { state: { pieces }, questions, byQuestion };
}

/** The bytes a call would weigh, so a pack can be bounded by body size. */
function packBytes(model: string, work: readonly Work[]): number {
  const { state, questions } = packQuestions(work);
  return utf8Bytes(JSON.stringify({ state, model, questions }));
}

function makePackNode(model: string, work: Work[]): AskNode<PackPayload> {
  const { state, questions, byQuestion } = packQuestions(work);
  return {
    payload: { work, byQuestion },
    state,
    questions,
    halve: () => {
      // Too long for Jev: halve the pack first, then the one piece that is still too long.
      if (work.length > 1) {
        const mid = Math.ceil(work.length / 2);
        return [makePackNode(model, work.slice(0, mid)), makePackNode(model, work.slice(mid))];
      }
      const only = work[0];
      if (only === undefined) return null;
      const halves = halvePiece(only.piece);
      if (halves === null) return null;
      return [
        makePackNode(model, [{ piece: halves[0], rules: only.rules }]),
        makePackNode(model, [{ piece: halves[1], rules: only.rules }]),
      ];
    },
  };
}

/** Groups pieces into calls of at most four, and at most 60,000 bytes of body. */
export function packWork(model: string, work: readonly Work[]): Work[][] {
  const packs: Work[][] = [];
  let current: Work[] = [];
  for (const item of work) {
    if (current.length === 0) {
      current.push(item);
      continue;
    }
    const candidate = [...current, item];
    if (candidate.length > PIECES_PER_CALL || packBytes(model, candidate) > PACK_MAX_BYTES) {
      packs.push(current);
      current = [item];
      continue;
    }
    current = candidate;
  }
  if (current.length > 0) packs.push(current);
  return packs;
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
    ...(input.slot ? { slot: input.slot } : {}),
  });

  const notChecked: NotChecked[] = [];
  /** Every (piece, rule) that got a score, whatever the score was. */
  const scored: Hit[] = [];
  const piecesPerCall: number[] = [];
  let cacheHits = 0;
  let answered = 0;
  let holdBaseline = false;
  let transportFailed = false;
  let blocked: "auth" | "billing" | "busy" | null = null;

  const noteFailure = (failure: string): void => {
    if (blocked !== null) return;
    if (failure === "auth") blocked = "auth";
    else if (failure === "billing") blocked = "billing";
    else if (failure === "busy") blocked = "busy";
  };

  // Stage 1. A piece whose every rule is already answered costs nothing and rides in no pack.
  const work: Work[] = [];
  for (const piece of input.pieces) {
    const state = soloState(piece);
    const uncached: Rule[] = [];
    for (const rule of input.rules) {
      const cached = cache.get(await cacheKey(model, stage1Claim(rule, CACHE_PIECE_KEY), state));
      if (cached === undefined) {
        uncached.push(rule);
        continue;
      }
      cacheHits += 1;
      answered += 1;
      scored.push({ piece, rule, score: cached });
    }
    for (let i = 0; i < uncached.length; i += MAX_RULES_PER_CALL) {
      work.push({ piece, rules: uncached.slice(i, i + MAX_RULES_PER_CALL) });
    }
  }

  const stage1Nodes = packWork(model, work).map((pack) => makePackNode(model, pack));

  for (const result of await client.askAll(stage1Nodes)) {
    const { work: sent, byQuestion } = result.node.payload;
    piecesPerCall.push(sent.length);
    if (!result.outcome.ok) {
      const failure = result.outcome.failure;
      if (holdsBaseline(failure)) holdBaseline = true;
      noteFailure(failure);
      if (failure !== "budget") transportFailed = true;
      for (const item of sent) {
        notChecked.push(notCheckedFor(item.piece, reasonFor(failure, result.outcome.message)));
      }
      continue;
    }
    for (const [id, target] of Object.entries(byQuestion)) {
      const noul = result.outcome.answers[id];
      if (noul === undefined) {
        // A missing answer is an error for that question, never a zero.
        note(`Jev returned no answer for rule ${target.rule.id} on ${target.piece.file}`);
        notChecked.push(
          notCheckedFor(target.piece, `Jev returned no answer for rule ${target.rule.id}`),
        );
        continue;
      }
      answered += 1;
      cache.set(
        await cacheKey(model, stage1Claim(target.rule, CACHE_PIECE_KEY), soloState(target.piece)),
        noul,
      );
      scored.push({ piece: target.piece, rule: target.rule, score: noul });
    }
  }

  const hits = scored.filter((hit) => hit.score >= threshold);
  const fresh =
    input.skipFinding === undefined
      ? hits
      : hits.filter((hit) => !input.skipFinding?.(hit.rule.id, chunkText(hit.piece)));

  const findings = fresh.map((hit) => ({ ruleId: hit.rule.id, pieceText: chunkText(hit.piece) }));
  const pieces = groupByPiece(fresh);

  const fromLineOf = (entry: NotChecked): number => (entry.fromLine === undefined ? 0 : entry.fromLine);
  notChecked.sort((a, b) => {
    const fileA = a.file ?? "";
    const fileB = b.file ?? "";
    return fileA === fileB ? fromLineOf(a) - fromLineOf(b) : fileA < fileB ? -1 : 1;
  });

  return {
    pieces,
    scores: groupScores(scored),
    notChecked,
    calls: client.calls,
    cacheHits,
    answered,
    piecesPerCall,
    transportFailed,
    holdBaseline,
    blocked,
    usage: client.usage,
    findings,
  };
}

/**
 * One entry per piece, with every rule that piece broke, highest confidence first. The piece
 * is what the agent is handed, so it is named once and its diff is printed once.
 */
function groupByPiece(fresh: readonly Hit[]): PieceFinding[] {
  const byPiece = new Map<string, PieceFinding>();
  for (const hit of fresh) {
    const text = chunkText(hit.piece);
    const broken: BrokenRule = {
      ruleId: hit.rule.id,
      rule: hit.rule.text,
      confidence: hit.score,
    };
    const existing = byPiece.get(text);
    if (existing !== undefined) {
      existing.rules.push(broken);
      continue;
    }
    byPiece.set(text, {
      file: hit.piece.file,
      unit: hit.piece.unitName,
      fromLine: hit.piece.fromLine,
      toLine: hit.piece.toLine,
      diff: text,
      rules: [broken],
    });
  }

  const pieces = [...byPiece.values()];
  for (const piece of pieces) {
    piece.rules.sort((a, b) => b.confidence - a.confidence);
  }
  pieces.sort((a, b) => (a.file === b.file ? a.fromLine - b.fromLine : a.file < b.file ? -1 : 1));
  return pieces;
}

/**
 * What `score` prints: one entry per piece with every rule's score, highest score first.
 * Nothing is left out, so a team can see where their own code sits on the scale.
 */
function groupScores(scored: readonly Hit[]): PieceScore[] {
  const byPiece = new Map<string, PieceScore>();
  for (const hit of scored) {
    const text = chunkText(hit.piece);
    const entry: PieceScore["rules"][number] = {
      ruleId: hit.rule.id,
      rule: hit.rule.text,
      score: hit.score,
    };
    const existing = byPiece.get(text);
    if (existing !== undefined) {
      existing.rules.push(entry);
      continue;
    }
    byPiece.set(text, {
      file: hit.piece.file,
      unit: hit.piece.unitName,
      fromLine: hit.piece.fromLine,
      toLine: hit.piece.toLine,
      rules: [entry],
    });
  }

  const pieces = [...byPiece.values()];
  for (const piece of pieces) piece.rules.sort((a, b) => b.score - a.score);
  const top = (piece: PieceScore): number => piece.rules[0]?.score ?? 0;
  pieces.sort((a, b) => {
    if (top(a) !== top(b)) return top(b) - top(a);
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.fromLine - b.fromLine;
  });
  return pieces;
}
