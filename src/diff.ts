import type { AddedLine } from "./types.js";

export const CHUNK_MAX_BYTES = 12_000;

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
  ".stop-rules.md",
]);

const SKIP_SUFFIXES = [".min.js", ".min.css", ".map", ".snap"];

export function isSkippedPath(filePath: string, extraSkip: readonly string[] = []): boolean {
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

function countOld(lines: readonly string[]): number {
  let n = 0;
  for (const line of lines) {
    if (line.startsWith(" ") || line.startsWith("-")) n += 1;
  }
  return n;
}

function countNew(lines: readonly string[]): number {
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

function unquotePath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  try {
    // git quotes unusual paths in C style, which JSON parses for the common cases.
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : raw;
  } catch {
    // A path git escaped in a way JSON does not accept. Keep the raw form rather than
    // dropping the file; the path only ever reaches the report and the Jev state.
    return raw.slice(1, -1);
  }
}

function stripPrefix(raw: string): string {
  const p = unquotePath(raw);
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Parses `git diff -U8` output into per-file diffs, dropping what no rule is about. */
export function parseDiff(diff: string, extraSkip: readonly string[] = []): FileDiff[] {
  const lines = diff.split("\n");
  const files: FileDiff[] = [];
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
        if (target === "/dev/null") deleted = true;
        else newPath = stripPrefix(target);
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
          hunk.lines.push(body);
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

    if (binary || deleted || newPath === null) continue;
    if (isSkippedPath(newPath, extraSkip)) continue;
    const hasAdded = hunks.some((h) => h.lines.some((l) => l.startsWith("+")));
    if (!hasAdded) continue;
    files.push({ file: newPath, header, hunks });
  }

  return files;
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
