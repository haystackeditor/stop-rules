/** Shared value types. Kept dependency free on purpose. */

import type { JudgeInfo } from "./judge.js";

export interface Rule {
  /** First 8 hex chars of sha256 of the normalised rule text. */
  id: string;
  /** Normalised rule text: continuation lines joined, whitespace collapsed. */
  text: string;
}

export interface AddedLine {
  /** Line number in the new version of the file. */
  line: number;
  /** Line content without the leading "+". */
  text: string;
}

/**
 * How a change is cut into pieces. Set with `cut` in .stop-rules.json or `--cut`.
 *
 * functions  one whole function per piece, using tree-sitter.
 * hunks      one diff hunk per piece, with no parser.
 * chunks     hunks of a file grouped into pieces of up to 12,000 bytes, with no parser.
 */
export type CutMode = "functions" | "hunks" | "chunks";

/** One whole function after the change, as Jev is shown it in `functions` mode. */
export interface PieceFunction {
  /** The name the report uses for this unit. */
  name: string;
  /** First and last new file line of the function, doc comment included. */
  fromLine: number;
  toLine: number;
  /** The function's full new text. */
  text: string;
}

/**
 * The code around a piece that goes to Jev with it.
 *
 * none      the piece's own diff only, with the tool's normal context.
 * wide      the diff widened to 25 unchanged lines around each change.
 * function  the diff plus the whole function after the change.
 */
export type PieceContext =
  | { kind: "none" }
  | { kind: "wide"; diff: string }
  | { kind: "function"; functions: PieceFunction[] };

/** The one value for "Jev sees the diff and nothing else". */
export const NO_CONTEXT: PieceContext = { kind: "none" };

/** Exactly what one piece looked like inside a call's state. What `--show-context` prints. */
export interface JevView {
  file: string;
  diff: string;
  function?: PieceFunction[];
}

/** One rule a piece broke. */
export interface BrokenRule {
  ruleId: string;
  /** The rule in full. Never shortened. */
  rule: string;
  confidence: number;
  /** OpenAI review form only: the model's verdict, which the confidence stands for. */
  verdict?: "sure" | "likely" | "unsure";
  /** OpenAI review form only: the added line the model quoted. */
  line?: string;
  /** OpenAI review form only: the model's one-sentence reason. */
  reason?: string;
}

/** A review form finding the tool refused, and why. Counted, never a run failure. */
export interface RejectedFindingEntry {
  ruleId: string;
  line: string;
  why: string;
}

/** One piece and every rule it broke. This is one entry of the report. */
export interface PieceFinding {
  file: string;
  /**
   * The function this piece is, or "top-level code" for a piece of statements and
   * declarations. Null when the file has no grammar and was cut by diff hunk.
   */
  unit: string | null;
  /** First and last new file line of the piece. */
  fromLine: number;
  toLine: number;
  /** The piece's diff text, printed once for the whole entry. */
  diff: string;
  /** The rules this piece broke, highest confidence first. */
  rules: BrokenRule[];
}

export interface NotChecked {
  /** Absent when the reason is about the run, such as a grammar that is not installed. */
  file?: string;
  /** Absent when the failure is about the file as a whole, such as an unreadable path. */
  fromLine?: number;
  toLine?: number;
  reason: string;
}

/** A file left out on purpose: generated content or data, not code. Not a failure. */
export interface SkippedFile {
  file: string;
  reason: string;
}

export interface RunStats {
  /** How the change was cut into pieces in this run. */
  cut: CutMode;
  files: number;
  /** Pieces the diff was cut into. Each one is judged on its own. */
  pieces: number;
  /**
   * Pieces that got at least one answer, from Jev or from the cache. Zero with files above
   * zero means nothing in this change was checked, whatever else the report says.
   */
  checked: number;
  skipped: number;
  calls: number;
  /** How many pieces rode in each call, in call order. */
  piecesPerCall: number[];
  cacheHits: number;
  /** Rules broken, counted per (piece, rule) pair. */
  violations: number;
  /** Pieces that broke at least one rule, which is how many entries the report has. */
  places: number;
  notChecked: number;
  /** Files cut by diff hunk instead of by syntax, and why. */
  cutByHunk: CutByHunk[];
  /** How many unchanged lines Jev was shown around each change. */
  contextLines: number;
  /** Pieces Jev saw with their diff widened to those lines. */
  widened: number;
  /** Pieces Jev saw with the whole function after the change. */
  withFunction: number;
  /**
   * Pieces Jev saw without the code around them, because the wide form on its own would go
   * over the 60,000 byte call cap. A recorded fact, never a silent fallback.
   */
  tooBigToWiden: WidenRefused[];
  /** OpenAI review form: findings refused for an unknown rule or a line the change did not add. */
  rejectedFindings: number;
  inputTokens: number;
  outputTokens: number;
  /** OpenAI judge only: input tokens served from OpenAI's prompt cache, a part of inputTokens. */
  cachedInputTokens?: number;
  /** OpenAI judge only: output tokens spent reasoning, a part of outputTokens. */
  reasoningTokens?: number;
  durationMs: number;
}

/** A file with no tree-sitter grammar, cut by diff hunk instead. */
export interface CutByHunk {
  file: string;
  reason: string;
}

/** One piece whose wide form was too big for a call of its own. */
export interface WidenRefused {
  file: string;
  fromLine: number;
  toLine: number;
  /** What a call carrying only this piece, widened, would have weighed. */
  bytes: number;
}

/** One rule's score for one piece, with no bar applied. What `score` prints. */
export interface RuleScore {
  ruleId: string;
  /** The rule in full. Never shortened. */
  rule: string;
  score: number;
  /** OpenAI review form only: the verdict, the quoted added line and the reason. */
  verdict?: "sure" | "likely" | "unsure";
  line?: string;
  reason?: string;
}

/** One piece and every rule's score for it, highest first. One entry of a score report. */
export interface PieceScore {
  file: string;
  /** The function this piece is, or "top-level code". Null when the piece was cut by hunk. */
  unit: string | null;
  fromLine: number;
  toLine: number;
  rules: RuleScore[];
  /** Exactly what Jev saw for this piece. Only filled in by `score --show-context`. */
  jevSaw?: JevView;
}

/** What `stop-rules score` returns: every piece, every rule, every score, no cutoff. */
export interface ScoreReport {
  /** Which judge gave the scores, and its model. */
  judge: JudgeInfo;
  pieces: PieceScore[];
  notChecked: NotChecked[];
  /** Review form findings the tool refused, each with the reason. */
  rejected: RejectedFindingEntry[];
  skipped: SkippedFile[];
  stats: RunStats;
  /** What was scored: the working tree, or a diff file. */
  source: string;
}

export interface CheckReport {
  /** Which judge gave the scores, and its model. */
  judge: JudgeInfo;
  /** One entry per piece that broke a rule, in file then line order. */
  pieces: PieceFinding[];
  /**
   * What the working tree was compared with, in plain words: "the last check", or the
   * revision `--base` named. The headline says it, so it can never claim the wrong baseline.
   */
  against: string;
  notChecked: NotChecked[];
  /** Review form findings the tool refused, each with the reason. */
  rejected: RejectedFindingEntry[];
  skipped: SkippedFile[];
  stats: RunStats;
}
