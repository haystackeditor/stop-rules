/**
 * Cutting a file's diff into pieces.
 *
 * A piece is one or more whole syntactic units of one file: a function, a method, a
 * constructor, a top level assigned lambda, a class member, or, when an added line sits in
 * none of those, the enclosing top level statement. Units are walked in file order and
 * merged with their neighbours until the next one would push the piece past 40 added lines.
 * A unit is never split to make a piece fit; a unit that is itself over 40 added lines is cut
 * at the boundaries between its direct child statements first.
 *
 * Two rules here were found the hard way on 240 real agent written changes and must stay:
 *
 *  1. Subtract inner unit spans from a container unit. An added line on `class Foo {` has no
 *     enclosing function, so its unit is the whole class, whose span contains the method
 *     units other added lines chose. Taken literally an added line would sit in two pieces.
 *     The container keeps only its header, the gaps between members and its closing brace.
 *  2. A blank or punctuation only added line carries nothing to judge, so it never forms a
 *     piece of its own: it folds into a neighbouring piece.
 *
 * No tree-sitter code runs here: the parsed tree arrives as an argument, so this file is
 * plain logic and the Node layer owns the parser.
 */

import type { Node } from "web-tree-sitter";
import {
  countNew,
  countOld,
  gitOldStart,
  type FileDiff,
  type Hunk,
  type Piece,
} from "./diff.js";
import { MAX_ADDED_PER_PIECE, type UnitTable } from "./languages.js";

/** One line of a file's diff, placed in both the old and the new file. */
interface DiffLine {
  raw: string;
  kind: "+" | "-" | " " | "\\";
  newPos: number | null;
  /** New file line this position sits at. For a removed line, the line it comes before. */
  anchor: number;
  /** Next old file line to be consumed at this point, for a truthful hunk header. */
  oldCursor: number;
  /** Which hunk this line came from. Runs never cross hunks. */
  hunk: number;
}

function flatten(file: FileDiff): DiffLine[] {
  const out: DiffLine[] = [];
  file.hunks.forEach((hunk, hunkIndex) => {
    let newLine = hunk.newStart;
    let oldLine = hunk.oldStart;
    for (const raw of hunk.lines) {
      const marker = raw[0];
      if (marker === "+") {
        out.push({ raw, kind: "+", newPos: newLine, anchor: newLine, oldCursor: oldLine, hunk: hunkIndex });
        newLine += 1;
      } else if (marker === "-") {
        out.push({ raw, kind: "-", newPos: null, anchor: newLine, oldCursor: oldLine, hunk: hunkIndex });
        oldLine += 1;
      } else if (marker === "\\") {
        out.push({ raw, kind: "\\", newPos: null, anchor: newLine, oldCursor: oldLine, hunk: hunkIndex });
      } else {
        out.push({ raw, kind: " ", newPos: newLine, anchor: newLine, oldCursor: oldLine, hunk: hunkIndex });
        newLine += 1;
        oldLine += 1;
      }
    }
  });
  return out;
}

/** True when this node is one of the grammar's class or module bodies. */
function isBody(node: Node | null, table: UnitTable): boolean {
  if (node === null || !table.bodies.includes(node.type)) return false;
  const required = table.bodiesParent[node.type];
  if (required === undefined) return true;
  const parent = node.parent;
  return parent === null ? false : required.includes(parent.type);
}

/** A lambda counts as a unit only when it is assigned at the top level or in a body. */
function isTopLevelAssignedLambda(node: Node, table: UnitTable, root: Node): boolean {
  let parent = node.parent;
  for (let hops = 0; parent !== null && hops < 6; hops += 1) {
    if (
      table.wrappers.includes(parent.type) ||
      table.member.includes(parent.type) ||
      parent.type === "variable_declarator" ||
      parent.type === "assignment"
    ) {
      const grand = parent.parent;
      if (grand !== null && (grand.id === root.id || isBody(grand, table))) return true;
      parent = parent.parent;
      continue;
    }
    return false;
  }
  return false;
}

type UnitKind = "fn" | "member" | "lambda";

