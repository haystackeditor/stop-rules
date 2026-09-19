/**
 * The version, in one place. `scripts/check-versions.mjs` fails the build when this string
 * and package.json disagree, so there is nothing to read at run time and nothing to guess.
 */
export const VERSION = "0.1.0";

/**
 * True when the running file is the single file bundle. `scripts/bundle.mjs` defines this
 * when esbuild inlines the CLI; the plain tsc build leaves it undefined, and "not a bundle"
 * is then the correct answer, because dist/cli.js is not one. `init` uses this to vendor the
 * file that is running, whatever it has been renamed to.
 */
declare const __STOP_RULES_BUNDLED__: boolean | undefined;

export function isBundled(): boolean {
  return typeof __STOP_RULES_BUNDLED__ === "boolean" && __STOP_RULES_BUNDLED__;
}
