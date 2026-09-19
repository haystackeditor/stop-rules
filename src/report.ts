import type { CheckReport, NotChecked, Violation } from "./types.js";

function confidence(score: number): string {
  return score.toFixed(2);
}

function notCheckedLine(entry: NotChecked): string {
  const where =
    entry.fromLine === entry.toLine
      ? `line ${entry.fromLine}`
      : `lines ${entry.fromLine}-${entry.toLine}`;
  return `${entry.file} ${where}: ${entry.reason}`;
}

function violationBlock(violation: Violation, index: number): string {
  const approximate = violation.approximate ? " (approximate line)" : "";
  return [
    `${index}. ${violation.file}:${violation.line}${approximate}`,
    `   Rule: ${violation.rule}`,
    `   Line: ${violation.lineText}`,
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
