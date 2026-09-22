/**
 * The check engine. Stage 1 asks, for every piece and rule, whether the added lines break
 * the rule. The judge is a seam: Jev takes up to four pieces in one call, the OpenAI judge one
 * piece per call with several calls in flight, and everything around the asking (the cache,
 * the cutoff, the grouping) is the same for both. Plain inputs, plain outputs, no Node-only
 * imports and no environment reads, so the same code runs in a CLI, a worker or an edge
 * function. Parsing happens above this file; here a piece is just text.
 */

import { chunkText, halvePiece, utf8Bytes, type Piece } from "./diff.js";
import { CONTEXT_LINES } from "./context.js";
import {
  JevClient,
  holdsBaseline,
  type AskNode,
  type FailureClass,
  type FetchLike,
  type JevQuestion,
  type SlotGate,
} from "./jev.js";
import { cacheModel, judgeName, type Judge } from "./judge.js";
import {
  OpenAiClient,
  promptCacheKey,
  readVerdict,
  requestBody,
  userInput,
  type OpenAiNode,
  type OpenAiQuestion,
} from "./openai.js";
import {
  addedLines,
  quoteInPiece,
  readReview,
  reviewBody,
  reviewInput,
  VERDICT_SCORE,
  type FindingDetail,
  type RejectedFinding,
  type ReviewFinding,
} from "./review.js";
import {
  NO_CONTEXT,
  type BrokenRule,
  type JevView,
  type NotChecked,
  type PieceContext,
  type PieceFinding,
  type PieceScore,
  type Rule,
  type WidenRefused,
} from "./types.js";

/**
 * The one cutoff, and the one place this default is written. It is a default to look at, not
 * a recommendation: run `stop-rules score` on your own code and pick your own bar. The
 * `threshold` key in .stop-rules.json or the --threshold flag overrides it.
 *
 * 0.6 since 2026-09-21. Measured on 96 real agent sessions across six projects with
 * well-worded rules, one piece per call, every flag ruled by a reviewer: 0.5 caught 59 of 62
 * real breaks with 13 wrong flags, 0.6 caught 56 with 5, 0.7 caught 46 with 2. So 0.6 gives up
 * 3 catches in 62 to remove 8 wrong flags in 13, and the owner chose that trade. The earlier
 * 240-change corpus measurement, where 0.5 caught 22 of 29 and 0.6 caught 11, was on the
 * original, less exact rule wordings; docs/TUNING.md has both tables and the rewording that
 * moved the number.
 */
export const DEFAULT_THRESHOLD = 0.6;

/**
 * The one ceiling on requests to the judge in one run. Raise it with `maxCalls` or
 * `--max-calls`. Jev takes up to four pieces per call, so 60 calls cover up to 240 pieces.
 */
export const DEFAULT_MAX_CALLS = 60;
/**
 * The same ceiling for the OpenAI judge, which takes one piece per call. 240 calls cover the
 * same 240 pieces Jev's 60 do, so switching judge never leaves a change half checked.
 */
export const DEFAULT_MAX_CALLS_OPENAI = 240;

/**
 * The call ceiling a judge gets when neither the file nor a flag sets one. The review form puts
 * a whole change in one call, so Jev's 60 is already more than it needs.
 */
export function defaultMaxCalls(judge: { kind: "jev" | "openai"; form?: "review" | "scores" }): number {
  return judge.kind === "openai" && judge.form === "scores" ? DEFAULT_MAX_CALLS_OPENAI : DEFAULT_MAX_CALLS;
}

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

/**
 * Minimal cache seam: the caller owns storage and eviction. A review form answer also keeps
 * what the finding said, so a cached finding still shows the agent the line and the reason.
 */
export interface CacheLike {
  get(key: string): { noul: number; detail?: FindingDetail } | undefined;
  set(key: string, noul: number, detail?: FindingDetail): void;
}

export interface EngineInput {
  pieces: readonly Piece[];
  rules: readonly Rule[];
  threshold: number;
  maxCalls: number;
  /** Which service scores the pieces, with every value filled in. */
  judge: Judge;
  endpoint: string;
  apiKey: string;
  fetchImpl: FetchLike;
  cache: CacheLike;
  note: (message: string) => void;
  /** True for a (rule, piece) pair the caller has already delivered once. */
  skipFinding?: (ruleId: string, pieceText: string) => boolean;
  /** `score --show-context`: put exactly what Jev saw on every score. */
  showContext?: boolean;
  sleep?: (ms: number) => Promise<void>;
  concurrency?: number;
  slot?: SlotGate;
}

