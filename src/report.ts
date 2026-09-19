import type { CheckReport, NotChecked, Violation } from "./types.js";

/** A quoted line is a pointer, not the payload. Past this it is noise for the agent. */
export const MAX_QUOTED_LINE = 160;

function confidence(score: number): string {
  return score.toFixed(2);
}

export function trimQuoted(text: string): string {
  if (text.length <= MAX_QUOTED_LINE) return text;
  return `${text.slice(0, MAX_QUOTED_LINE)}...`;
}

function notCheckedLine(entry: NotChecked): string {
  if (entry.fromLine === undefined || entry.toLine === undefined) {
    return `${entry.file}: ${entry.reason}`;
  }
  const where =
    entry.fromLine === entry.toLine
      ? `line ${entry.fromLine}`
      : `lines ${entry.fromLine}-${entry.toLine}`;
  return `${entry.file} ${where}: ${entry.reason}`;
}

function violationBlock(violation: Violation, index: number): string {
  // No line is ever guessed at. When nothing scored high enough, the entry says so and
  // points at the block of changed lines instead.
  if (violation.unlocalised !== null) {
    const range =
      violation.fromLine === violation.toLine
        ? `line ${violation.fromLine}`
        : `lines ${violation.fromLine}-${violation.toLine}`;
    return [
      `${index}. ${violation.file} ${range}`,
      `   Rule: ${violation.rule}`,
      `   No single line identified: ${violation.unlocalised}`,
      `   Confidence: ${confidence(violation.confidence)}`,
    ].join("\n");
  }
  const where = violation.lines.map((line) => line.line).join(", ");
  return [
    `${index}. ${violation.file}:${where}`,
    `   Rule: ${violation.rule}`,
    ...violation.lines.map((line) => `   Line: ${trimQuoted(line.text)}`),
    `   Confidence: ${confidence(violation.confidence)}`,
  ].join("\n");
}

/** Plain text for the agent. No colours, no em dashes. */
export function renderReport(report: CheckReport): string {
  const { violations, notChecked, stats } = report;
  const sections: string[] = [];

  if (violations.length === 0) {
    sections.push(
      stats.chunks === 0
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
    sections.push(violations.map((violation, i) => violationBlock(violation, i + 1)).join("\n\n"));
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
