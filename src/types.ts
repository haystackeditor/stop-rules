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

export interface Violation {
  file: string;
  /** The name of the unit the piece starts at. Null when the piece was cut by diff hunk. */
  unitName: string | null;
  /** First and last new file line of the piece this finding came from. */
  fromLine: number;
  toLine: number;
  /** The piece's diff text, which the report hands to the agent as it is. */
  diff: string;
  /**
   * Only filled by the old line finding report: the lines that reached the cutoff, at most
   * 3, ascending. Empty in the piece report, which names no line.
   */
  lines: ViolationLine[];
  /** Why no line is named, in plain words. Null when `lines` holds them. */
  unlocalised: string | null;
  ruleId: string;
  rule: string;
  /** The score for this (piece, rule). */
  confidence: number;
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
  violations: number;
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
  violations: Violation[];
  notChecked: NotChecked[];
  skipped: SkippedFile[];
  stats: RunStats;
}
