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
  /**
   * The lines that reached the cutoff, at most 3, ascending. Empty when no single line was
   * identified, in which case `unlocalised` says why and the range below is what to read.
   */
  lines: ViolationLine[];
  /** First and last new file line of the changed block this finding came from. */
  fromLine: number;
  toLine: number;
  /** Why no line is named, in plain words. Null when `lines` holds them. */
  unlocalised: string | null;
  ruleId: string;
  rule: string;
  /** Stage 1 score for this (chunk, rule). */
  confidence: number;
}

export interface NotChecked {
  file: string;
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
  chunks: number;
  skipped: number;
  calls: number;
  cacheHits: number;
  violations: number;
  notChecked: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface CheckReport {
  violations: Violation[];
  notChecked: NotChecked[];
  skipped: SkippedFile[];
  stats: RunStats;
}
