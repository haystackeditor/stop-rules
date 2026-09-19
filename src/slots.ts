/**
 * The machine wide slot gate.
 *
 * Jev's rate limit is per account, so every stop-rules process on this machine shares it. A
 * run holds a slot for the time of one HTTP attempt and there are eight slots, kept as
 * exclusively created files in the user's cache folder. A slot whose owning process is gone,
 * or whose timestamp is older than 120 seconds, is taken over.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Measured by the owner's team: 16 calls in flight is fine, 32 gets about half refused. */
export const MACHINE_SLOTS = 8;
/** Bounded by the hook timeout, so a busy machine gives up instead of hanging the turn. */
export const SLOT_WAIT_MS = 60_000;
export const SLOT_STALE_MS = 120_000;
const POLL_MS = 100;

export const MACHINE_BUSY =
  "Jev is busy on this machine, this change will be checked on the next run";

export type SlotRelease = () => Promise<void>;
export type SlotOutcome = { ok: true; release: SlotRelease } | { ok: false; reason: string };

/** Where the slot files live. An empty XDG_CACHE_HOME is an error, not a shrug. */
export function slotsDir(env: NodeJS.ProcessEnv): string {
  const configured = env["XDG_CACHE_HOME"];
  if (configured !== undefined) {
    if (configured.trim().length === 0) {
      throw new Error("XDG_CACHE_HOME is set but empty. Unset it or point it at a folder.");
    }
    return path.join(configured, "stop-rules", "slots");
  }
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Caches", "stop-rules", "slots");
  return path.join(home, ".cache", "stop-rules", "slots");
}

interface SlotFile {
  pid: number;
  at: number;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return err.code === "EPERM";
  }
}

function readSlot(text: string): SlotFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A half written slot file is not something to trust. Treat it as free.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const pid = (parsed as { pid?: unknown }).pid;
  const at = (parsed as { at?: unknown }).at;
  if (typeof pid !== "number" || typeof at !== "number") return null;
  return { pid, at };
}

/** Takes one of the slots, or says the machine is busy after the wait ran out. */
export async function acquireSlot(dir: string, waitMs: number = SLOT_WAIT_MS): Promise<SlotOutcome> {
  await fs.mkdir(dir, { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    for (let index = 0; index < MACHINE_SLOTS; index += 1) {
      const file = path.join(dir, `slot-${index}`);
      try {
        const handle = await fs.open(file, "wx");
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
        } finally {
          await handle.close();
        }
        return {
          ok: true,
          release: async () => {
            try {
              const owner = readSlot(await fs.readFile(file, "utf8"));
              if (owner !== null && owner.pid === process.pid) await fs.rm(file, { force: true });
            } catch (error) {
              const err = error as NodeJS.ErrnoException;
              if (err.code !== "ENOENT") {
                process.stderr.write(`stop-rules: could not free a Jev slot: ${err.message}\n`);
              }
            }
          },
        };
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "EEXIST") throw err;
      }

      // Taken. Take it over when the owner is gone or has been holding it too long.
      let owner: SlotFile | null = null;
      try {
        owner = readSlot(await fs.readFile(file, "utf8"));
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw err;
        continue;
      }
      if (owner === null || !pidAlive(owner.pid) || Date.now() - owner.at > SLOT_STALE_MS) {
        await fs.rm(file, { force: true });
      }
    }
    if (Date.now() >= deadline) return { ok: false, reason: MACHINE_BUSY };
    await delay(POLL_MS);
  }
}