function qualifies(node: Node, table: UnitTable, root: Node): UnitKind | null {
  if (table.fn.includes(node.type)) return "fn";
  if (table.member.includes(node.type)) {
    if (!table.memberOnlyInBody) return "member";
    return isBody(node.parent, table) ? "member" : null;
  }
  if (table.lambda.includes(node.type) && isTopLevelAssignedLambda(node, table, root)) {
    return "lambda";
  }
  return null;
}

/** Takes the wrapper around a unit, so `export`, a decorator or `const x =` stays in. */
function promote(node: Node, table: UnitTable): Node {
  let current = node;
  for (;;) {
    const parent = current.parent;
    if (parent === null || !table.wrappers.includes(parent.type)) return current;
    if (parent.startPosition.row > current.startPosition.row) return current;
    current = parent;
  }
}

/** The child of `parent` that a row falls in, or the first one after it. */
function nearestChild(parent: Node, row: number): Node | null {
  let best: Node | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let after: Node | null = null;
  for (let i = 0; i < parent.namedChildCount; i += 1) {
    const child = parent.namedChild(i);
    if (child === null) continue;
    if (child.startPosition.row > row && after === null) after = child;
    const distance =
      child.startPosition.row > row ? child.startPosition.row - row : row - child.endPosition.row;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = child;
    }
  }
  return after ?? best;
}

interface FoundUnit {
  node: Node;
  kind: string;
}

/** The unit an added line belongs to. */
function findUnit(root: Node, table: UnitTable, row: number, column: number): FoundUnit | null {
  let node = root.descendantForPosition({ row, column }) ?? root;

  // A line inside a doc comment or an attribute belongs to the item that follows it.
  const prefix = table.attachPrefix.includes(node.type)
    ? node
    : node.parent !== null && table.attachPrefix.includes(node.parent.type)
      ? node.parent
      : null;
  if (prefix !== null) {
    let sibling = prefix.nextNamedSibling;
    while (sibling !== null && table.attachPrefix.includes(sibling.type)) {
      sibling = sibling.nextNamedSibling;
    }
    if (sibling !== null) node = sibling;
  }

  for (let candidate: Node | null = node; candidate !== null; candidate = candidate.parent) {
    const kind = qualifies(candidate, table, root);
    if (kind !== null) return { node: promote(candidate, table), kind };
  }

  // No enclosing function or member: the enclosing top level statement or declaration.
  let current = node;
  if (current.id === root.id) {
    const child = nearestChild(root, row);
    if (child === null) return null;
    current = child;
  } else {
    for (;;) {
      const parent = current.parent;
      if (parent === null) break;
      if (parent.id === root.id || isBody(parent, table)) break;
      current = parent;
    }
  }
  const unit = promote(current, table);
  return { node: unit, kind: `toplevel:${unit.type}` };
}

const NAME_FIELDS = ["name", "declarator", "pattern", "property"];
/** How far below a unit to look for its name. A wrapper such as `export` holds it one down. */
const NAME_DEPTH = 2;

function namedField(node: Node): string | null {
  for (const field of NAME_FIELDS) {
    const child = node.childForFieldName(field);
    if (child === null) continue;
    const text = (child.text.split("\n")[0] ?? "").trim();
    if (text.length > 0) return text.slice(0, 120);
  }
  return null;
}

/**
 * A short name for the unit, for the report. `export function pay()` keeps the name of the
 * function inside the export, and anything with no name at all shows its first line.
 */
