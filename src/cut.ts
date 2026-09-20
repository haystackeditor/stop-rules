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
 *
 * Every mode reads the file's new text out of the snapshot, because that is what the code
 * around each piece is built from, and a file it cannot read there is reported as not checked.
 * The one case with no file text at all is `score --diff`, where the caller passes no reader
 * and the output says that Jev saw the diff alone.
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
  /**
   * The new text of a changed file. Null only when the caller has no file content at all,
   * which is `score --diff`: then no piece carries the code around it.
   */
  readSource: ReadSource | null;
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

  const read = options.readSource;
  if (options.cut === "functions" && read === null) {
    throw new Error("internal error: functions mode needs the file content and got none");
  }

  for (const file of files) {
    const range = chunkRange(file);
    // Null only when the caller has no file content at all. A file the reader cannot find in
    // the snapshot is a failure, reported below, never checked without the code around it.
    const source = read === null ? null : await read(file.file);
    if (read !== null && source === null) {
      notChecked.push({
        file: file.file,
        fromLine: range.from,
        toLine: range.to,
        reason: "stop-rules could not read this file out of the snapshot it took",
      });
      continue;
    }

    if (options.cut === "hunks") {
      pieces.push(...piecesByHunk(file, source));
      continue;
    }
    if (options.cut === "chunks") {
      pieces.push(...chunkPieces(file, source));
      continue;
    }

    const key = grammarForPath(file.file);
    if (key === null) {
      pieces.push(...piecesByHunk(file, source));
      cutByHunk.push({ file: file.file, reason: `no grammar for ${describeExtension(file.file)}` });
      continue;
    }
    if (source === null) {
      throw new Error("internal error: functions mode reached a file with no content");
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
