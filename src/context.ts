/**
 * The code around a change, which is what Jev is sent beside the diff.
 *
 * Measured on the workbench on 20 September 2026, over 240 real agent written changes with
 * blind labels and adjudications: the same piece with 25 unchanged lines above and below the
 * changed lines caught 21 of 31 real breaks with 7 plainly false flags, against 23 of 31 with
 * 10 plainly false for the piece on its own, and it newly flagged 7 of 1,358 clean pairs. It
 * needs no parser: only the hunk's own line numbers and the new file's text.
 *
 * In `functions` mode a piece that is one function carries the whole function after the
 * change instead, which measured about the same and is what the parser is already there for.
 * A piece of statements and declarations in that mode carries the wide form.
 *
 * Plain logic, no Node-only imports: the file text arrives as an argument, and the Node layer
 * reads it out of the snapshot tree.
 */

import { hunkText, LONG_LINE_LIMIT, longLineMarker, type Chunk, type Hunk } from "./diff.js";
import type { PieceContext, PieceFunction } from "./types.js";

/**
 * How many unchanged lines ride above and below the changed lines, and the one place this
 * number is written. 25 is the width that was measured.
 */
export const CONTEXT_LINES = 25;

/** The new file's lines, without the empty string a trailing newline leaves behind. */
export function fileLines(fileText: string): string[] {
  const lines = fileText.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** One line of code, with a line too long to be code replaced by its marker. */
function shorten(text: string): string {
  return text.length <= LONG_LINE_LIMIT ? text : longLineMarker(text.length);
}

/** An unchanged line as a diff body line. */
function contextLine(text: string): string {
  return ` ${shorten(text)}`;
}

/** A run of the new file as plain code, for the whole function form. */
export function codeText(lines: readonly string[], fromLine: number, toLine: number): string {
  return lines
    .slice(fromLine - 1, toLine)
    .map(shorten)
    .join("\n");
}

/** The whole function after the change, which is what `functions` mode sends. */
export function functionContext(functions: readonly PieceFunction[]): PieceContext {
  return { kind: "function", functions: [...functions] };
}

/** The changed lines of one hunk, with where they sit in the old and the new file. */
interface Core {
  /** Body lines from the first changed line to the last, markers and all. */
  lines: string[];
  /** New file line of the first of them. */
  newStart: number;
  /** Old file line of the first of them. */
  oldStart: number;
  /** New file line just after the last of them. */
  newEnd: number;
  /** The section heading git put after the second "@@", including its space. */
  context: string;
}

/**
 * The changed run of a hunk. Null when the hunk holds no added or removed line at all, which
 * happens only to a piece of pure context split off a very large hunk: there is no change in
 * it to widen around, so the hunk is passed through as it is.
 */
function coreOf(hunk: Hunk): Core | null {
  let oldAt = hunk.oldStart;
  let newAt = hunk.newStart;
  const rows = hunk.lines.map((text) => {
    const marker = text.charAt(0);
    const oldBefore = oldAt;
    const newBefore = newAt;
    if (marker === " ") {
      oldAt += 1;
      newAt += 1;
    } else if (marker === "-") {
      oldAt += 1;
    } else if (marker === "+") {
      newAt += 1;
    }
    // A "\ No newline at end of file" marker moves neither cursor.
    return { marker, text, oldBefore, newBefore, newAfter: newAt };
  });

  let first = -1;
  let last = -1;
  rows.forEach((row, index) => {
    if (row.marker !== "+" && row.marker !== "-") return;
    if (first < 0) first = index;
    last = index;
  });
  if (first < 0) return null;
  // A "no newline" marker right after the change belongs with it.
  while (last + 1 < rows.length && rows[last + 1]?.marker === "\\") last += 1;

  const head = rows[first];
  const tail = rows[last];
  if (head === undefined || tail === undefined) return null;
  return {
    lines: rows.slice(first, last + 1).map((row) => row.text),
    newStart: head.newBefore,
    oldStart: head.oldBefore,
    newEnd: tail.newAfter,
    context: hunk.context,
  };
}

/** One window of the new file: the change plus the unchanged lines kept around it. */
interface Window {
  oldStart: number;
  newStart: number;
  body: string[];
  /** New file line just after the last body line. */
  newEnd: number;
  context: string;
}

function render(window: Window): string {
  const oldCount = window.body.filter((line) => line.startsWith(" ") || line.startsWith("-")).length;
  const newCount = window.body.filter((line) => line.startsWith(" ") || line.startsWith("+")).length;
  // Git's own convention for a hunk that removes nothing: name the line before the insertion.
  const oldStart = oldCount === 0 ? Math.max(window.oldStart - 1, 0) : window.oldStart;
  const header = `@@ -${oldStart},${oldCount} +${window.newStart},${newCount} @@${window.context}`;
  return `${header}\n${window.body.join("\n")}\n`;
}

/**
 * The piece's diff with `CONTEXT_LINES` unchanged lines above and below each change, taken
 * straight from the new file, with a recomputed `@@` header. Ported from the workbench's
 * `buildWideHunk`, which measured this, and widened there to a piece that carries more than
 * one hunk: a window never runs into the next change or back over the previous one, and two
 * windows that meet become one hunk, so no line is shown twice and no added line is ever
 * shown as unchanged.
 */
export function widePieceText(piece: Chunk, fileText: string): string {
  const lines = fileLines(fileText);
  const cores = piece.hunks.map(coreOf);
  const rendered: string[] = [];
  let open: Window | null = null;
  /** New file line just after the last line already shown, so nothing is shown twice. */
  let shownTo = 1;

  const flush = (): void => {
    if (open === null) return;
    rendered.push(render(open));
    open = null;
  };

  piece.hunks.forEach((hunk, index) => {
    const core = cores[index];
    if (core === null || core === undefined) {
      flush();
      rendered.push(hunkText(hunk));
      return;
    }
    let nextChange = lines.length + 1;
    for (let after = index + 1; after < cores.length; after += 1) {
      const later = cores[after];
      if (later === null || later === undefined) continue;
      nextChange = later.newStart;
      break;
    }
    const aboveFrom = Math.max(core.newStart - CONTEXT_LINES, shownTo, 1);
    const belowTo = Math.min(core.newEnd + CONTEXT_LINES, nextChange, lines.length + 1);
    const above = lines.slice(aboveFrom - 1, core.newStart - 1).map(contextLine);
    const below = lines.slice(core.newEnd - 1, belowTo - 1).map(contextLine);
    const held = open;
    if (held !== null && held.newEnd === aboveFrom) {
      held.body.push(...above, ...core.lines, ...below);
      held.newEnd = belowTo;
    } else {
      flush();
      open = {
        oldStart: core.oldStart - above.length,
        newStart: aboveFrom,
        body: [...above, ...core.lines, ...below],
        newEnd: belowTo,
        context: core.context,
      };
    }
    shownTo = belowTo;
  });
  flush();

  return `${piece.header.join("\n")}\n${rendered.join("")}`;
}

/** The wide form of a piece, ready to hang on it. */
export function wideContext(piece: Chunk, fileText: string): PieceContext {
  return { kind: "wide", diff: widePieceText(piece, fileText) };
}