function unitName(node: Node): string {
  let level: Node[] = [node];
  for (let depth = 0; depth <= NAME_DEPTH && level.length > 0; depth += 1) {
    for (const current of level) {
      const name = namedField(current);
      if (name !== null) return name;
    }
    const next: Node[] = [];
    for (const current of level) {
      for (let i = 0; i < current.namedChildCount; i += 1) {
        const child = current.namedChild(i);
        if (child !== null) next.push(child);
      }
    }
    level = next;
  }
  const firstLine = (node.text.split("\n")[0] ?? "").trim();
  return firstLine.replace(/\s*\{$/, "").slice(0, 120);
}

/** The unit's first row, pulled back over the doc comments or attributes above it. */
function extendedStartRow(node: Node, table: UnitTable): number {
  let row = node.startPosition.row;
  let sibling = node.previousNamedSibling;
  while (
    sibling !== null &&
    table.attachPrefix.includes(sibling.type) &&
    sibling.endPosition.row === row - 1
  ) {
    row = sibling.startPosition.row;
    sibling = sibling.previousNamedSibling;
  }
  return row;
}

/** The statement list inside a unit, whose children are where an over-long unit is cut. */
function stmtContainer(node: Node, table: UnitTable): Node | null {
  const queue: Node[] = [node];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (current.id !== node.id && table.stmtContainers.includes(current.type)) return current;
    for (let i = 0; i < current.childCount; i += 1) {
      const child = current.child(i);
      if (child !== null) queue.push(child);
    }
  }
  return table.stmtContainers.includes(node.type) ? node : null;
}

interface Span {
  start: number;
  end: number;
  unitStart: number;
  name: string;
  kind: string;
  node: Node;
}

function countIn(numbers: readonly number[], from: number, to: number): number {
  let n = 0;
  for (const value of numbers) if (value >= from && value <= to) n += 1;
  return n;
}

const SUBSTANTIVE = /[A-Za-z0-9_]/;

/** Every ERROR or missing node's row range, so a caller can see what failed to parse. */
export function errorRows(root: Node): number[] {
  const rows: number[] = [];
  const walk = (node: Node): void => {
    if (node.type === "ERROR" || node.isMissing) {
      for (let row = node.startPosition.row; row <= node.endPosition.row; row += 1) {
        rows.push(row + 1);
      }
    }
    for (let i = 0; i < node.childCount; i += 1) {
      const child = node.child(i);
      if (child !== null) walk(child);
    }
  };
  walk(root);
  return rows;
}

/** One piece under construction: the units it holds and the diff lines they cover. */
interface Atom {
  span: Span;
  indexes: number[];
  added: number[];
  firstLine: string;
}

function makeHunk(lines: readonly DiffLine[], context: string): Hunk {
  const first = lines[0];
  if (first === undefined) throw new Error("internal error: a piece hunk with no lines");
  const raws = lines.map((line) => line.raw);
  const oldCount = countOld(raws);
  let newStart = first.anchor;
  for (const line of lines) {
    if (line.newPos !== null) {
      newStart = line.newPos;
      break;
    }
  }
  return {
    oldStart: gitOldStart(first.oldCursor, oldCount),
    newStart,
    context: ` ${context}`,
    lines: raws,
  };
}

/**
 * Cuts one file's diff into pieces, using the parsed new file. Throws when an added line
 * would land in no piece or in two, because that is a bug in this file and not something to
 * paper over at run time.
 */
