// Build tooling, not shipped source: bundles the CLI into one file with no imports other
// than node: builtins, so a repository can vendor it as .stop-rules/stop-rules.mjs.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { build } from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

const result = await build({
  entryPoints: [path.join(root, "src", "cli.ts")],
  outfile: path.join(root, "dist", "stop-rules.mjs"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  // No banner: esbuild keeps the shebang that src/cli.ts already starts with.
  define: { __STOP_RULES_VERSION__: JSON.stringify(pkg.version) },
  legalComments: "none",
  logLevel: "warning",
});

if (result.errors.length > 0) {
  // esbuild already printed them; make the failure the process result too.
  process.exitCode = 1;
}
