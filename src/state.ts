import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { JudgeInfo } from "./judge.js";

export const MAX_CACHE_ENTRIES = 5000;
export const MAX_REPORTED_ENTRIES = 5000;
const MAX_LOG_BYTES = 1024 * 1024;
const LOCK_POLL_MS = 200;

export interface SessionState {
  /** Consecutive runs in this session that ended in violations. */
  violationRuns: number;
  /** Last time this session was seen, used to prune old sessions. */
  at: number;
}

export interface StopRulesState {
  version: 1;
  lastTree?: string;
  /** sha256(rule id + chunk text) of findings already delivered by the hook. */
  reported: Record<string, number>;
  sessions: Record<string, SessionState>;
}

export interface CacheEntry {
  noul: number;
  at: number;
}

export interface Cache {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export function stateDirFor(gitDir: string): string {
  return path.join(gitDir, "stop-rules");
}

export function emptyState(): StopRulesState {
  return { version: 1, reported: {}, sessions: {} };
}

export function emptyCache(): Cache {
  return { version: 1, entries: {} };
}

/**
 * Reads one of our JSON files. Null means the file is not there yet, which is the defined
 * start of a first run. Anything else is an error the caller reports: a file that is there
 * but unreadable is never quietly treated as an empty one.
 */
async function readJson(file: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    throw new Error(`could not read ${file}: ${err.code ?? err.message}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
        "Run stop-rules baseline --reset to start again.",
    );
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temp, `${JSON.stringify(value)}\n`, "utf8");
  await fs.rename(temp, file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Throws when state.json is there but not the shape we wrote. Never starts over quietly. */
export async function loadState(stateDir: string): Promise<StopRulesState> {
  const file = path.join(stateDir, "state.json");
  const raw = await readJson(file);
  if (raw === null) return emptyState();
  if (!isRecord(raw)) {
    throw new Error(`${file} does not hold a JSON object. Run stop-rules baseline --reset.`);
  }
  const lastTree = raw["lastTree"];
  const reported = raw["reported"];
  const sessions = raw["sessions"];
  const wrong = (field: string): Error =>
    new Error(`${file} has a ${field} that stop-rules did not write. Run stop-rules baseline --reset.`);
  if (lastTree !== undefined && typeof lastTree !== "string") throw wrong("lastTree");
  if (reported !== undefined && !isRecord(reported)) throw wrong("reported");
  if (sessions !== undefined && !isRecord(sessions)) throw wrong("sessions");
  return {
    version: 1,
    ...(typeof lastTree === "string" ? { lastTree } : {}),
    reported: isRecord(reported) ? (reported as Record<string, number>) : {},
    sessions: isRecord(sessions) ? (sessions as Record<string, SessionState>) : {},
  };
}

function prune<T>(entries: Record<string, T>, at: (value: T) => number, max: number): void {
  const keys = Object.keys(entries);
  if (keys.length <= max) return;
  keys
    .sort((a, b) => at(entries[a] as T) - at(entries[b] as T))
    .slice(0, keys.length - max)
    .forEach((key) => {
      delete entries[key];
    });
}

export async function saveState(stateDir: string, state: StopRulesState): Promise<void> {
  prune(state.reported, (value) => value, MAX_REPORTED_ENTRIES);
  await writeJsonAtomic(path.join(stateDir, "state.json"), state);
}

/** Throws when cache.json is there but not the shape we wrote. Deleting it is the cure. */
export async function loadCache(stateDir: string): Promise<Cache> {
  const file = path.join(stateDir, "cache.json");
  const raw = await readJson(file);
  if (raw === null) return emptyCache();
  if (!isRecord(raw) || !isRecord(raw["entries"])) {
    throw new Error(`${file} is not a stop-rules cache. Delete it and run again.`);
  }
  return { version: 1, entries: raw["entries"] as Record<string, CacheEntry> };
}

/**
 * Forgets the baseline and everything reported, so the next run starts from HEAD. Writes a
 * fresh file without reading the old one, which is what makes it the cure for a broken one.
 */
export async function resetState(stateDir: string): Promise<void> {
  await writeJsonAtomic(path.join(stateDir, "state.json"), emptyState());
}

export async function saveCache(stateDir: string, cache: Cache): Promise<void> {
  prune(cache.entries, (value) => value.at, MAX_CACHE_ENTRIES);
  await writeJsonAtomic(path.join(stateDir, "cache.json"), cache);
}

/**
 * Key for a finding the hook already delivered. Computed here rather than in the engine
 * because the engine's skipFinding predicate is synchronous and Web Crypto is not.
 */
export function reportedKey(ruleId: string, chunkText: string): string {
  return createHash("sha256").update(`${ruleId}\u0000${chunkText}`, "utf8").digest("hex");
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EPERM") return true;
    return false;
  }
}

export type ReleaseLock = () => Promise<void>;

/**
 * Exclusive lock so concurrent hook firings do not check the same tree twice. A lock
 * whose owner is gone is taken over. Returns null when the wait ran out.
 */
export async function acquireLock(stateDir: string, timeoutMs = 60_000): Promise<ReleaseLock | null> {
  await fs.mkdir(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, "lock");
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(String(process.pid), "utf8");
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const owner = await fs.readFile(lockPath, "utf8");
          if (owner.trim() === String(process.pid)) await fs.rm(lockPath, { force: true });
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err.code !== "ENOENT") {
            process.stderr.write(`stop-rules: could not release the lock: ${err.message}\n`);
          }
        }
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw err;
    }

    let ownerPid = 0;
    try {
      ownerPid = Number.parseInt((await fs.readFile(lockPath, "utf8")).trim(), 10);
    } catch (readError) {
      const err = readError as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw err;
      continue;
    }
    if (!pidAlive(ownerPid)) {
      await fs.rm(lockPath, { force: true });
      continue;
    }
    if (Date.now() >= deadline) return null;
    await delay(LOCK_POLL_MS);
  }
}

export interface RunLogLine {
  at: string;
  mode: string;
  /** Which judge was asked, and its model. */
  judge: JudgeInfo;
  /** How the change was cut into pieces: functions or hunks. */
  cut: string;
  files: number;
  pieces: number;
  /** Pieces that got at least one answer. Zero with files above zero means nothing was. */
  checked: number;
  /** How many pieces rode in each call, in call order. */
  piecesPerCall: number[];
  /** How many files had no grammar and were cut by diff hunk. */
  cutByHunk: number;
  /** Pieces Jev saw with their diff widened to the lines around the change. */
  widened: number;
  /** Pieces Jev saw with the whole function after the change. */
  withFunction: number;
  /** Pieces whose wide form was over the call cap, so Jev saw the diff alone. */
  tooBigToWiden: number;
  skipped: number;
  calls: number;
  cacheHits: number;
  violations: number;
  notChecked: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  durationMs: number;
  exitCode: number;
  notes: string[];
}

export async function appendRunLog(stateDir: string, line: RunLogLine): Promise<void> {
  const logPath = path.join(stateDir, "run.log");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(line)}\n`, "utf8");
  const stats = await fs.stat(logPath);
  if (stats.size <= MAX_LOG_BYTES) return;
  const contents = await fs.readFile(logPath, "utf8");
  const lines = contents.split("\n").filter((entry) => entry.length > 0);
  const kept = lines.slice(Math.floor(lines.length / 2));
  const temp = `${logPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await fs.writeFile(temp, `${kept.join("\n")}\n`, "utf8");
  await fs.rename(temp, logPath);
}
