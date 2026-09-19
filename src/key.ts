import { promises as fs } from "node:fs";

export interface KeyLookup {
  ok: boolean;
  key: string;
  reason?: string;
}

/**
 * Resolves the Jev API key from the environment. The key is never logged, never written
 * anywhere and never included in an error message.
 */
export async function resolveApiKey(env: NodeJS.ProcessEnv): Promise<KeyLookup> {
  const direct = env["TYPESAFE_API_KEY"];
  if (typeof direct === "string" && direct.trim().length > 0) {
    return { ok: true, key: direct.trim() };
  }
  const file = env["TYPESAFE_API_KEY_FILE"];
  if (typeof file === "string" && file.trim().length > 0) {
    const keyPath = file.trim();
    try {
      const key = (await fs.readFile(keyPath, "utf8")).trim();
      if (key.length === 0) {
        return { ok: false, key: "", reason: `the file in TYPESAFE_API_KEY_FILE is empty` };
      }
      return { ok: true, key };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return {
        ok: false,
        key: "",
        reason: `could not read the file in TYPESAFE_API_KEY_FILE: ${err.code ?? err.message}`,
      };
    }
  }
  return {
    ok: false,
    key: "",
    reason: "no Jev API key. Set TYPESAFE_API_KEY, or TYPESAFE_API_KEY_FILE to a file holding it.",
  };
}
