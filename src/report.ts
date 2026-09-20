import type {
  BrokenRule,
  CheckReport,
  CutMode,
  NotChecked,
  PieceFinding,
  PieceScore,
  ScoreReport,
} from "./types.js";

/** How much of a piece's diff the report hands over before it says how much is left. */
export const MAX_PIECE_LINES = 60;

function confidence(score: number): string {
  return score.toFixed(2);
}

function where(from: number, to: number): string {
  return from === to ? `line ${from}` : `lines ${from}-${to}`;
}

function notCheckedLine(entry: NotChecked): string {
  if (entry.file === undefined) return entry.reason;
  if (entry.fromLine === undefined || entry.toLine === undefined) {
    return `${entry.file}: ${entry.reason}`;
  }
  return `${entry.file} ${where(entry.fromLine, entry.toLine)}: ${entry.reason}`;
}

/**
 * The git header of a piece's diff. The entry already names the file, so these lines are
 * four lines of noise in front of the code the agent has to read.
 */
function isDiffHeader(line: string): boolean {
  return (
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ")
  );
}

/** The piece's own diff, without the git header, capped, with a count of what was left out. */
function pieceDiff(piece: PieceFinding): string[] {
  const lines = piece.diff
    .split("\n")
    .filter((line) => line.length > 0 && !isDiffHeader(line));
  const shown = lines.slice(0, MAX_PIECE_LINES).map((line) => `   ${line}`);
  const left = lines.length - MAX_PIECE_LINES;
  if (left > 0) shown.push(`   ... ${left} more lines in this piece`);
  return shown;
}

function ruleLines(rule: BrokenRule): string[] {
  return [`   Rule: ${rule.rule}`, `   Confidence: ${confidence(rule.confidence)}`];
}

/** One entry: the piece that failed, once, with every rule it broke. */
function pieceBlock(piece: PieceFinding, index: number): string {
  const unit = piece.unit === null ? "" : ` in ${piece.unit}`;
  const heading =
    piece.rules.length === 1
      ? `${index}. ${piece.file} ${where(piece.fromLine, piece.toLine)}${unit} breaks 1 rule`
      : `${index}. ${piece.file} ${where(piece.fromLine, piece.toLine)}${unit} breaks ${piece.rules.length} rules`;
  return [
    heading,
    ...piece.rules.flatMap(ruleLines),
    "   The change this is about:",
    ...pieceDiff(piece),
  ].join("\n");
}

function notCheckedSections(notChecked: readonly NotChecked[]): string[] {
  if (notChecked.length === 1) {
    const only = notChecked[0];
    return only === undefined ? [] : [`Not checked (1): ${notCheckedLine(only)}`];
  }
  if (notChecked.length > 1) {
    return [
      `Not checked (${notChecked.length}):\n` +
        notChecked.map((entry) => `  ${notCheckedLine(entry)}`).join("\n"),
    ];
  }
  return [];
}

/** Plain text for the agent. No colours, no em dashes. */
export function renderReport(report: CheckReport): string {
  const { pieces, notChecked, stats } = report;
  const sections: string[] = [];

  if (pieces.length === 0) {
    sections.push(
      stats.pieces === 0
        ? "stop-rules: no changes to check."
        : "stop-rules: no rule violations in your latest changes.",
    );
  } else {
    const broken = pieces.reduce((total, piece) => total + piece.rules.length, 0);
    const count = broken === 1 ? "1 rule violation" : `${broken} rule violations`;
    const places = pieces.length === 1 ? "1 place" : `${pieces.length} places`;
    sections.push(
      `stop-rules: ${count} in ${places} in your latest changes.\n` +
        "Fix each one. If a rule truly should not apply here, leave the code and tell the user why.",
    );
    sections.push(pieces.map((piece, i) => pieceBlock(piece, i + 1)).join("\n\n"));
  }

  sections.push(...notCheckedSections(notChecked));
  return sections.join("\n\n");
}

/** How the change was cut, in plain words. */
export function cutWords(cut: CutMode): string {
  if (cut === "functions") return "whole functions, with tree-sitter";
  if (cut === "hunks") return "one diff hunk each, with no parser";
  return "diff hunks grouped into 12,000 byte chunks, with no parser";
}

function scoreBlock(piece: PieceScore, index: number): string {
  const unit = piece.unit === null ? "" : ` in ${piece.unit}`;
  const lines = [`${index}. ${piece.file} ${where(piece.fromLine, piece.toLine)}${unit}`];
  for (const rule of piece.rules) lines.push(`   ${confidence(rule.score)}  ${rule.rule}`);
  return lines.join("\n");
}

/** What `stop-rules score` prints: every piece, every rule, every score, no cutoff. */
export function renderScores(report: ScoreReport): string {
  const { pieces, notChecked, stats, source } = report;
  const sections: string[] = [];
  const scores = pieces.reduce((total, piece) => total + piece.rules.length, 0);

  if (pieces.length === 0) {
    sections.push(`stop-rules score: nothing to score in ${source}.`);
  } else {
    const count = pieces.length === 1 ? "1 piece" : `${pieces.length} pieces`;
    sections.push(
      `stop-rules score: ${count}, ${scores} scores, ${stats.calls} Jev calls, ${stats.cacheHits} answers from the cache.\n` +
        `Scored ${source}. No cutoff applied, nothing was marked as checked, and the baseline did not move.`,
    );
    sections.push(pieces.map((piece, i) => scoreBlock(piece, i + 1)).join("\n\n"));
  }

  sections.push(...notCheckedSections(notChecked));
  return sections.join("\n\n");
}
