// Build tooling, not shipped source.
//
// bin/stop-rules.mjs is committed so that a clone of this repository is enough to run the
// tool: no npm install, no build. This script keeps that file honest.
//
//   node scripts/bin.mjs            refresh bin/stop-rules.mjs from dist/stop-rules.mjs
//   node scripts/bin.mjs --check    fail when bin/stop-rules.mjs is not a fresh build
import { mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { BIN_OUT, BUNDLE_OUT, buildBundle, repoRoot } from "./bundle.mjs";

const relative = (file) => path.relative(repoRoot, file);

async function refresh() {
  const built = await readFile(BUNDLE_OUT);
  await mkdir(path.dirname(BIN_OUT), { recursive: true });
  await writeFile(BIN_OUT, built);
  // A committed bin entry has to be runnable as a program, not just importable.
  await chmod(BIN_OUT, 0o755);
  process.stdout.write(`${relative(BIN_OUT)} refreshed from ${relative(BUNDLE_OUT)}\n`);
}

async function check() {
  let committed;
  try {
    committed = await readFile(BIN_OUT);
  } catch (error) {
    throw new Error(
      `could not read ${relative(BIN_OUT)}: ${error.message}. Run npm run build and commit it.`,
    );
  }
  const scratch = path.join(await mkdtempish(), "stop-rules.mjs");
  try {
    await buildBundle(scratch);
    const fresh = await readFile(scratch);
    if (!fresh.equals(committed)) {
      throw new Error(
        `${relative(BIN_OUT)} is ${committed.length} bytes but a fresh build is ${fresh.length} bytes. ` +
          "Run npm run build and commit the result.",
      );
    }
    process.stdout.write(`${relative(BIN_OUT)} matches a fresh build (${fresh.length} bytes)\n`);
  } finally {
    await rm(path.dirname(scratch), { recursive: true, force: true });
  }
}

async function mkdtempish() {
  const dir = path.join(tmpdir(), `stop-rules-verify-bin-${process.pid}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

if (process.argv.includes("--check")) await check();
else await refresh();
