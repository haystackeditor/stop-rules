// Build tooling, not shipped source: bundles the CLI into one file with no imports other
// than node: builtins, so a repository can vendor it as .stop-rules/stop-rules.mjs.
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as path from "node:path";
import { build } from "esbuild";

export const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const BUNDLE_OUT = path.join(repoRoot, "dist", "stop-rules.mjs");
/** The copy that is committed, so a clone needs no build. */
export const BIN_OUT = path.join(repoRoot, "bin", "stop-rules.mjs");

/** Bundles src/cli.ts into one file. Throws when esbuild reports an error. */
export async function buildBundle(outfile = BUNDLE_OUT) {
  const result = await build({
    entryPoints: [path.join(repoRoot, "src", "cli.ts")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    // No banner: esbuild keeps the shebang that src/cli.ts already starts with.
    // The version is a source constant; this only tells the code it is running bundled.
    define: { __STOP_RULES_BUNDLED__: "true" },
    legalComments: "none",
    logLevel: "warning",
  });
  if (result.errors.length > 0) {
    // esbuild already printed them; do not let the build look successful.
    throw new Error(`esbuild reported ${result.errors.length} error(s)`);
  }
  return outfile;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await buildBundle();
}
