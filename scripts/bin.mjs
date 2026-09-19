// Build tooling, not shipped source.
//
// bin/ is committed so that a clone of this repository is enough to run the tool: no npm
// install, no build. It holds the bundle, the tree-sitter runtime, one wasm file per grammar
// and a README that records where each one came from. This script keeps all of that honest.
//
//   node scripts/bin.mjs            refresh bin/ from dist/ and node_modules
//   node scripts/bin.mjs --check    fail when anything in bin/ is not a fresh copy
import { mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { BUNDLE_OUT, buildBundle, repoRoot } from "./bundle.mjs";
import { BIN_DIR, GRAMMARS, GRAMMAR_DIR, RUNTIME, grammarsReadme } from "./grammars.mjs";

const BIN_OUT = path.join(BIN_DIR, "stop-rules.mjs");
const README_OUT = path.join(GRAMMAR_DIR, "README.md");
const relative = (file) => path.relative(repoRoot, file);

/** Every committed file in bin/ that is a copy of something else, and where it comes from. */
function copies() {
  return [
    { target: path.join(BIN_DIR, RUNTIME.file), source: RUNTIME.source },
    ...GRAMMARS.map((grammar) => ({
      target: path.join(GRAMMAR_DIR, `${grammar.key}.wasm`),
      source: grammar.source,
    })),
  ];
}

async function refresh() {
  const built = await readFile(BUNDLE_OUT);
  await mkdir(GRAMMAR_DIR, { recursive: true });
  await writeFile(BIN_OUT, built);
  // A committed bin entry has to be runnable as a program, not just importable.
  await chmod(BIN_OUT, 0o755);
  process.stdout.write(`${relative(BIN_OUT)} refreshed from ${relative(BUNDLE_OUT)}\n`);

  let bytes = built.length;
  for (const { target, source } of copies()) {
    const content = await readFile(source);
    await writeFile(target, content);
    bytes += content.length;
  }
  await writeFile(README_OUT, grammarsReadme());
  process.stdout.write(
    `${copies().length} wasm files refreshed into ${relative(BIN_DIR)} (${(bytes / 1_000_000).toFixed(1)} MB in all)\n`,
  );
}

async function check() {
  let committed;
  try {
    committed = await readFile(BIN_OUT);
  } catch (error) {
    throw new Error(
      `could not read ${relative(BIN_OUT)}: ${error.message}. Run npm run compile and commit it.`,
    );
  }
  const scratch = path.join(await mkdtempish(), "stop-rules.mjs");
  try {
    await buildBundle(scratch);
    const fresh = await readFile(scratch);
    if (!fresh.equals(committed)) {
      throw new Error(
        `${relative(BIN_OUT)} is ${committed.length} bytes but a fresh build is ${fresh.length} bytes. ` +
          "Run npm run compile and commit the result.",
      );
    }
    process.stdout.write(`${relative(BIN_OUT)} matches a fresh build (${fresh.length} bytes)\n`);
  } finally {
    await rm(path.dirname(scratch), { recursive: true, force: true });
  }

  for (const { target, source } of copies()) {
    let have;
    try {
      have = await readFile(target);
    } catch (error) {
      throw new Error(
        `could not read ${relative(target)}: ${error.message}. Run npm run compile and commit it.`,
      );
    }
    const want = await readFile(source);
    if (!have.equals(want)) {
      throw new Error(
        `${relative(target)} is ${have.length} bytes but ${path.basename(source)} in node_modules is ${want.length} bytes. ` +
          "Run npm run compile and commit the result.",
      );
    }
  }
  const readme = await readFile(README_OUT, "utf8").catch((error) => {
    throw new Error(`could not read ${relative(README_OUT)}: ${error.message}`);
  });
  if (readme !== grammarsReadme()) {
    throw new Error(
      `${relative(README_OUT)} is not what scripts/grammars.mjs would write. Run npm run compile and commit it.`,
    );
  }
  process.stdout.write(
    `${copies().length} wasm files in ${relative(BIN_DIR)} match node_modules, and ${relative(README_OUT)} lists all of them\n`,
  );
}

async function mkdtempish() {
  const dir = path.join(tmpdir(), `stop-rules-verify-bin-${process.pid}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

if (process.argv.includes("--check")) await check();
else await refresh();