export function buildPieces(
  file: FileDiff,
  source: string,
  table: UnitTable,
  root: Node,
): Piece[] {
  const diff = flatten(file);
  const sourceLines = source.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const addedNumbers: number[] = [];
  const substantive = new Set<number>();
  for (const line of diff) {
    if (line.kind !== "+" || line.newPos === null) continue;
    addedNumbers.push(line.newPos);
    if (SUBSTANTIVE.test(line.raw.slice(1))) substantive.add(line.newPos);
  }
  if (addedNumbers.length === 0) return [];

  // 1. One unit per added line. A whitespace only line never picks a unit of its own.
  const units = new Map<string, FoundUnit>();
  for (const line of diff) {
    if (line.kind !== "+" || line.newPos === null) continue;
    const text = line.raw.slice(1);
    if (text.trim().length === 0) continue;
    const column = text.length - text.trimStart().length;
    const found = findUnit(root, table, line.newPos - 1, column);
    if (found === null) continue;
    const key = `${found.node.startIndex}:${found.node.endPosition.row}:${found.node.type}`;
    if (!units.has(key)) units.set(key, found);
  }
  if (units.size === 0) units.set("whole", { node: root, kind: `toplevel:${root.type}` });

  // 2. Spans, with inner unit spans subtracted from the units that contain them.
  const base = [...units.values()].map((unit) => ({
    kind: unit.kind,
    node: unit.node,
    name: unitName(unit.node),
    start: extendedStartRow(unit.node, table) + 1,
    end: unit.node.endPosition.row + 1,
  }));
  let spans: Span[] = [];
  for (const unit of base) {
    const inside = base
      .filter(
        (other) =>
          other !== unit &&
          other.start >= unit.start &&
          other.end <= unit.end &&
          !(other.start === unit.start && other.end === unit.end),
      )
      // Keep only the outermost of a nest, so a method inside a class inside a file counts
      // once against the class and not again against the file.
      .filter(
        (other) =>
          !base.some(
            (middle) =>
              middle !== unit &&
              middle !== other &&
              middle.start >= unit.start &&
              middle.end <= unit.end &&
              other.start >= middle.start &&
              other.end <= middle.end &&
              !(middle.start === other.start && middle.end === other.end),
          ),
      )
      .sort((a, b) => a.start - b.start);
    if (inside.length === 0) {
      spans.push({ ...unit, unitStart: unit.start });
      continue;
    }
    let at = unit.start;
    for (const other of inside) {
      if (other.start > at) spans.push({ ...unit, start: at, end: other.start - 1, unitStart: unit.start });
      at = Math.max(at, other.end + 1);
    }
    if (at <= unit.end) spans.push({ ...unit, start: at, end: unit.end, unitStart: unit.start });
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < spans.length; i += 1) {
    const previous = spans[i - 1];
    const current = spans[i];
    if (previous === undefined || current === undefined) continue;
    if (current.start <= previous.end) current.start = previous.end + 1;
  }
  spans = spans.filter((span) => span.start <= span.end);

  // 3. An added line between two spans joins the nearer one, so none is left out.
  for (const number of addedNumbers) {
    if (spans.some((span) => number >= span.start && number <= span.end)) continue;
    let after: Span | null = null;
    let before: Span | null = null;
    for (const span of spans) {
      if (span.start > number && after === null) after = span;
      if (span.end < number) before = span;
    }
    const toAfter = after === null ? Number.POSITIVE_INFINITY : after.start - number;
    const toBefore = before === null ? Number.POSITIVE_INFINITY : number - before.end;
    if (after !== null && toAfter <= toBefore) after.start = number;
    else if (before !== null) before.end = number;
    else {
      const only = spans[0];
      if (only === undefined) throw new Error(`internal error: no span to hold line ${number} of ${file.file}`);
      only.start = Math.min(only.start, number);
      only.end = Math.max(only.end, number);
    }
  }

  // 4. A span whose added lines are all blank or punctuation folds into a neighbour.
  for (;;) {
    if (spans.length <= 1) break;
    const index = spans.findIndex(
      (span) =>
        !addedNumbers.some(
          (number) => number >= span.start && number <= span.end && substantive.has(number),
        ),
    );
    if (index < 0) break;
    const span = spans[index];
    const next = spans[index + 1];
    const previous = spans[index - 1];
    if (span === undefined) break;
    if (next !== undefined) next.start = Math.min(next.start, span.start);
    else if (previous !== undefined) previous.end = Math.max(previous.end, span.end);
    else break;
    spans.splice(index, 1);
  }

  // 5. A unit over 40 added lines is cut between its direct child statements.
  const unitSpans: Span[] = [];
  for (const span of spans) {
    if (countIn(addedNumbers, span.start, span.end) <= MAX_ADDED_PER_PIECE) {
      unitSpans.push(span);
      continue;
    }
    const container = stmtContainer(span.node, table);
    const cuts: number[] = [];
    if (container !== null) {
      for (let i = 0; i < container.namedChildCount; i += 1) {
        const child = container.namedChild(i);
        if (child === null) continue;
        const row = extendedStartRow(child, table) + 1;
        if (row > span.start && row <= span.end && !cuts.includes(row)) cuts.push(row);
      }
    }
    cuts.sort((a, b) => a - b);
    if (cuts.length === 0) {
      // A single child statement over 40 added lines stays whole, as the spec says.
      unitSpans.push(span);
      continue;
    }
    const bounds = [span.start, ...cuts, span.end + 1];
    let current: Span | null = null;
    for (let i = 0; i + 1 < bounds.length; i += 1) {
      const start = bounds[i];
      const next = bounds[i + 1];
      if (start === undefined || next === undefined) continue;
      const segment = { start, end: next - 1 };
      const segmentAdded = countIn(addedNumbers, segment.start, segment.end);
      if (current === null) {
        current = { ...span, ...segment };
        continue;
      }
      const currentAdded = countIn(addedNumbers, current.start, current.end);
      if (currentAdded > 0 && currentAdded + segmentAdded > MAX_ADDED_PER_PIECE) {
        unitSpans.push(current);
        current = { ...span, ...segment };
      } else {
        current.end = segment.end;
      }
    }
    if (current !== null) unitSpans.push(current);
  }
  unitSpans.sort((a, b) => a.start - b.start);

  // 6. The diff lines of each unit. A removed line goes to the first unit that can hold it.
  const usedRemoved = new Set<number>();
  const atoms: Atom[] = [];
  for (const span of unitSpans) {
    const indexes: number[] = [];
    const added: number[] = [];
    diff.forEach((line, index) => {
      if (line.newPos !== null) {
        if (line.newPos >= span.start && line.newPos <= span.end) {
          indexes.push(index);
          if (line.kind === "+") added.push(line.newPos);
        }
        return;
      }
      if (usedRemoved.has(index)) return;
      const anchor = line.anchor;
      if ((anchor - 1 >= span.start && anchor - 1 <= span.end) || (anchor >= span.start && anchor <= span.end)) {
        indexes.push(index);
        usedRemoved.add(index);
      }
    });
    if (added.length === 0) continue;
    atoms.push({
      span,
      indexes,
      added,
      firstLine: (sourceLines[span.unitStart - 1] ?? "").trim(),
    });
  }

  // 7. Greedy merge of neighbouring whole units, at most 40 added lines per piece.
  const groups: { atoms: Atom[]; added: number[]; indexes: number[] }[] = [];
  for (const atom of atoms) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.added.length + atom.added.length <= MAX_ADDED_PER_PIECE) {
      last.atoms.push(atom);
      last.added.push(...atom.added);
      last.indexes.push(...atom.indexes);
    } else {
      groups.push({ atoms: [atom], added: [...atom.added], indexes: [...atom.indexes] });
    }
  }

  // 8. Piece text: one hunk per contiguous run of the file's diff.
  const pieces: Piece[] = [];
  for (const group of groups) {
    const indexes = [...new Set(group.indexes)].sort((a, b) => a - b);
    const runs: number[][] = [];
    for (const index of indexes) {
      const last = runs[runs.length - 1];
      const previous = last === undefined ? undefined : last[last.length - 1];
      const line = diff[index];
      const previousLine = previous === undefined ? undefined : diff[previous];
      if (
        last !== undefined &&
        previous !== undefined &&
        index === previous + 1 &&
        line !== undefined &&
        previousLine !== undefined &&
        line.hunk === previousLine.hunk
      ) {
        last.push(index);
      } else {
        runs.push([index]);
      }
    }
    const hunks: Hunk[] = [];
    for (const run of runs) {
      const lines = run.map((index) => diff[index]).filter((line): line is DiffLine => line !== undefined);
      const first = lines[0];
      if (first === undefined) continue;
      let at = first.anchor;
      for (const line of lines) {
        if (line.newPos !== null) {
          at = line.newPos;
          break;
        }
      }
      const owner =
        group.atoms.find((atom) => at >= atom.span.start && at <= atom.span.end) ?? group.atoms[0];
      if (owner === undefined) throw new Error("internal error: a piece with no unit");
      hunks.push(makeHunk(lines, owner.firstLine));
    }
    const firstAtom = group.atoms[0];
    if (firstAtom === undefined) throw new Error("internal error: a piece group with no unit");
    pieces.push({
      file: file.file,
      header: file.header,
      hunks,
      unitName: firstAtom.span.name,
      fromLine: Math.min(...group.atoms.map((atom) => atom.span.start)),
      toLine: Math.max(...group.atoms.map((atom) => atom.span.end)),
      cut: "unit",
    });
  }

  assertEveryAddedLineOnce(file.file, addedNumbers, pieces);
  return pieces;
}

