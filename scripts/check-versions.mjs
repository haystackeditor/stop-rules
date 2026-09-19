// Build tooling, not shipped source.
//
// Two source files carry the version as a plain string: src/version.ts for the CLI and
// src/server/handler.ts for the server's /health route, which may not read package.json.
// Nothing reads the version at run time, so this check is what keeps them true.
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { repoRoot } from "./bundle.mjs";

const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));

/** Reads one exported string constant out of a TypeScript file. */
async function constant(file, name) {
  const source = await readFile(path.join(repoRoot, file), "utf8");
  const match = new RegExp(`export const ${name} = "([^"]*)";`).exec(source);
  if (match === null) throw new Error(`could not find ${name} in ${file}`);
  return match[1];
}

for (const [file, name] of [
  ["src/version.ts", "VERSION"],
  ["src/server/handler.ts", "SERVER_VERSION"],
]) {
  const found = await constant(file, name);
  if (found !== pkg.version) {
    throw new Error(
      `${name} is "${found}" in ${file} but the package version is "${pkg.version}". ` +
        "Set them to the same string.",
    );
  }
}
process.stdout.write(`VERSION and SERVER_VERSION match the package version (${pkg.version})\n`);