export type Blocked = "auth" | "billing" | "busy" | "model";

/** Tokens the judge counted. The two OpenAI counts are parts of input and output. */
export interface JudgeUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
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
  /** Pieces Jev saw with their diff widened. */
  widened: number;
  /** Pieces Jev saw with the whole function after the change. */
  withFunction: number;
  /** Pieces whose wide form would not fit a call of its own. */
  tooBigToWiden: WidenRefused[];
  /** A transport failure that was not just the call budget running out. */
  transportFailed: boolean;
  /** A failure the next run could still succeed at. */
  holdBaseline: boolean;
  /**
   * Set when nothing the agent can do would help: the credential was rejected, the judge's
   * account has no credits, the model cannot be used with this key, or every slot on this
   * machine is busy.
   */
  blocked: Blocked | null;
  /** The judge's own words for why it is blocked, for a model it cannot use. */
  blockedMessage: string | null;
  usage: JudgeUsage;
  /** (rule, piece) pairs whose violations are in this result. */
  findings: { ruleId: string; pieceText: string }[];
  /** Review form findings the tool refused: an unknown rule, or a line the change did not add. */
  rejected: RejectedFinding[];
}

/**
 * The stage 1 claim. `key` names the piece inside the call's state.
 *
 * This wording is the one the code around each piece was measured with on our harness on
 * 20 September 2026. Against the older wording, which named only the diff, answers moved by
 * 0.011 on the same sample, so the measured one is what ships.
 */
