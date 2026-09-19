// Build tooling, not shipped source.
//
// Two checks, so nothing about languages can drift:
//
//  1. Every node type named in src/languages.ts really is a node type of that grammar. The
//     grammars are loaded from bin/grammars, which is what ships.
//  2. The supported language table in README.md is the table in src/languages.ts.
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Parser, Language } from "web-tree-sitter";
import { createRequire } from "node:module";
import { GRAMMAR_DIR, repoRoot } from "./grammars.mjs";

const require_ = createRequire(import.meta.url);
const compiled = await import(pathToFileURL(path.join(repoRoot, "dist", "languages.js")).href);
const { EXTENSIONS, GRAMMAR_TITLE, TABLES } = compiled;

await Parser.init({ locateFile: () => require_.resolve("web-tree-sitter/tree-sitter.wasm") });

const LISTS = [
  "fn",
  "member",
  "lambda",
  "bodies",
  "wrappers",
  "attachPrefix",
  "stmtContainers",
];

let names = 0;
const wrong = [];
for (const [key, table] of Object.entries(TABLES)) {
  const language = await Language.load(path.join(GRAMMAR_DIR, `${key}.wasm`));
  const wanted = new Set();
  for (const list of LISTS) for (const name of table[list]) wanted.add(name);
  for (const parents of Object.values(table.bodiesParent)) for (const name of parents) wanted.add(name);
  for (const name of wanted) {
    names += 1;
    if (language.idForNodeType(name, true) === null) wrong.push(`${key}: ${name}`);
  }
}
if (wrong.length > 0) {
  throw new Error(
    `src/languages.ts names ${wrong.length} node types that the grammar does not have:\n  ${wrong.join("\n  ")}`,
  );
}
process.stdout.write(
  `all ${names} node types in src/languages.ts exist in the ${Object.keys(TABLES).length} shipped grammars\n`,
);

// ---------------------------------------------------------------- the README table
const byLanguage = new Map();
for (const [extension, key] of Object.entries(EXTENSIONS)) {
  const list = byLanguage.get(key) ?? [];
  list.push(extension);
  byLanguage.set(key, list);
}
const rows = [...byLanguage.entries()].map(
  ([key, extensions]) => `| ${GRAMMAR_TITLE[key]} | ${extensions.map((e) => `\`${e}\``).join(", ")} |`,
);
const table = ["| Language | File extensions |", "|---|---|", ...rows].join("\n");

const readmePath = path.join(repoRoot, "README.md");
const readme = await readFile(readmePath, "utf8");
const start = "<!-- languages -->";
const end = "<!-- /languages -->";
const from = readme.indexOf(start);
const to = readme.indexOf(end);
if (from === -1 || to === -1 || to < from) {
  throw new Error(`README.md needs the language table between ${start} and ${end}.`);
}
const found = readme.slice(from + start.length, to).trim();
if (found !== table) {
  throw new Error(
    `the language table in README.md is not the one in src/languages.ts. Replace it with:\n\n${table}\n`,
  );
}
process.stdout.write(`README.md lists the same ${rows.length} languages as src/languages.ts\n`);
