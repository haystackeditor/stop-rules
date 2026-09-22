import { describeJudge, judgeName } from "./judge.js";
import type {
  BrokenRule,
  CheckReport,
  CutMode,
  JevView,
  NotChecked,
  PieceFinding,
  PieceScore,
  RunStats,
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

/** How much of the change this run managed to check. Read off the facts, never guessed. */
export type Coverage = "nothing-changed" | "all-checked" | "partly-checked" | "none-checked";

export function coverage(report: CheckReport): Coverage {
  const { stats, notChecked } = report;
  if (stats.checked > 0) return notChecked.length === 0 ? "all-checked" : "partly-checked";
  if (stats.files > 0 || notChecked.length > 0) return "none-checked";
  return "nothing-changed";
}

function plural(count: number, word: string): string {
  return count === 1 ? `1 ${word}` : `${count} ${word}s`;
}

/**
 * The one sentence a run with nothing checked owes the reader. The hook uses it as a could
 * not run reason, because staying quiet there would read as a clean turn.
 */
export function noneCheckedReason(report: CheckReport): string {
  const head = `${plural(report.stats.files, "file")} changed and none of it could be checked`;
  const reasons = report.notChecked.map(notCheckedLine);
  return reasons.length === 0 ? `${head}.` : `${head}: ${reasons.join("; ")}`;
}

/** The first line, from the facts: what changed, what was checked, what was not. */
function headline(report: CheckReport): string {
  const { notChecked, stats } = report;
  switch (coverage(report)) {
    case "nothing-changed":
      return stats.skipped === 0
        ? `stop-rules: nothing changed since ${report.against}.`
        : `stop-rules: nothing to check since ${report.against}: the ${plural(stats.skipped, "file")} that changed ${stats.skipped === 1 ? "is a kind" : "are kinds"} stop-rules skips.`;
    case "all-checked":
      return "stop-rules: no rule violations in your latest changes.";
    case "partly-checked":
      return `stop-rules: no rule violations in the ${plural(stats.checked, "piece")} that ${stats.checked === 1 ? "was" : "were"} checked, and ${notChecked.length} not checked, listed below.`;
    case "none-checked":
      return (
        `stop-rules: ${plural(stats.files, "file")} changed and none of it could be checked.\n` +
        "This does not say your code is clean. The reasons are below."
      );
  }
}

/**
 * What the judge was shown beside each piece, in one sentence, read off the run's own counts.
 * It goes in the header line because the piece printed below is the narrower one: the report
 * hands the agent the piece's own diff, whatever the judge saw. `judge` is the judge's name
 * as the user knows it: Jev, or the OpenAI model.
 */
export function whatJevSaw(stats: RunStats, judge = "Jev"): string | null {
  const parts: string[] = [];
  const lines = stats.contextLines;
  if (stats.withFunction > 0 && stats.widened > 0) {
    parts.push(
      `${judge} saw the whole function for ${plural(stats.withFunction, "piece")} and ${lines} lines around the other ${stats.widened}.`,
    );
  } else if (stats.withFunction > 0) {
    parts.push(`${judge} saw the whole function each piece is.`);
  } else if (stats.widened > 0) {
    parts.push(`${judge} saw ${lines} lines around it.`);
  }
  const refused = stats.tooBigToWiden.length;
  if (refused > 0) {
    parts.push(
      `${plural(refused, "piece")} ${refused === 1 ? "was" : "were"} too big to widen, so ${judge} saw ${refused === 1 ? "it" : "them"} without the code around ${refused === 1 ? "it" : "them"}.`,
    );
  }
  return parts.length === 0 ? null : parts.join(" ");
}

/** Plain text for the agent. No colours, no em dashes. */
export function renderReport(report: CheckReport): string {
  const { pieces, notChecked } = report;
  const sections: string[] = [];
  const saw = whatJevSaw(report.stats, judgeName(report.judge));

  if (pieces.length === 0) {
    sections.push(saw === null ? headline(report) : `${headline(report)} ${saw}`);
  } else {
    const broken = pieces.reduce((total, piece) => total + piece.rules.length, 0);
    const count = broken === 1 ? "1 rule violation" : `${broken} rule violations`;
    const places = pieces.length === 1 ? "1 place" : `${pieces.length} places`;
    sections.push(
      `stop-rules: ${count} in ${places} in your latest changes.${saw === null ? "" : ` ${saw}`}\n` +
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

/** `--show-context`: exactly what the judge was sent for this piece, printed in full. */
function jevSawLines(saw: JevView, judge: string): string[] {
  const lines = [`   What ${judge} saw:`, `     file: ${saw.file}`, "     diff:"];
  for (const line of saw.diff.split("\n")) {
    if (line.length > 0) lines.push(`       ${line}`);
  }
  for (const unit of saw.function ?? []) {
    lines.push(`     function ${unit.name}, lines ${unit.fromLine}-${unit.toLine}:`);
    for (const line of unit.text.split("\n")) lines.push(`       ${line}`);
  }
  return lines;
}

function scoreBlock(piece: PieceScore, index: number, judge: string): string {
  const unit = piece.unit === null ? "" : ` in ${piece.unit}`;
  const lines = [`${index}. ${piece.file} ${where(piece.fromLine, piece.toLine)}${unit}`];
  for (const rule of piece.rules) lines.push(`   ${confidence(rule.score)}  ${rule.rule}`);
  if (piece.jevSaw !== undefined) lines.push(...jevSawLines(piece.jevSaw, judge));
  return lines.join("\n");
}

/** What `stop-rules score` prints: every piece, every rule, every score, no cutoff. */
export function renderScores(report: ScoreReport): string {
  const { pieces, notChecked, stats, source } = report;
  const sections: string[] = [];
  const scores = pieces.reduce((total, piece) => total + piece.rules.length, 0);
  const judge = judgeName(report.judge);

  if (pieces.length === 0) {
    sections.push(
      `stop-rules score: nothing to score in ${source}.\nJudge: ${describeJudge(report.judge)}.`,
    );
  } else {
    const count = pieces.length === 1 ? "1 piece" : `${pieces.length} pieces`;
    sections.push(
      `stop-rules score: ${count}, ${scores} scores, ${stats.calls} ${judge} calls, ${stats.cacheHits} answers from the cache.\n` +
        `Judge: ${describeJudge(report.judge)}.\n` +
        `Scored ${source}. No cutoff applied, nothing was marked as checked, and the baseline did not move.`,
    );
    sections.push(pieces.map((piece, i) => scoreBlock(piece, i + 1, judge)).join("\n\n"));
  }

  sections.push(...notCheckedSections(notChecked));
  return sections.join("\n\n");
}