export function stage1Claim(rule: Rule, key: string): string {
  return (
    "Using everything in state (the diff and the code around it), the added lines in the " +
    `diff state.pieces.${key} violate this coding rule: ${rule.text}`
  );
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

/**
 * Exactly what Jev is shown for one piece: the file, the diff, and the code around it. The
 * report hands the agent the piece's own diff instead, whatever is here.
 */
export function pieceState(piece: Piece, context: PieceContext): JevView {
  switch (context.kind) {
    case "none":
      return { file: piece.file, diff: chunkText(piece) };
    case "wide":
      return { file: piece.file, diff: context.diff };
    case "function":
      return { file: piece.file, diff: chunkText(piece), function: context.functions };
  }
}

/** What one piece looks like in a call of its own. The cache is keyed on this shape. */
function soloState(piece: Piece, context: PieceContext): unknown {
  return { pieces: { [CACHE_PIECE_KEY]: pieceState(piece, context) } };
}

/** One piece, the code around it that fits, and the rules it still needs an answer for. */
interface Work {
  piece: Piece;
  context: PieceContext;
  rules: Rule[];
}

interface PackPayload {
  work: Work[];
  byQuestion: Record<string, { piece: Piece; rule: Rule }>;
}

interface Hit {
  piece: Piece;
  /** The code around the piece that actually went with it, for --show-context. */
  context: PieceContext;
  rule: Rule;
  score: number;
  /** Review form only: the line the model quoted and why, for the report. */
  detail?: FindingDetail;
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
  const pieces: Record<string, JevView> = {};
  const questions: Record<string, JevQuestion> = {};
  const byQuestion: Record<string, { piece: Piece; rule: Rule }> = {};
  work.forEach((item, index) => {
    const key = `p${index}`;
    pieces[key] = pieceState(item.piece, item.context);
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
        makePackNode(model, [{ piece: halves[0], context: halves[0].context, rules: only.rules }]),
        makePackNode(model, [{ piece: halves[1], context: halves[1].context, rules: only.rules }]),
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

type OpenAiJudge = Extract<Judge, { kind: "openai" }>;

/** The length of a real prompt cache key, so a body can be weighed before it is hashed. */
const CACHE_KEY_STAND_IN = `stop-rules-${"0".repeat(24)}`;

function openAiRules(rules: readonly Rule[]): { id: string; text: string }[] {
  return rules.map((rule) => ({ id: rule.id, text: rule.text }));
}

/** The bytes one OpenAI call carrying only this piece would weigh. */
function openAiBytes(judge: OpenAiJudge, work: Work): number {
  const question: OpenAiQuestion = {
    input: userInput(pieceState(work.piece, work.context), openAiRules(work.rules)),
    promptCacheKey: CACHE_KEY_STAND_IN,
    ids: [],
  };
  return utf8Bytes(requestBody(judge.model, judge.effort, question));
}

/** One piece, every rule it still needs, one call. The halves keep the same rules and key. */
function makeOpenAiNode(
  judge: OpenAiJudge,
  work: Work,
  cacheKeyText: string,
): OpenAiNode<PackPayload, Record<string, number>> {
  const byQuestion: Record<string, { piece: Piece; rule: Rule }> = {};
  const ids = work.rules.map((rule, index) => {
    const id = `q0_${index}`;
    byQuestion[id] = { piece: work.piece, rule };
    return id;
  });
  const question: OpenAiQuestion = {
    input: userInput(pieceState(work.piece, work.context), openAiRules(work.rules)),
    promptCacheKey: cacheKeyText,
    ids,
  };
  return {
    payload: { work: [work], byQuestion },
    request: {
      body: requestBody(judge.model, judge.effort, question),
      read: (parsed) => readVerdict(parsed, ids),
    },
    halve: () => {
      const halves = halvePiece(work.piece);
      if (halves === null) return null;
      return [
        makeOpenAiNode(judge, { piece: halves[0], context: halves[0].context, rules: work.rules }, cacheKeyText),
        makeOpenAiNode(judge, { piece: halves[1], context: halves[1].context, rules: work.rules }, cacheKeyText),
      ];
    },
  };
}

/** One change's pieces, grouped by file in line order, as the review form sends them. */
function reviewFiles(work: readonly Work[]): { file: string; views: ReturnType<typeof pieceState>[] }[] {
  const byFile = new Map<string, Work[]>();
  for (const item of work) byFile.set(item.piece.file, [...(byFile.get(item.piece.file) ?? []), item]);
  return [...byFile.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, items]) => ({
      file,
      views: [...items]
        .sort((a, b) => a.piece.fromLine - b.piece.fromLine)
        .map((item) => pieceState(item.piece, item.context)),
    }));
}

/** Every rule of the repository goes into a review call, whatever the pieces still need. */
function reviewCallInput(work: readonly Work[], rules: readonly Rule[]): string {
  return reviewInput(reviewFiles(work), openAiRules(rules));
}

function reviewBytes(judge: OpenAiJudge, work: readonly Work[], rules: readonly Rule[]): number {
  return utf8Bytes(reviewBody(judge.model, judge.effort, reviewCallInput(work, rules)));
}

/**
 * One review call: a group of pieces from one change and every rule. Too long for the model,
 * it splits the group in two, then a lone piece in two.
 */
function makeReviewNode(
  judge: OpenAiJudge,
  work: Work[],
  rules: readonly Rule[],
): OpenAiNode<PackPayload, ReviewFinding[]> {
  const byQuestion: Record<string, { piece: Piece; rule: Rule }> = {};
  work.forEach((item, index) => {
    rules.forEach((rule, ruleIndex) => {
      byQuestion[`q${index}_${ruleIndex}`] = { piece: item.piece, rule };
    });
  });
  return {
    payload: { work, byQuestion },
    request: {
      body: reviewBody(judge.model, judge.effort, reviewCallInput(work, rules)),
      read: readReview,
    },
    halve: () => {
      if (work.length > 1) {
        const mid = Math.ceil(work.length / 2);
        return [makeReviewNode(judge, work.slice(0, mid), rules), makeReviewNode(judge, work.slice(mid), rules)];
      }
      const only = work[0];
      if (only === undefined) return null;
      const halves = halvePiece(only.piece);
      if (halves === null) return null;
      return [
        makeReviewNode(judge, [{ piece: halves[0], context: halves[0].context, rules: only.rules }], rules),
        makeReviewNode(judge, [{ piece: halves[1], context: halves[1].context, rules: only.rules }], rules),
      ];
    },
  };
}

/** Groups a change's pieces into as few review calls as fit under the byte cap. */
function packReview(judge: OpenAiJudge, work: readonly Work[], rules: readonly Rule[]): Work[][] {
  const ordered = reviewFiles(work).flatMap((entry) =>
    work
      .filter((item) => item.piece.file === entry.file)
      .sort((a, b) => a.piece.fromLine - b.piece.fromLine),
  );
  const packs: Work[][] = [];
  let current: Work[] = [];
  for (const item of ordered) {
    const candidate = [...current, item];
    if (current.length > 0 && reviewBytes(judge, candidate, rules) > PACK_MAX_BYTES) {
      packs.push(current);
      current = [item];
      continue;
    }
    current = candidate;
  }
  if (current.length > 0) packs.push(current);
  return packs;
}

/**
 * Turns one review answer into a score per (piece, rule). A finding lands on every piece of
 * the call that has the quoted line among its added lines, and the strongest finding for a
 * rule wins. A finding for a rule that is not in the repository, or quoting a line no piece
 * added, is refused on its own: the rest of the answer still counts.
 */
function scoreReview(
  payload: PackPayload,
  findings: readonly ReviewFinding[],
  rules: readonly Rule[],
  judgeLabel: string,
): { answers: Record<string, number>; details: Record<string, FindingDetail>; rejected: RejectedFinding[] } {
  const answers: Record<string, number> = {};
  const details: Record<string, FindingDetail> = {};
  const rejected: RejectedFinding[] = [];
  const ruleIndex = new Map(rules.map((rule, index) => [rule.id, index]));
  const added = payload.work.map((item) => addedLines(chunkText(item.piece)));
  for (const id of Object.keys(payload.byQuestion)) answers[id] = 0;
  for (const finding of findings) {
    const index = ruleIndex.get(finding.ruleId);
    if (index === undefined) {
      rejected.push({
        ruleId: finding.ruleId,
        line: finding.line,
        why: `${judgeLabel} reported the rule ${JSON.stringify(finding.ruleId)}, which is not one of this repository's rules`,
      });
      continue;
    }
    const hits = payload.work.map((_, piece) => piece).filter((piece) => quoteInPiece(finding.line, added[piece] ?? []));
    if (hits.length === 0) {
      rejected.push({
        ruleId: finding.ruleId,
        line: finding.line,
        why: `${judgeLabel} quoted a line for rule ${finding.ruleId} that is not an added line of this change: ${JSON.stringify(finding.line.trim().slice(0, 160))}`,
      });
      continue;
    }
    const score = VERDICT_SCORE[finding.confidence];
    for (const piece of hits) {
      const id = `q${piece}_${index}`;
      if ((answers[id] ?? 0) >= score && details[id] !== undefined) continue;
      answers[id] = score;
      details[id] = { verdict: finding.confidence, line: finding.line.trim(), reason: finding.reason.trim() };
    }
  }
  return { answers, details, rejected };
}

/** The bytes a call carrying only this piece would weigh, for the judge that will be asked. */
function soloBytes(judge: Judge, work: Work, rules: readonly Rule[]): number {
  if (judge.kind === "jev") return packBytes(judge.model, [work]);
  return judge.form === "scores" ? openAiBytes(judge, work) : reviewBytes(judge, [work], rules);
}

/** What the engine needs back from either judge for one call. */
interface CallResult {
  payload: PackPayload;
  outcome:
    | { ok: true; answers: Record<string, number>; details?: Record<string, FindingDetail> }
    | { ok: false; failure: FailureClass; message: string };
  rejected?: RejectedFinding[];
}

interface Asked {
  results: CallResult[];
  calls: number;
  usage: JudgeUsage;
}

/** The seam: the work goes to whichever judge the run uses, and every call comes back. */
async function askJudge(
  input: EngineInput,
  work: readonly Work[],
): Promise<Asked> {
  const { judge, note } = input;
  if (judge.kind === "jev") {
    const client = new JevClient({
      endpoint: input.endpoint,
      model: judge.model,
      apiKey: input.apiKey,
      maxCalls: input.maxCalls,
      fetchImpl: input.fetchImpl,
      note,
      ...(input.sleep ? { sleep: input.sleep } : {}),
      ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
      ...(input.slot ? { slot: input.slot } : {}),
    });
    const nodes = packWork(judge.model, work).map((pack) => makePackNode(judge.model, pack));
    const results = (await client.askAll(nodes)).map((result) => ({
      payload: result.node.payload,
      outcome: result.outcome,
    }));
    return { results, calls: client.calls, usage: { ...client.usage } };
  }

  const client = new OpenAiClient({
    endpoint: input.endpoint,
    model: judge.model,
    effort: judge.effort,
    apiKey: input.apiKey,
    maxCalls: input.maxCalls,
    fetchImpl: input.fetchImpl,
    concurrency: input.concurrency ?? judge.inFlight,
    note,
    ...(input.sleep ? { sleep: input.sleep } : {}),
    ...(input.slot ? { slot: input.slot } : {}),
  });
  if (judge.form === "review") {
    const nodes = packReview(judge, work, input.rules).map((pack) => makeReviewNode(judge, pack, input.rules));
    const results = (await client.askAll(nodes)).map((result): CallResult => {
      if (!result.outcome.ok) return { payload: result.node.payload, outcome: result.outcome };
      const scored = scoreReview(result.node.payload, result.outcome.answer, input.rules, judge.model);
      return {
        payload: result.node.payload,
        outcome: { ok: true, answers: scored.answers, details: scored.details },
        rejected: scored.rejected,
      };
    });
    return { results, calls: client.calls, usage: { ...client.usage } };
  }

  const keys = new Map<string, string>();
  const nodes: OpenAiNode<PackPayload, Record<string, number>>[] = [];
  for (const item of work) {
    const rulesKey = item.rules.map((rule) => rule.id).join(",");
    let key = keys.get(rulesKey);
    if (key === undefined) {
      key = await promptCacheKey(openAiRules(item.rules));
      keys.set(rulesKey, key);
    }
    nodes.push(makeOpenAiNode(judge, item, key));
  }
  const results = (await client.askAll(nodes)).map(
    (result): CallResult => ({
      payload: result.node.payload,
      outcome: result.outcome.ok ? { ok: true, answers: result.outcome.answer } : result.outcome,
    }),
  );
  return { results, calls: client.calls, usage: { ...client.usage } };
}

/**
 * The code around a piece, unless sending it would put a call carrying only this piece over
 * the 60,000 byte cap. In that case the piece goes with its diff alone and the run says so,
 * once in the run log and once in the stats: it is a recorded fact, not a quiet retreat.
 */
function contextThatFits(
  judge: Judge,
  piece: Piece,
  rules: readonly Rule[],
  refused: WidenRefused[],
  note: (message: string) => void,
): PieceContext {
  const context = piece.context;
  if (context.kind === "none") return context;
  const bytes = soloBytes(judge, { piece, context, rules: [...rules] }, rules);
  if (bytes <= PACK_MAX_BYTES) return context;
  refused.push({ file: piece.file, fromLine: piece.fromLine, toLine: piece.toLine, bytes });
  note(
    `${piece.file} lines ${piece.fromLine}-${piece.toLine}: too big to widen, ` +
      `a call with the ${CONTEXT_LINES} lines around it would be ${bytes} bytes, over the ` +
      `${PACK_MAX_BYTES} byte cap, so ${judgeName(judge)} saw the diff alone`,
  );
  return NO_CONTEXT;
}

export async function runEngine(input: EngineInput): Promise<EngineResult> {
  const { cache, note, threshold, judge } = input;
  // The model string the cache is keyed on. For Jev it is the bare model name it always was.
  const model = cacheModel(judge);
  const name = judgeName(judge);

  const notChecked: NotChecked[] = [];
  /** Every (piece, rule) that got a score, whatever the score was. */
  const scored: Hit[] = [];
  const piecesPerCall: number[] = [];
  const tooBigToWiden: WidenRefused[] = [];
  let widened = 0;
  let withFunction = 0;
  let cacheHits = 0;
  let answered = 0;
  let holdBaseline = false;
  let transportFailed = false;
  let blocked: Blocked | null = null;
  let blockedMessage: string | null = null;

  const noteFailure = (failure: string, message: string): void => {
    if (blocked !== null) return;
    if (failure === "auth") blocked = "auth";
    else if (failure === "billing") blocked = "billing";
    else if (failure === "busy") blocked = "busy";
    else if (failure === "model") blocked = "model";
    if (blocked !== null) blockedMessage = message;
  };

  // Stage 1. A piece whose every rule is already answered costs nothing and rides in no call.
  const reviewForm = judge.kind === "openai" && judge.form === "review";
  const rejected: RejectedFinding[] = [];
  const work: Work[] = [];
  for (const piece of input.pieces) {
    const context = contextThatFits(judge, piece, input.rules, tooBigToWiden, note);
    if (context.kind === "wide") widened += 1;
    if (context.kind === "function") withFunction += 1;
    const state = soloState(piece, context);
    let uncached: Rule[] = [];
    const hitsHere: Hit[] = [];
    for (const rule of input.rules) {
      const cached = cache.get(await cacheKey(model, stage1Claim(rule, CACHE_PIECE_KEY), state));
      if (cached === undefined) {
        uncached.push(rule);
        continue;
      }
      hitsHere.push({
        piece,
        context,
        rule,
        score: cached.noul,
        ...(cached.detail !== undefined ? { detail: cached.detail } : {}),
      });
    }
    // A review reads every rule at once, so a piece with any rule unanswered is asked whole and
    // its cached answers for the other rules are not used this time.
    if (reviewForm && uncached.length > 0) uncached = [...input.rules];
    else {
      cacheHits += hitsHere.length;
      answered += hitsHere.length;
      scored.push(...hitsHere);
    }
    if (reviewForm) {
      if (uncached.length > 0) work.push({ piece, context, rules: uncached });
      continue;
    }
    for (let i = 0; i < uncached.length; i += MAX_RULES_PER_CALL) {
      work.push({ piece, context, rules: uncached.slice(i, i + MAX_RULES_PER_CALL) });
    }
  }

  const asked = await askJudge(input, work);

  for (const result of asked.results) {
    const { work: sent, byQuestion } = result.payload;
    piecesPerCall.push(sent.length);
    for (const refused of result.rejected ?? []) {
      rejected.push(refused);
      note(`finding rejected: ${refused.why}`);
    }
    if (!result.outcome.ok) {
      const failure = result.outcome.failure;
      if (holdsBaseline(failure)) holdBaseline = true;
      noteFailure(failure, result.outcome.message);
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
        note(`${name} returned no answer for rule ${target.rule.id} on ${target.piece.file}`);
        notChecked.push(
          notCheckedFor(target.piece, `${name} returned no answer for rule ${target.rule.id}`),
        );
        continue;
      }
      answered += 1;
      const item = sent.find((candidate) => candidate.piece === target.piece);
      if (item === undefined) {
        throw new Error("internal error: an answer for a piece that was not in the pack");
      }
      const detail = result.outcome.details?.[id];
      cache.set(
        await cacheKey(
          model,
          stage1Claim(target.rule, CACHE_PIECE_KEY),
          soloState(target.piece, item.context),
        ),
        noul,
        detail,
      );
      scored.push({
        piece: target.piece,
        context: item.context,
        rule: target.rule,
        score: noul,
        ...(detail !== undefined ? { detail } : {}),
      });
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
    scores: groupScores(scored, input.showContext === true),
    notChecked,
    calls: asked.calls,
    cacheHits,
    answered,
    piecesPerCall,
    widened,
    withFunction,
    tooBigToWiden,
    transportFailed,
    holdBaseline,
    blocked,
    blockedMessage,
    usage: asked.usage,
    findings,
    rejected,
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
      ...(hit.detail !== undefined
        ? { verdict: hit.detail.verdict, line: hit.detail.line, reason: hit.detail.reason }
        : {}),
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
function groupScores(scored: readonly Hit[], showContext: boolean): PieceScore[] {
  const byPiece = new Map<string, PieceScore>();
  for (const hit of scored) {
    const text = chunkText(hit.piece);
    const entry: PieceScore["rules"][number] = {
      ruleId: hit.rule.id,
      rule: hit.rule.text,
      score: hit.score,
      ...(hit.detail !== undefined
        ? { verdict: hit.detail.verdict, line: hit.detail.line, reason: hit.detail.reason }
        : {}),
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
      ...(showContext ? { jevSaw: pieceState(hit.piece, hit.context) } : {}),
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
