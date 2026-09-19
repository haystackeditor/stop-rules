/** Helpers every adapter needs: reading the payload, writing a config, merging JSON. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CheckResult, HookContext, HookOutput, InstallResult } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasViolations(result: CheckResult): boolean {
  return result.violations.length > 0;
}

/** Parses the hook payload. Throws a plain Error the CLI can print. */
export function parseJsonPayload(stdinText: string): Record<string, unknown> {
  const trimmed = stdinText.trim();
  if (trimmed.length === 0) throw new Error("no hook payload on stdin");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `hook payload on stdin is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) throw new Error("hook payload on stdin is not a JSON object");
  return parsed;
}

/** First key that holds a non-empty string, or null when the payload has none of them. */
export function pickString(
  payload: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function pickNumber(
  payload: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** First key that holds an array whose first entry is a non-empty string, else null. */
export function pickFirstOfArray(
  payload: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (!Array.isArray(value)) continue;
    const first = value[0];
    if (typeof first === "string" && first.length > 0) return first;
  }
  return null;
}

/** The context every JSON-on-stdin agent shares, with each agent's own field names. */
export interface FieldNames {
  /** How to name this agent in an error message. */
  agent: string;
  /** Field the agent's docs use for the conversation id. One of these must be present. */
  session: readonly string[];
  /** Field holding the directory. Leave both out only when the docs have neither. */
  cwd?: readonly string[];
  cwdArray?: readonly string[];
  loopCount?: readonly string[];
  stopHookActive?: readonly string[];
}

/**
 * Reads the payload the agent sent. A field its own documentation says is always there and
 * is missing anyway is an error: nothing is guessed, because checking the wrong directory or
 * merging two conversations into one session id would both be wrong quietly.
 */
export function contextFrom(stdinText: string, fields: FieldNames): HookContext {
  const payload = parseJsonPayload(stdinText);
  const missing = (names: readonly string[]): Error =>
    new Error(`the ${fields.agent} hook input has no ${names.join(" or ")}`);

  const sessionId = pickString(payload, fields.session);
  if (sessionId === null) throw missing(fields.session);

  let cwd: string | undefined;
  if (fields.cwd !== undefined) {
    const found = pickString(payload, fields.cwd);
    if (found === null) throw missing(fields.cwd);
    cwd = found;
  } else if (fields.cwdArray !== undefined) {
    const found = pickFirstOfArray(payload, fields.cwdArray);
    if (found === null) throw missing(fields.cwdArray);
    cwd = found;
  }

  const loopCount = fields.loopCount ? pickNumber(payload, fields.loopCount) : undefined;
  const active = fields.stopHookActive
    ? fields.stopHookActive.some((key) => payload[key] === true)
    : false;
  return {
    sessionId,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(loopCount !== undefined ? { loopCount } : {}),
    stopHookActive: active,
  };
}

export function out(exitCode: number, stdout = "", stderr = ""): HookOutput {
  return { stdout, stderr, exitCode };
}

/** Exit 2 with the report on stderr: what most Stop hooks read as "keep working". */
export function exitTwoOnStderr(result: CheckResult, report: string): HookOutput {
  return hasViolations(result) ? out(2, "", `${report}\n`) : out(0);
}

export function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/* ------------------------------------------------------------------ install helpers */

export function relative(repoRoot: string, target: string): string {
  return path.relative(repoRoot, target).split(path.sep).join("/");
}

export function failed(file: string, reason: string): InstallResult {
  return { ok: false, files: [file], changed: false, notes: [reason] };
}

export interface JsonFile {
  ok: true;
  /** The parsed object, or an empty one when the file is absent. */
  value: Record<string, unknown>;
  existed: boolean;
}

export type JsonFileRead = JsonFile | { ok: false; reason: string };

/**
 * Reads a JSON config. A file that does not parse is never touched. `shown` is the path to
 * name in messages, so the user sees the same repo relative path everywhere.
 */
export function readJsonFile(file: string, shown: string): JsonFileRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { ok: true, value: {}, existed: false };
    return { ok: false, reason: `could not read ${shown}: ${err.message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      reason: `${shown} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Nothing was changed.`,
    };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: `${shown} does not hold a JSON object. Nothing was changed.` };
  }
  return { ok: true, value: parsed, existed: true };
}

export function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeExecutable(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

/** Does any string anywhere under this value mention stop-rules? */
export function mentionsStopRules(value: unknown): boolean {
  if (typeof value === "string") return value.includes("stop-rules");
  if (Array.isArray(value)) return value.some(mentionsStopRules);
  if (isRecord(value)) return Object.values(value).some(mentionsStopRules);
  return false;
}

/**
 * The array under `key`, or an empty one when the key is absent. Null when the key holds
 * something else: the user's file is then left alone rather than overwritten.
 */
export function arrayAt(container: Record<string, unknown>, key: string): unknown[] | null {
  const value = container[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  return [...value];
}

/** The object under `key`, or an empty one when absent. Null when it holds something else. */
export function recordAt(container: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = container[key];
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  return value;
}

/** What install says when a config file holds an unexpected shape under one key. */
export function wrongShape(shown: string, key: string, expected: string): string {
  return `in ${shown}, "${key}" is not ${expected}. Nothing was changed: fix the file and run init again.`;
}

/** True when any of these paths exists under the repo root. */
export function anyExists(repoRoot: string, names: readonly string[]): boolean {
  return names.some((name) => fs.existsSync(path.join(repoRoot, name)));
}

/**
 * Merges one hook entry into a config keyed `{ <Event>: [ { hooks: [ ... ] } ] }`, which
 * Claude Code, Codex, Gemini and Droid all share. `container` is the object that holds the
 * event keys: the file itself for Droid, or the file's `hooks` object for the others.
 */
export type MergeResult = { ok: true; changed: boolean } | { ok: false; reason: string };

export function mergeHookGroup(
  container: Record<string, unknown>,
  shown: string,
  event: string,
  entry: Record<string, unknown>,
  group: Record<string, unknown> = {},
): MergeResult {
  const list = arrayAt(container, event);
  if (list === null) return { ok: false, reason: wrongShape(shown, event, "a list") };
  if (list.some(mentionsStopRules)) return { ok: true, changed: false };
  list.push({ ...group, hooks: [entry] });
  container[event] = list;
  return { ok: true, changed: true };
}