/** Added line numbers a piece holds, read back out of the piece's own text. */
function addedOf(piece: Piece): number[] {
  const out: number[] = [];
  for (const hunk of piece.hunks) {
    let line = hunk.newStart;
    for (const raw of hunk.lines) {
      const marker = raw[0];
      if (marker === "+") {
        out.push(line);
        line += 1;
      } else if (marker === " ") {
        line += 1;
      }
    }
  }
  return out;
}

/**
 * Every added line lands in exactly one piece. A violation is a bug in this file, so the run
 * stops with a plain message instead of checking part of the change and saying nothing.
 */
export function assertEveryAddedLineOnce(
  file: string,
  addedNumbers: readonly number[],
  pieces: readonly Piece[],
): void {
  const seen = new Map<number, number>();
  for (const piece of pieces) {
    for (const number of addedOf(piece)) seen.set(number, (seen.get(number) ?? 0) + 1);
  }
  const missing = addedNumbers.filter((number) => !seen.has(number));
  const twice = [...seen.entries()].filter(([, count]) => count > 1).map(([number]) => number);
  const extra = [...seen.keys()].filter((number) => !addedNumbers.includes(number));
  if (missing.length === 0 && twice.length === 0 && extra.length === 0) return;
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`${missing.length} in no piece (first ${missing[0]})`);
  if (twice.length > 0) parts.push(`${twice.length} in two pieces (first ${twice[0]})`);
  if (extra.length > 0) parts.push(`${extra.length} in a piece but not added (first ${extra[0]})`);
  throw new Error(
    `stop-rules cut ${file} wrongly: ${parts.join(", ")}. This is a bug in stop-rules, please report it.`,
  );
}

