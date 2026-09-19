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

export interface ViolationLine {
  /** Line number in the new version of the file. */
  line: number;
  /** Trimmed text of that line. */
  text: string;
}

/** One rule a piece broke. */
export interface BrokenRule {
  ruleId: string;
  /** The rule in full. Never shortened. */
  rule: string;
  confidence: number;
  /**
   * Only filled by the old line finding report: the lines that reached the cutoff, at most
   * 3, ascending. Empty in the piece report, which names no line.
   */
  lines: ViolationLine[];
  /** Why no line is named, in plain words. Null in the piece report and when lines holds them. */
  unlocalised: string | null;
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
  files: number;
  /** Pieces the diff was cut into. Each one is judged on its own. */
  pieces: number;
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

export interface CheckReport {
  /** One entry per piece that broke a rule, in file then line order. */
  pieces: PieceFinding[];
  notChecked: NotChecked[];
  skipped: SkippedFile[];
  stats: RunStats;
}
