import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Replaced with a string literal by `scripts/bundle.mjs`, so the vendored single file knows
 * its own version without a package.json next to it. In the plain `tsc` build the
 * identifier does not exist, and `typeof` on an undeclared identifier is safe in JS.
 */
declare const __STOP_RULES_VERSION__: string | undefined;

const BAKED: string | null =
  typeof __STOP_RULES_VERSION__ === "string" ? __STOP_RULES_VERSION__ : null;

export async function version(): Promise<string> {
  if (BAKED !== null) return BAKED;
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  try {
    const raw: unknown = JSON.parse(await fs.readFile(pkgPath, "utf8"));
    const value = (raw as { version?: unknown }).version;
    return typeof value === "string" ? value : "unknown";
  } catch (error) {
    // Not fatal, but do not pretend we know: say why.
    const message = error instanceof Error ? error.message : String(error);
    return `unknown (could not read ${pkgPath}: ${message})`;
  }
}