/**
 * Files with no grammar are cut by diff hunk. A hunk over 40 added lines is cut after the
 * 40th added line.
 */
export function piecesByHunk(file: FileDiff): Piece[] {
  const pieces: Piece[] = [];
  const addedNumbers: number[] = [];
  for (const hunk of file.hunks) {
    let newLine = hunk.newStart;
    let oldLine = hunk.oldStart;
    let segment: string[] = [];
    let segmentNewStart = newLine;
    let segmentOldStart = oldLine;
    let addedInSegment = 0;

    const flush = (): void => {
      if (segment.length === 0) return;
      if (addedInSegment > 0) {
        pieces.push({
          file: file.file,
          header: file.header,
          hunks: [
            {
              oldStart: gitOldStart(segmentOldStart, countOld(segment)),
              newStart: segmentNewStart,
              context: hunk.context,
              lines: segment,
            },
          ],
          unitName: null,
          fromLine: segmentNewStart,
          toLine: segmentNewStart + Math.max(countNew(segment), 1) - 1,
          cut: "hunk",
        });
      }
      segment = [];
      addedInSegment = 0;
      segmentNewStart = newLine;
      segmentOldStart = oldLine;
    };

    for (const raw of hunk.lines) {
      if (addedInSegment >= MAX_ADDED_PER_PIECE && raw.startsWith("+")) flush();
      segment.push(raw);
      const marker = raw[0];
      if (marker === "+") {
        addedNumbers.push(newLine);
        addedInSegment += 1;
        newLine += 1;
      } else if (marker === "-") {
        oldLine += 1;
      } else if (marker !== "\\") {
        newLine += 1;
        oldLine += 1;
      }
    }
    flush();
  }
  assertEveryAddedLineOnce(file.file, addedNumbers, pieces);
  return pieces;
}
