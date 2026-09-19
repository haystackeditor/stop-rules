// Build tooling, not shipped source: the team server reports its own version on /health,
// and that string is written by hand in src/server/handler.ts because the server file may
// not read package.json. This check stops the two from drifting apart.
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { repoRoot } from "./bundle.mjs";

const handlerPath = path.join(repoRoot, "src", "server", "handler.ts");
const pkgPath = path.join(repoRoot, "package.json");

const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
const handler = await readFile(handlerPath, "utf8");

const match = /export const SERVER_VERSION = "([^"]*)";/.exec(handler);
if (match === null) {
  throw new Error(`could not find SERVER_VERSION in ${path.relative(repoRoot, handlerPath)}`);
}
const serverVersion = match[1];
if (serverVersion !== pkg.version) {
  throw new Error(
    `SERVER_VERSION is "${serverVersion}" in src/server/handler.ts but the package version is ` +
      `"${pkg.version}". Set them to the same string.`,
  );
}
process.stdout.write(`SERVER_VERSION matches the package version (${pkg.version})\n`);
