import { NO_CONTEXT, type AddedLine, type PieceContext, type SkippedFile } from "./types.js";

export const CHUNK_MAX_BYTES = 12_000;

/**
 * A diff line longer than this is data, not code: a minified bundle, a log record, a
 * base64 blob. Sending it costs a fortune in tokens and teaches Jev nothing, so the text
 * is replaced by a marker, so a piece never carries it.
 */
export const LONG_LINE_LIMIT = 1000;

export function longLineMarker(chars: number): string {
  return `<stop-rules left out a ${chars} character line here: data, not code>`;
}

const LONG_LINE_MARKER_RE = /^<stop-rules left out a \d+ character line here: data, not code>$/;

export function isLongLineMarker(text: string): boolean {
  return LONG_LINE_MARKER_RE.test(text);
}

const encoder = new TextEncoder();

/** Byte length of a string, without depending on Buffer. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

function baseName(filePath: string): string {
  const cut = filePath.lastIndexOf("/");
  return cut === -1 ? filePath : filePath.slice(cut + 1);
}

/** Generated content no coding rule is about. */
const SKIP_BASENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
  "Gemfile.lock",
  "composer.lock",
  // Our own two files: the rules being checked and the team endpoint. Configuration, not
  // code any rule is about.
  ".stop-rules.md",
  ".stop-rules.json",
]);

/** Generated code, and data or log formats that carry no coding rules. */
const SKIP_SUFFIXES = [
  ".min.js",
  ".min.css",
  ".map",
  ".snap",
  ".log",
  ".jsonl",
  ".ndjson",
  ".csv",
  ".tsv",
  ".svg",
  ".lock",
];

/** Our own vendored single file bundle and its state. Generated, and large. */
const OWN_DIR = ".stop-rules/";

/** Plugin files stop-rules generates itself. No rule of the team's is about them. */
const OWN_FILES = new Set([".opencode/plugins/stop-rules.ts", ".amp/plugins/stop-rules.ts"]);

export function isSkippedPath(filePath: string, extraSkip: readonly string[] = []): boolean {
  if (filePath.startsWith(OWN_DIR) || OWN_FILES.has(filePath)) return true;
  const base = baseName(filePath);
  if (SKIP_BASENAMES.has(base)) return true;
  if (SKIP_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;
  return extraSkip.includes(filePath);
}

export interface Hunk {
  oldStart: number;
  newStart: number;
  /** Section heading text that git puts after the second "@@", including its space. */
  context: string;
  /** Body lines, each still carrying its leading " ", "+", "-" or "\". */
  lines: string[];
}

export interface FileDiff {
  /** Path in the new version of the tree. */
  file: string;
  /** Lines from "diff --git" up to and including the "+++" line. */
  header: string[];
  hunks: Hunk[];
}

export interface Chunk {
  file: string;
  header: string[];
  hunks: Hunk[];
}

/**
 * A piece: one whole function, a run of statements and declarations, or one diff hunk when the
 * file has no grammar. This is what a question is asked about.
 */
export interface Piece extends Chunk {
  /**
   * The function's name, or "top-level code" for a run of statements and declarations. Null
   * when the piece was cut by hunk.
   */
  unitName: string | null;
  /** The new file lines this piece covers. */
  fromLine: number;
  toLine: number;
  cut: "unit" | "hunk" | "chunk";
  /**
   * The code around this piece that rides to Jev with it, built at cut time out of the new
   * file in the snapshot. The report always hands the agent the piece's own diff instead.
   */
  context: PieceContext;
}

/**
 * The old file line a hunk header names. Git writes the line before an insertion when the
 * hunk removes nothing, as in `@@ -0,0 +1,3 @@` for a new file.
 */
export function gitOldStart(cursor: number, oldCount: number): number {
  if (oldCount > 0) return cursor;
  return Math.max(cursor - 1, 0);
}

export function countOld(lines: readonly string[]): number {
  let n = 0;
  for (const line of lines) {
    if (line.startsWith(" ") || line.startsWith("-")) n += 1;
  }
  return n;
}

export function countNew(lines: readonly string[]): number {
  let n = 0;
  for (const line of lines) {
    if (line.startsWith(" ") || line.startsWith("+")) n += 1;
  }
  return n;
}

export function hunkHeader(hunk: Hunk): string {
  const oldCount = countOld(hunk.lines);
  const newCount = countNew(hunk.lines);
  return `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@${hunk.context}`;
}

export function hunkText(hunk: Hunk): string {
  return `${hunkHeader(hunk)}\n${hunk.lines.join("\n")}\n`;
}

export function chunkText(chunk: Chunk): string {
  return `${chunk.header.join("\n")}\n${chunk.hunks.map(hunkText).join("")}`;
}

/** One diff body line, with an over-long payload replaced by its marker. */
function shortenBodyLine(body: string): string {
  const marker = body[0];
  // Only ever called with a line that starts with " ", "+", "-" or "\".
  if (marker === undefined) throw new Error("internal error: an empty diff body line");
  const text = body.slice(1);
  if (text.length <= LONG_LINE_LIMIT) return body;
  return `${marker}${longLineMarker(text.length)}`;
}

/** Added lines of a chunk with their line number in the new file. */
export function addedLines(chunk: Chunk): AddedLine[] {
  const out: AddedLine[] = [];
  for (const hunk of chunk.hunks) {
    let lineNo = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        out.push({ line: lineNo, text: line.slice(1) });
        lineNo += 1;
      } else if (line.startsWith(" ")) {
        lineNo += 1;
      }
    }
  }
  return out;
}

