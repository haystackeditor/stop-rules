import type { ReportMode } from "./engine.js";
import type { CheckReport, NotChecked, Violation } from "./types.js";

/** A quoted code line is a pointer, not the payload. Past this it is noise for the agent. */
export const MAX_QUOTED_LINE = 160;
/** How much of a piece's diff the report hands over before it says how much is left. */
export const MAX_PIECE_LINES = 60;

function confidence(score: number): string {
  return score.toFixed(2);
}

/** Only quoted code lines are ever shortened. Rule text is never cut. */
export function trimQuoted(text: string): string {
  if (text.length <= MAX_QUOTED_LINE) return text;
  return `${text.slice(0, MAX_QUOTED_LINE)}...`;
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

/** The piece's own diff, capped, with a count of what was left out. */
function pieceDiff(violation: Violation): string[] {
  const lines = violation.diff.split("\n").filter((line) => line.length > 0);
  const shown = lines.slice(0, MAX_PIECE_LINES).map((line) => `   ${line}`);
  const left = lines.length - MAX_PIECE_LINES;
  if (left > 0) shown.push(`   ... ${left} more lines in this piece`);
  return shown;
}

/** The default report: hand over the piece that failed, whole. */
function pieceBlock(violation: Violation, index: number): string {
  const unit = violation.unitName === null ? "" : ` in ${violation.unitName}`;
  return [
    `${index}. ${violation.file} ${where(violation.fromLine, violation.toLine)}${unit}`,
    `   Rule: ${violation.rule}`,
    `   Confidence: ${confidence(violation.confidence)}`,
    "   The change this is about:",
    ...pieceDiff(violation),
  ].join("\n");
}

/**
 * The old line finding report. It is reachable only through STOP_RULES_REPORT=lines, which
 * exists for one measurement and is removed once that is done.
 */
function linesBlock(violation: Violation, index: number): string {
  if (violation.unlocalised !== null) {
    return [
      `${index}. ${violation.file} ${where(violation.fromLine, violation.toLine)}`,
      `   Rule: ${violation.rule}`,
      `   No single line identified: ${violation.unlocalised}`,
      `   Confidence: ${confidence(violation.confidence)}`,
    ].join("\n");
  }
  const at = violation.lines.map((line) => line.line).join(", ");
  return [
    `${index}. ${violation.file}:${at}`,
    `   Rule: ${violation.rule}`,
    ...violation.lines.map((line) => `   Line: ${trimQuoted(line.text)}`),
    `   Confidence: ${confidence(violation.confidence)}`,
  ].join("\n");
}

/** Plain text for the agent. No colours, no em dashes. */
export function renderReport(report: CheckReport, mode: ReportMode = "piece"): string {
  const { violations, notChecked, stats } = report;
  const sections: string[] = [];
  const block = mode === "piece" ? pieceBlock : linesBlock;

  if (violations.length === 0) {
    sections.push(
      stats.pieces === 0
        ? "stop-rules: no changes to check."
        : "stop-rules: no rule violations in your latest changes.",
    );
  } else {
    const count =
      violations.length === 1 ? "1 rule violation" : `${violations.length} rule violations`;
    sections.push(
      `stop-rules: ${count} in your latest changes.\n` +
        "Fix each one. If a rule truly should not apply here, leave the code and tell the user why.",
    );
    sections.push(violations.map((violation, i) => block(violation, i + 1)).join("\n\n"));
  }

  if (notChecked.length === 1) {
    const only = notChecked[0];
    if (only !== undefined) sections.push(`Not checked (1): ${notCheckedLine(only)}`);
  } else if (notChecked.length > 1) {
    sections.push(
      `Not checked (${notChecked.length}):\n` +
        notChecked.map((entry) => `  ${notCheckedLine(entry)}`).join("\n"),
    );
  }

  return sections.join("\n\n");
}
