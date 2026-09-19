import type { ReportMode } from "./engine.js";
import type { BrokenRule, CheckReport, NotChecked, PieceFinding } from "./types.js";

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

/** The default report: hand over the piece that failed, once, with every rule it broke. */
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

/**
 * The old line finding report. It is reachable only through STOP_RULES_REPORT=lines, which
 * exists for one measurement and is removed once that is done.
 */
function linesBlock(piece: PieceFinding, index: number): string {
  const out: string[] = [`${index}. ${piece.file} ${where(piece.fromLine, piece.toLine)}`];
  for (const rule of piece.rules) {
    out.push(`   Rule: ${rule.rule}`);
    if (rule.unlocalised !== null) {
      out.push(`   No single line identified: ${rule.unlocalised}`);
    } else {
      for (const line of rule.lines) out.push(`   Line ${line.line}: ${trimQuoted(line.text)}`);
    }
    out.push(`   Confidence: ${confidence(rule.confidence)}`);
  }
  return out.join("\n");
}

/** Plain text for the agent. No colours, no em dashes. */
export function renderReport(report: CheckReport, mode: ReportMode = "piece"): string {
  const { pieces, notChecked, stats } = report;
  const sections: string[] = [];
  const block = mode === "piece" ? pieceBlock : linesBlock;

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
    sections.push(pieces.map((piece, i) => block(piece, i + 1)).join("\n\n"));
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