/** New-file line range covered by a chunk, used for "not checked" messages. */
export function chunkRange(chunk: Chunk): { from: number; to: number } {
  let from = Number.POSITIVE_INFINITY;
  let to = 0;
  for (const hunk of chunk.hunks) {
    const newCount = countNew(hunk.lines);
    from = Math.min(from, hunk.newStart);
    to = Math.max(to, hunk.newStart + Math.max(newCount, 1) - 1);
  }
  if (!Number.isFinite(from)) return { from: 0, to: 0 };
  return { from, to };
}

export type PathRead = { ok: true; path: string } | { ok: false; reason: string };

const SIMPLE_ESCAPES: Record<string, number> = {
  '"': 0x22,
  "\\": 0x5c,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};

/**
 * Decodes the C style quoting git uses for a path with a space, a quote, a control
 * character or a byte outside ASCII (git's quote.c: octal escapes plus the simple ones
 * above). A path this cannot decode is reported, never half decoded.
 */
export function decodeQuotedPath(raw: string): PathRead {
  if (!raw.startsWith('"')) return { ok: true, path: raw };
  if (raw.length < 2 || !raw.endsWith('"')) {
    return { ok: false, reason: "git quoted this path but the closing quote is missing" };
  }
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain.length === 0) return;
    for (const byte of encoder.encode(plain)) bytes.push(byte);
    plain = "";
  };

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === undefined) break;
    if (char !== "\\") {
      plain += char;
      continue;
    }
    i += 1;
    const escape = body[i];
    if (escape === undefined) {
      return { ok: false, reason: "git quoted this path but a backslash escape is cut short" };
    }
    const simple = SIMPLE_ESCAPES[escape];
    if (simple !== undefined) {
      flush();
      bytes.push(simple);
      continue;
    }
    if (escape >= "0" && escape <= "7") {
      const digits = body.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(digits)) {
        return { ok: false, reason: `git quoted this path with an octal escape stop-rules cannot read: \\${digits}` };
      }
      flush();
      bytes.push(Number.parseInt(digits, 8));
      i += 2;
      continue;
    }
    return { ok: false, reason: `git quoted this path with an escape stop-rules does not know: \\${escape}` };
  }
  flush();

  try {
    return { ok: true, path: new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `this path is not valid UTF-8, so stop-rules cannot name it (${message})` };
  }
}

