/**
 * The Node layer that turns a diff into pieces: read each changed file out of the snapshot
 * tree, parse it with the grammar for its extension, and cut it into pieces. A file with no
 * grammar is cut by diff hunk. A file whose grammar is not installed, or that will not parse,
 * is reported as not checked. Nothing here guesses and nothing falls back.
 */

import { addedLines, chunkRange, type FileDiff, type Piece } from "./diff.js";
import { readBlob } from "./git.js";
import { extensionOf, grammarForPath, GRAMMAR_TITLE, TABLES, type GrammarKey } from "./languages.js";
import { buildPieces, errorRows, piecesByHunk } from "./pieces.js";
import { parseSource } from "./treesitter.js";
import type { CutByHunk, NotChecked } from "./types.js";

export interface CutResult {
  pieces: Piece[];
  notChecked: NotChecked[];
  cutByHunk: CutByHunk[];
}

function describeExtension(filePath: string): string {
  const extension = extensionOf(filePath);
  return extension.length === 0 ? "a file with no extension" : extension;
}

export async function cutFiles(
  root: string,
  snapshot: string,
  files: readonly FileDiff[],
): Promise<CutResult> {
  const pieces: Piece[] = [];
  const notChecked: NotChecked[] = [];
  const cutByHunk: CutByHunk[] = [];
  /** Extensions whose grammar this install does not have, reported once for the run. */
  const missing = new Set<string>();

  for (const file of files) {
    const key = grammarForPath(file.file);
    if (key === null) {
      pieces.push(...piecesByHunk(file));
      cutByHunk.push({ file: file.file, reason: `no grammar for ${describeExtension(file.file)}` });
      continue;
    }
    const range = chunkRange(file);
    const source = await readBlob(root, snapshot, file.file);
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
