/**
 * The Node layer around tree-sitter. It finds the vendored wasm files, loads the runtime
 * once, loads one grammar per language and parses a file. Nothing above this file touches
 * the parser, and the check engine only ever sees plain pieces.
 *
 * The wasm files sit beside the file that is running: `bin/tree-sitter.wasm` and
 * `bin/grammars/<language>.wasm` in this repository, and the same two names inside a target
 * repo's `.stop-rules/` after `init` copied them. Running the plain tsc build out of `dist/`
 * there is nothing to copy from, so that one case reads this repository's `bin/`.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Node } from "web-tree-sitter";
import { GRAMMAR_TITLE, grammarWasmName, type GrammarKey } from "./languages.js";
import { isBundled } from "./version.js";

const RUNTIME_WASM = "tree-sitter.wasm";
const GRAMMAR_DIR = "grammars";

/** The folder holding the runtime wasm and the grammars folder. */
export function vendorDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return isBundled() ? here : path.join(here, "..", "bin");
}

export function runtimeWasmPath(dir: string = vendorDir()): string {
  return path.join(dir, RUNTIME_WASM);
}

export function grammarWasmPath(key: GrammarKey, dir: string = vendorDir()): string {
  return path.join(dir, GRAMMAR_DIR, grammarWasmName(key));
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return false;
    throw new Error(`could not look at ${file}: ${err.code ?? err.message}`);
  }
}

let started: Promise<void> | null = null;

/** Loads the tree-sitter runtime once. Throws when the vendored runtime is not there. */
async function start(): Promise<void> {
  if (started !== null) return started;
  const runtime = runtimeWasmPath();
  started = (async () => {
    if (!(await exists(runtime))) {
      throw new Error(
        `the tree-sitter runtime is missing at ${runtime}. Run "stop-rules init" again in this repo to copy it.`,
      );
    }
    await Parser.init({ locateFile: () => runtime });
  })();
  return started;
}

const parsers = new Map<GrammarKey, Parser>();

export type ParseOutcome =
  | { ok: true; root: Node }
  | { ok: false; kind: "not-installed" | "failed"; reason: string };

/** Which grammars are vendored beside the running file right now. */
export async function installedGrammars(keys: readonly GrammarKey[]): Promise<GrammarKey[]> {
  const found: GrammarKey[] = [];
  for (const key of keys) {
    if (await exists(grammarWasmPath(key))) found.push(key);
  }
  return found;
}

/**
 * Parses one file with one grammar. A grammar that was never copied into this repo is
 * reported as not installed, which is not an error; a parser that throws is a failure for
 * that file and the file's added lines are reported as not checked.
 */
export async function parseSource(key: GrammarKey, source: string): Promise<ParseOutcome> {
  const wasm = grammarWasmPath(key);
  if (!(await exists(wasm))) {
    return { ok: false, kind: "not-installed", reason: `no grammar installed for ${GRAMMAR_TITLE[key]}` };
  }
  await start();
  let parser = parsers.get(key);
  if (parser === undefined) {
    let language: Language;
    try {
      language = await Language.load(wasm);
    } catch (error) {
      return {
        ok: false,
        kind: "failed",
        reason: `could not load the ${GRAMMAR_TITLE[key]} grammar from ${wasm}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    parser = new Parser();
    parser.setLanguage(language);
    parsers.set(key, parser);
  }
  let root: Node | null = null;
  try {
    const tree = parser.parse(source);
    root = tree === null ? null : tree.rootNode;
  } catch (error) {
    return {
      ok: false,
      kind: "failed",
      reason: `the ${GRAMMAR_TITLE[key]} parser failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (root === null) {
    return { ok: false, kind: "failed", reason: `the ${GRAMMAR_TITLE[key]} parser returned no tree` };
  }
  return { ok: true, root };
}