function stripPrefix(raw: string): PathRead {
  const read = decodeQuotedPath(raw);
  if (!read.ok) return read;
  if (read.path.startsWith("a/") || read.path.startsWith("b/")) {
    return { ok: true, path: read.path.slice(2) };
  }
  return read;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export interface ParsedDiff {
  files: FileDiff[];
  /** Files left out on purpose, with the reason. Not failures. */
  skipped: SkippedFile[];
  /** Files this parser could not handle. Real failures, reported as not checked. */
  failures: { file: string; reason: string }[];
}

/** Parses `git diff -U8` output into per-file diffs, dropping what no rule is about. */
export function parseDiff(diff: string, extraSkip: readonly string[] = []): ParsedDiff {
  const lines = diff.split("\n");
  const files: FileDiff[] = [];
  const skipped: SkippedFile[] = [];
  const failures: { file: string; reason: string }[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.startsWith("diff --git ")) {
      i += 1;
      continue;
    }
    const header: string[] = [line];
    let binary = false;
    let newPath: string | null = null;
    let deleted = false;
    let unreadablePath: { file: string; reason: string } | null = null;
    i += 1;

    // Extended header lines up to and including "+++", or up to the next file.
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (current.startsWith("diff --git ") || current.startsWith("@@ ")) break;
      header.push(current);
      i += 1;
      if (current.startsWith("Binary files ") || current.startsWith("GIT binary patch")) {
        binary = true;
        break;
      }
      if (current.startsWith("+++ ")) {
        const target = current.slice(4).trim();
        if (target === "/dev/null") {
          deleted = true;
        } else {
          const read = stripPrefix(target);
          if (read.ok) newPath = read.path;
          else unreadablePath = { file: target, reason: read.reason };
        }
        break;
      }
    }

    const hunks: Hunk[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (current.startsWith("diff --git ")) break;
      const match = HUNK_RE.exec(current);
      if (!match) {
        i += 1;
        continue;
      }
      const hunk: Hunk = {
        oldStart: Number(match[1]),
        newStart: Number(match[3]),
        context: match[5] ?? "",
        lines: [],
      };
      i += 1;
      while (i < lines.length) {
        const body = lines[i] ?? "";
        if (body.startsWith("diff --git ") || HUNK_RE.test(body)) break;
        if (
          body.startsWith(" ") ||
          body.startsWith("+") ||
          body.startsWith("-") ||
          body.startsWith("\\")
        ) {
          hunk.lines.push(shortenBodyLine(body));
          i += 1;
          continue;
        }
        if (body.length === 0) {
          // Trailing empty string from the final split, or a context line git emitted
          // without its leading space. Only the very last entry can be the former.
          if (i === lines.length - 1) {
            i += 1;
            break;
          }
          hunk.lines.push(" ");
          i += 1;
          continue;
        }
        break;
      }
      hunks.push(hunk);
    }

    if (unreadablePath !== null) {
      failures.push(unreadablePath);
      continue;
    }
    if (binary) {
      skipped.push({ file: newPath ?? headerPath(line, failures), reason: "binary file" });
      continue;
    }
    if (deleted || newPath === null) continue;
    if (isSkippedPath(newPath, extraSkip)) {
      skipped.push({ file: newPath, reason: "generated or data file" });
      continue;
    }
    const added = hunks.flatMap((hunk) => hunk.lines.filter((l) => l.startsWith("+")));
    if (added.length === 0) continue;
    if (added.every((l) => isLongLineMarker(l.slice(1)))) {
      skipped.push({ file: newPath, reason: "every added line is data, not code" });
      continue;
    }
    files.push({ file: newPath, header, hunks });
  }

  return { files, skipped, failures };
}

/**
 * The name to show for a file whose "+++" line never came, which happens for a binary one.
 * The only source left is the "diff --git a/x b/x" line. A name that cannot be read from it
 * is recorded as a failure and the raw line is shown.
 */
function headerPath(headerLine: string, failures: { file: string; reason: string }[]): string {
  const rest = headerLine.slice("diff --git ".length);
  const cut = rest.lastIndexOf(" b/");
  if (cut === -1) {
    failures.push({ file: rest, reason: "stop-rules could not find a file name in this diff header" });
    return rest;
  }
  const read = stripPrefix(rest.slice(cut + 1));
  if (read.ok) return read.path;
  failures.push({ file: rest, reason: read.reason });
  return rest;
}

