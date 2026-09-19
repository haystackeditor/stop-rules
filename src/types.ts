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
  /** The localised lines for this (file, rule), at most 3, ascending. */
  lines: ViolationLine[];
  /** True when the lines could not be localised confidently. */
  approximate: boolean;
  ruleId: string;
  rule: string;
  /** Stage 1 score for this (chunk, rule). */
  confidence: number;
}

export interface NotChecked {
  file: string;
  fromLine: number;
  toLine: number;
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
