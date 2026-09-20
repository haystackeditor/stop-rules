/**
 * The Node layer that turns a diff into pieces.
 *
 * In `functions` mode each changed file is read out of the snapshot tree, parsed with the
 * grammar for its extension, and cut into whole functions. A file with no grammar is cut by
 * diff hunk. A file whose grammar is not installed, or that will not parse, is reported as
 * not checked.
 *
 * In `hunks` mode no parser runs at all: every file is cut into one piece per diff hunk. In
 * `chunks` mode, also with no parser, a file's hunks are grouped into pieces of up to 12,000
 * bytes. Nothing here guesses and nothing falls back.
 */

import { addedLines, chunkRange, type FileDiff, type Piece } from "./diff.js";
import { extensionOf, grammarForPath, GRAMMAR_TITLE, TABLES, type GrammarKey } from "./languages.js";
import { buildPieces, chunkPieces, errorRows, piecesByHunk } from "./pieces.js";
import { parseSource } from "./treesitter.js";
import type { CutByHunk, CutMode, NotChecked } from "./types.js";

export interface CutResult {
  pieces: Piece[];
  notChecked: NotChecked[];
  cutByHunk: CutByHunk[];
}

/** Where a file's new content comes from. Null means the source could not be read. */
export type ReadSource = (file: string) => Promise<string | null>;

export interface CutOptions {
  cut: CutMode;
  /** Only used in functions mode, where a file has to be parsed to be cut. */
  readSource: ReadSource;
}

function describeExtension(filePath: string): string {
  const extension = extensionOf(filePath);
  return extension.length === 0 ? "a file with no extension" : extension;
}

export async function cutFiles(
  files: readonly FileDiff[],
  options: CutOptions,
): Promise<CutResult> {
  const pieces: Piece[] = [];
  const notChecked: NotChecked[] = [];
  const cutByHunk: CutByHunk[] = [];
  /** Extensions whose grammar this install does not have, reported once for the run. */
  const missing = new Set<string>();

  if (options.cut === "hunks") {
    for (const file of files) pieces.push(...piecesByHunk(file));
    return { pieces, notChecked, cutByHunk };
  }
  if (options.cut === "chunks") {
    for (const file of files) pieces.push(...chunkPieces(file));
    return { pieces, notChecked, cutByHunk };
  }

  for (const file of files) {
    const key = grammarForPath(file.file);
    if (key === null) {
      pieces.push(...piecesByHunk(file));
      cutByHunk.push({ file: file.file, reason: `no grammar for ${describeExtension(file.file)}` });
      continue;
    }
    const range = chunkRange(file);
    const source = await options.readSource(file.file);
    if (source === null) {
      notChecked.push({
        file: file.file,
        fromLine: range.from,
        toLine: range.to,
        reason: "stop-rules could not read this file out of the snapshot it took",
      });
      continue;
    }
    const parsed = await parseSource(key, source);
    if (!parsed.ok) {
      if (parsed.kind === "not-installed") {
        missing.add(describeExtension(file.file));
        continue;
      }
      notChecked.push({
        file: file.file,
        fromLine: range.from,
        toLine: range.to,
        reason: parsed.reason,
      });
      continue;
    }
    const broken = new Set(errorRows(parsed.root));
    const added = addedLines(file).map((line) => line.line);
    if (added.some((line) => broken.has(line))) {
      notChecked.push({
        file: file.file,
        fromLine: range.from,
        toLine: range.to,
        reason: `could not be parsed as ${GRAMMAR_TITLE[key]}`,
      });
      continue;
    }
    const table = TABLES[key satisfies GrammarKey];
    pieces.push(...buildPieces(file, source, table, parsed.root));
  }

  for (const extension of [...missing].sort()) {
    notChecked.push({
      reason: `no grammar installed for ${extension}, run stop-rules init again to add it`,
    });
  }

  return { pieces, notChecked, cutByHunk };
}
