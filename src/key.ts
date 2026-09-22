import { promises as fs } from "node:fs";

export type KeyLookup = { ok: true; key: string } | { ok: false; reason: string };

/** The two environment variables one judge's key can come from, and what to call the key. */
export interface KeySource {
  /** The variable holding the key itself. */
  direct: string;
  /** The variable naming a file that holds the key. */
  file: string;
  /** How the key is named in a message, such as "Jev API key". */
  label: string;
}

export const JEV_KEY_SOURCE: KeySource = {
  direct: "TYPESAFE_API_KEY",
  file: "TYPESAFE_API_KEY_FILE",
  label: "Jev API key",
};

export const OPENAI_KEY_SOURCE: KeySource = {
  direct: "OPENAI_API_KEY",
  file: "OPENAI_API_KEY_FILE",
  label: "OpenAI API key",
};

/** True when either of the source's variables is set, even to nothing. */
export function keySourceSet(env: NodeJS.ProcessEnv, source: KeySource): boolean {
  return env[source.direct] !== undefined || env[source.file] !== undefined;
}

/**
 * Resolves a judge's API key from the environment. The key is never logged, never written
 * anywhere and never included in an error message.
 */
export async function resolveApiKey(
  env: NodeJS.ProcessEnv,
  source: KeySource = JEV_KEY_SOURCE,
): Promise<KeyLookup> {
  // A variable that is set has to hold something. Moving on to the next source would hide
  // the mistake and then fail somewhere further away.
  const direct = env[source.direct];
  if (typeof direct === "string") {
    if (direct.trim().length === 0) {
      return { ok: false, reason: `${source.direct} is set but empty. Unset it or put your key in it.` };
    }
    return { ok: true, key: direct.trim() };
  }
  const file = env[source.file];
  if (typeof file === "string") {
    if (file.trim().length === 0) {
      return {
        ok: false,
        reason: `${source.file} is set but empty. Unset it or point it at a file holding your key.`,
      };
    }
    const keyPath = file.trim();
    try {
      const key = (await fs.readFile(keyPath, "utf8")).trim();
      if (key.length === 0) {
        return { ok: false, reason: `${keyPath}, named by ${source.file}, is empty` };
      }
      return { ok: true, key };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return {
        ok: false,
        reason: `could not read ${keyPath}, named by ${source.file}: ${err.code ?? err.message}`,
      };
    }
  }
  return {
    ok: false,
    reason: `no ${source.label}. Set ${source.direct}, or ${source.file} to a file holding it.`,
  };
}
