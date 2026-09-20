/**
 * `.stop-rules.json` at the repository root: the one file where a team sets the knobs.
 * It is committed and holds no secret. Every key is optional. A flag on the command line
 * beats the file.
 *
 * Keys: `endpoint` (the team server), `cut` (hunks, functions or chunks), `threshold` (0 to 1),
 * `maxCalls` (whole number of Jev requests per run). Anything else in the file, a value of
 * the wrong type, and a value out of range are all errors that name the key.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { CutMode } from "./types.js";

export const SETTINGS_FILE = ".stop-rules.json";

/**
 * The default way to cut a change into pieces, and the one place this default is written.
 *
 * It is `hunks`: one git diff hunk per piece. Nothing is parsed, so an install is one file,
 * every language is covered, and a file that will not parse is still checked. A team that
 * wants a whole function per piece switches to `functions` with `init --cut functions` or
 * `"cut": "functions"` in this file, which copies the tree-sitter runtime and the grammars
 * for the ten languages it knows. Nothing switches mode on its own.
 */
export const DEFAULT_CUT: CutMode = "hunks";

export interface Settings {
  /** The team server every developer's hook sends questions to. */
  endpoint?: string;
  cut?: CutMode;
  threshold?: number;
  maxCalls?: number;
}

const KNOWN_KEYS = ["endpoint", "cut", "threshold", "maxCalls"] as const;

export interface LoadedSettings {
  settings: Settings;
  /** The file these settings came from, whether or not it exists. */
  file: string;
  exists: boolean;
}

export type SettingsLoad = { ok: true; loaded: LoadedSettings } | { ok: false; reason: string };

function parseSettings(file: string, raw: unknown): SettingsLoad {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: `${file} does not hold a JSON object.` };
  }
  const record = raw as Record<string, unknown>;
  const settings: Settings = {};

  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.includes(key as (typeof KNOWN_KEYS)[number])) {
      return {
        ok: false,
        reason: `${file} sets "${key}", which stop-rules does not know. The settings are ${KNOWN_KEYS.join(", ")}.`,
      };
    }
  }

  const endpoint = record["endpoint"];
  if (endpoint !== undefined) {
    if (typeof endpoint !== "string") {
      return { ok: false, reason: `"endpoint" in ${file} must be a string.` };
    }
    if (endpoint.trim().length === 0) {
      return { ok: false, reason: `"endpoint" in ${file} is empty.` };
    }
    settings.endpoint = endpoint.trim();
  }

  const cut = record["cut"];
  if (cut !== undefined) {
    if (cut !== "functions" && cut !== "hunks" && cut !== "chunks") {
      return {
        ok: false,
        reason: `"cut" in ${file} must be "functions", "hunks" or "chunks", not ${JSON.stringify(cut)}.`,
      };
    }
    settings.cut = cut;
  }

  const threshold = record["threshold"];
  if (threshold !== undefined) {
    if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
      return { ok: false, reason: `"threshold" in ${file} must be a number.` };
    }
    if (threshold < 0 || threshold > 1) {
      return { ok: false, reason: `"threshold" in ${file} must be between 0 and 1, not ${threshold}.` };
    }
    settings.threshold = threshold;
  }

  const maxCalls = record["maxCalls"];
  if (maxCalls !== undefined) {
    if (typeof maxCalls !== "number" || !Number.isInteger(maxCalls)) {
      return { ok: false, reason: `"maxCalls" in ${file} must be a whole number.` };
    }
    if (maxCalls < 1) {
      return { ok: false, reason: `"maxCalls" in ${file} must be 1 or more, not ${maxCalls}.` };
    }
    settings.maxCalls = maxCalls;
  }

  return { ok: true, loaded: { settings, file, exists: true } };
}

/** Reads and checks the settings file. A file that is not there means no knobs are set. */
export async function loadSettings(repoRoot: string): Promise<SettingsLoad> {
  const file = path.join(repoRoot, SETTINGS_FILE);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return { ok: true, loaded: { settings: {}, file, exists: false } };
    }
    return { ok: false, reason: `could not read ${file}: ${err.code ?? err.message}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      reason: `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
  return parseSettings(file, raw);
}

export interface SettingsWrite {
  ok: boolean;
  /** The keys this write put in the file. */
  wrote: string[];
  file: string;
  existed: boolean;
  reason?: string;
}

/**
 * Puts the given keys into the settings file and leaves every other key as it is. A file
 * that is already wrong is not overwritten: the reason is returned instead.
 */
export async function writeSettings(repoRoot: string, patch: Settings): Promise<SettingsWrite> {
  const file = path.join(repoRoot, SETTINGS_FILE);
  const load = await loadSettings(repoRoot);
  if (!load.ok) return { ok: false, wrote: [], file, existed: true, reason: load.reason };

  const merged: Settings = { ...load.loaded.settings, ...patch };
  await fs.writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return { ok: true, wrote: Object.keys(patch), file, existed: load.loaded.exists };
}
