// Build tooling, not shipped source.
//
// Where each vendored wasm file comes from, and what its licence is. bin/grammars/README.md
// is generated from this table, and scripts/bin.mjs checks the committed files against it.
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
export const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const WASMS = path.join(path.dirname(require_.resolve("tree-sitter-wasms/package.json")), "out");
const fromWasms = (name) => path.join(WASMS, `tree-sitter-${name}.wasm`);

/** The tree-sitter runtime, loaded once per run. */
export const RUNTIME = {
  file: "tree-sitter.wasm",
  source: require_.resolve("web-tree-sitter/tree-sitter.wasm"),
  package: "web-tree-sitter",
  version: "0.25.10",
  licence: "MIT",
};

/**
 * One row per grammar we ship. `package` is where the wasm comes from, `upstream` is the
 * grammar it was built from, and `licence` is what that package's own metadata says.
 */
export const GRAMMARS = [
  { key: "typescript", title: "TypeScript", source: fromWasms("typescript"), package: "tree-sitter-wasms@0.1.13", upstream: "tree-sitter-typescript", licence: "MIT" },
  { key: "tsx", title: "TSX", source: fromWasms("tsx"), package: "tree-sitter-wasms@0.1.13", upstream: "tree-sitter-typescript (tsx)", licence: "MIT" },
  { key: "javascript", title: "JavaScript", source: fromWasms("javascript"), package: "tree-sitter-wasms@0.1.13", upstream: "tree-sitter-javascript", licence: "MIT" },
  { key: "python", title: "Python", source: require_.resolve("tree-sitter-python/tree-sitter-python.wasm"), package: "tree-sitter-python@0.25.0", upstream: "tree-sitter-python", licence: "MIT" },
  { key: "go", title: "Go", source: fromWasms("go"), package: "tree-sitter-wasms@0.1.13", upstream: "tree-sitter-go", licence: "MIT" },
  { key: "rust", title: "Rust", source: fromWasms("rust"), package: "tree-sitter-wasms@0.1.13", upstream: "tree-sitter-rust", licence: "MIT" },
  { key: "ruby", title: "Ruby", source: fromWasms("ruby"), package: "tree-sitter-wasms@0.1.13", upstream: "tree-sitter-ruby", licence: "MIT" },
  { key: "java", title: "Java", source: fromWasms("java"), package: "tree-sitter-wasms@0.1.13", upstream: "tree-sitter-java", licence: "MIT" },
  { key: "kotlin", title: "Kotlin", source: require_.resolve("@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm"), package: "@tree-sitter-grammars/tree-sitter-kotlin@1.1.0", upstream: "tree-sitter-kotlin", licence: "MIT" },
  { key: "swift", title: "Swift", source: fromWasms("swift"), package: "tree-sitter-wasms@0.1.13", upstream: "tree-sitter-swift", licence: "MIT" },
];

export const BIN_DIR = path.join(repoRoot, "bin");
export const GRAMMAR_DIR = path.join(BIN_DIR, "grammars");

/** The README that ships beside the grammars, so their provenance travels with them. */
export function grammarsReadme() {
  const rows = GRAMMARS.map(
    (g) => `| \`${g.key}.wasm\` | ${g.title} | ${g.package} | ${g.upstream} | ${g.licence} |`,
  ).join("\n");
  return `# Vendored tree-sitter files

These files are committed on purpose, so a clone of this repository can run the checker with
no install and no build. \`stop-rules init\` copies \`tree-sitter.wasm\` and only the grammars
a repository needs into that repository's \`.stop-rules/\` folder.

\`npm run verify:bin\` fails when any file here is not byte for byte the file in
\`node_modules\`, so what is committed is always what the build produced.

## The parser

| File | Package | Version | Licence |
|---|---|---|---|
| \`${RUNTIME.file}\` | ${RUNTIME.package} | ${RUNTIME.version} | ${RUNTIME.licence} |

## The grammars

| File | Language | Package it came from | Grammar | Licence |
|---|---|---|---|---|
${rows}

Every licence above is the one that package publishes. MIT and the Unlicense both allow
redistribution, which is what lets these files be committed here and copied into your
repository. \`tree-sitter-wasms\` itself is released under the Unlicense; each wasm file it
builds carries the licence of the grammar it was built from, so the grammar is what the last
column names.
`;
}
