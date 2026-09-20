/** Shared value types. Kept dependency free on purpose. */

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

/** One rule a piece broke. */
export interface BrokenRule {
  ruleId: string;
  /** The rule in full. Never shortened. */
  rule: string;
  confidence: number;
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
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

/** A file with no tree-sitter grammar, cut by diff hunk instead. */
export interface CutByHunk {
  file: string;
  reason: string;
}

/** One rule's score for one piece, with no bar applied. What `score` prints. */
export interface RuleScore {
  ruleId: string;
  /** The rule in full. Never shortened. */
  rule: string;
  score: number;
}

/** One piece and every rule's score for it, highest first. One entry of a score report. */
export interface PieceScore {
  file: string;
  /** The function this piece is, or "top-level code". Null when the piece was cut by hunk. */
  unit: string | null;
  fromLine: number;
  toLine: number;
  rules: RuleScore[];
}

/** What `stop-rules score` returns: every piece, every rule, every score, no cutoff. */
export interface ScoreReport {
  pieces: PieceScore[];
  notChecked: NotChecked[];
  skipped: SkippedFile[];
  stats: RunStats;
  /** What was scored: the working tree, or a diff file. */
  source: string;
}

export interface CheckReport {
  /** One entry per piece that broke a rule, in file then line order. */
  pieces: PieceFinding[];
  /**
   * What the working tree was compared with, in plain words: "the last check", or the
   * revision `--base` named. The headline says it, so it can never claim the wrong baseline.
   */
  against: string;
  notChecked: NotChecked[];
  skipped: SkippedFile[];
  stats: RunStats;
}
