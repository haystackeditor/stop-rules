import { promises as fs } from "node:fs";

export type KeyLookup = { ok: true; key: string } | { ok: false; reason: string };

/**
 * Resolves the Jev API key from the environment. The key is never logged, never written
 * anywhere and never included in an error message.
 */
export async function resolveApiKey(env: NodeJS.ProcessEnv): Promise<KeyLookup> {
  // A variable that is set has to hold something. Moving on to the next source would hide
  // the mistake and then fail somewhere further away.
  const direct = env["TYPESAFE_API_KEY"];
  if (typeof direct === "string") {
    if (direct.trim().length === 0) {
      return { ok: false, reason: "TYPESAFE_API_KEY is set but empty. Unset it or put your key in it." };
    }
    return { ok: true, key: direct.trim() };
  }
  const file = env["TYPESAFE_API_KEY_FILE"];
  if (typeof file === "string") {
    if (file.trim().length === 0) {
      return {
        ok: false,
        reason: "TYPESAFE_API_KEY_FILE is set but empty. Unset it or point it at a file holding your key.",
      };
    }
    const keyPath = file.trim();
    try {
      const key = (await fs.readFile(keyPath, "utf8")).trim();
      if (key.length === 0) {
        return { ok: false, reason: `${keyPath}, named by TYPESAFE_API_KEY_FILE, is empty` };
      }
      return { ok: true, key };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return {
        ok: false,
        reason: `could not read ${keyPath}, named by TYPESAFE_API_KEY_FILE: ${err.code ?? err.message}`,
      };
    }
  }
  return {
    ok: false,
    reason: "no Jev API key. Set TYPESAFE_API_KEY, or TYPESAFE_API_KEY_FILE to a file holding it.",
  };
}
