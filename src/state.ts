import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    // A corrupt state or cache file must not stop a run; the caller notes it.
    throw new Error(`could not read ${path.basename(file)}: ${err.message}`);
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temp, `${JSON.stringify(value)}\n`, "utf8");
  await fs.rename(temp, file);
}

export async function loadState(
  stateDir: string,
  note: (message: string) => void,
): Promise<StopRulesState> {
  let raw: unknown | null;
  try {
    raw = await readJson(path.join(stateDir, "state.json"));
  } catch (error) {
    note(`${(error as Error).message}; starting from empty state`);
    return emptyState();
  }
  if (raw === null || typeof raw !== "object") return emptyState();
  const candidate = raw as Partial<StopRulesState>;
  return {
    version: 1,
    ...(typeof candidate.lastTree === "string" ? { lastTree: candidate.lastTree } : {}),
    reported: typeof candidate.reported === "object" && candidate.reported !== null
      ? (candidate.reported as Record<string, number>)
      : {},
    sessions: typeof candidate.sessions === "object" && candidate.sessions !== null
      ? (candidate.sessions as Record<string, SessionState>)
      : {},
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

export async function loadCache(
  stateDir: string,
  note: (message: string) => void,
): Promise<Cache> {
  let raw: unknown | null;
  try {
    raw = await readJson(path.join(stateDir, "cache.json"));
  } catch (error) {
    note(`${(error as Error).message}; starting from an empty cache`);
    return emptyCache();
  }
  if (raw === null || typeof raw !== "object") return emptyCache();
  const entries = (raw as { entries?: unknown }).entries;
  if (typeof entries !== "object" || entries === null) return emptyCache();
  return { version: 1, entries: entries as Record<string, CacheEntry> };
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
  files: number;
  chunks: number;
  calls: number;
  cacheHits: number;
  violations: number;
  notChecked: number;
  inputTokens: number;
  outputTokens: number;
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