/** Splits one hunk between lines, repeating an adjusted hunk header for each piece. */
export function splitHunk(hunk: Hunk, pieces: number): Hunk[] {
  if (pieces < 2 || hunk.lines.length < 2) return [hunk];
  const per = Math.ceil(hunk.lines.length / pieces);
  const out: Hunk[] = [];
  let oldCursor = hunk.oldStart;
  let newCursor = hunk.newStart;
  for (let start = 0; start < hunk.lines.length; start += per) {
    const slice = hunk.lines.slice(start, start + per);
    out.push({ oldStart: oldCursor, newStart: newCursor, context: hunk.context, lines: slice });
    oldCursor += countOld(slice);
    newCursor += countNew(slice);
  }
  return out;
}

function splitHunkToFit(hunk: Hunk, headerBytes: number): Hunk[] {
  const budget = Math.max(CHUNK_MAX_BYTES - headerBytes, 1);
  if (utf8Bytes(hunkText(hunk)) <= budget) return [hunk];
  if (hunk.lines.length < 2) return [hunk];
  let pieces = 2;
  for (;;) {
    const parts = splitHunk(hunk, pieces);
    const tooBig = parts.some((part) => utf8Bytes(hunkText(part)) > budget);
    if (!tooBig || pieces >= hunk.lines.length) return parts;
    pieces *= 2;
  }
}

/** A chunk is a file header plus consecutive hunks whose text fits the size limit. */
export function chunkFile(file: FileDiff): Chunk[] {
  const headerBytes = utf8Bytes(`${file.header.join("\n")}\n`);
  const fitted: Hunk[] = [];
  for (const hunk of file.hunks) {
    fitted.push(...splitHunkToFit(hunk, headerBytes));
  }

  const chunks: Chunk[] = [];
  let current: Hunk[] = [];
  let currentBytes = headerBytes;
  for (const hunk of fitted) {
    const size = utf8Bytes(hunkText(hunk));
    if (current.length > 0 && currentBytes + size > CHUNK_MAX_BYTES) {
      chunks.push({ file: file.file, header: file.header, hunks: current });
      current = [];
      currentBytes = headerBytes;
    }
    current.push(hunk);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push({ file: file.file, header: file.header, hunks: current });

  // A chunk with no added lines cannot violate a claim about added lines.
  return chunks.filter((chunk) => chunk.hunks.some((h) => h.lines.some((l) => l.startsWith("+"))));
}

/**
 * Halves a piece for a resend after max_tokens_exceeded, the same way a chunk is halved.
 * Null when it cannot shrink any further. A half carries no code around it: the whole point
 * of the halving is that the call was too long for Jev, and half a piece's window belongs to
 * the piece, not to the half.
 */
export function halvePiece(piece: Piece): [Piece, Piece] | null {
  const halves = halveChunk(piece);
  if (halves === null) return null;
  return [asPiece(piece, halves[0]), asPiece(piece, halves[1])];
}

function asPiece(original: Piece, part: Chunk): Piece {
  const range = chunkRange(part);
  return {
    file: part.file,
    header: part.header,
    hunks: part.hunks,
    unitName: original.unitName,
    fromLine: range.from,
    toLine: range.to,
    cut: original.cut,
    context: NO_CONTEXT,
  };
}

/** Halves a chunk for a resend after max_tokens_exceeded. Null when it cannot shrink. */
export function halveChunk(chunk: Chunk): [Chunk, Chunk] | null {
  if (chunk.hunks.length > 1) {
    const mid = Math.ceil(chunk.hunks.length / 2);
    return [
      { file: chunk.file, header: chunk.header, hunks: chunk.hunks.slice(0, mid) },
      { file: chunk.file, header: chunk.header, hunks: chunk.hunks.slice(mid) },
    ];
  }
  const only = chunk.hunks[0];
  if (only === undefined || only.lines.length < 2) return null;
  const parts = splitHunk(only, 2);
  const first = parts[0];
  const second = parts[1];
  if (first === undefined || second === undefined) return null;
  return [
    { file: chunk.file, header: chunk.header, hunks: [first] },
    { file: chunk.file, header: chunk.header, hunks: [second] },
  ];
}
