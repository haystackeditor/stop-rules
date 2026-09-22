import * as fs from "node:fs";
import * as path from "node:path";
import { piExtension } from "../plugins/pi.js";
import { anyExists, relative } from "./shared.js";
import { plainAdapter } from "./plain.js";
import type { AgentAdapter, CheckResult, HookOutput, InstallResult } from "./types.js";

const BUNDLE = ".stop-rules/stop-rules.mjs";
const EXTENSION = ".pi/extensions/stop-rules.ts";

/** Pi skips project extensions until the folder is trusted, so install says so every time. */
const TRUST_NOTE =
  "Pi loads project extensions only once the folder is trusted: accept its trust prompt, " +
  "or pass --approve to pi --print and pi --mode json";

/**
 * Pi has no command hooks, only extensions, so `install` writes a small TypeScript
 * extension that listens for `agent_before_settle` and returns the report as a
 * `custom_message` entry with `continue: true`. The extension spawns this same bundle with
 * `--agent plain`, so the protocol methods here are the plain ones and exist only so
 * `hook --agent pi` still behaves.
 */
export const piAdapter: AgentAdapter = {
  name: "pi",
  title: "Pi",
  feedback: "continues-agent",
  effect: "gets the report as a message and one more turn to fix it",

  detect(repoRoot: string): boolean {
    return anyExists(repoRoot, [".pi"]);
  },

  command(bundlePath: string): string {
    return `node "${bundlePath}" hook --agent plain`;
  },

  parseInput(stdinText: string) {
    return plainAdapter.parseInput(stdinText);
  },

  deliver(result: CheckResult, report: string): HookOutput {
    return plainAdapter.deliver(result, report);
  },

  deliverError(message: string): HookOutput {
    return plainAdapter.deliverError(message);
  },

  install(repoRoot: string, _command: string): InstallResult {
    const file = path.join(repoRoot, EXTENSION);
    const shown = relative(repoRoot, file);
    const wanted = piExtension(BUNDLE);
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(file, "utf8");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        return {
          ok: false,
          files: [shown],
          changed: false,
          notes: [`could not read ${shown}: ${err.message}`],
        };
      }
    }
    if (existing !== null && !existing.includes("stop-rules")) {
      return {
        ok: false,
        files: [shown],
        changed: false,
        notes: [`${shown} exists and is not a stop-rules extension. Nothing was changed.`],
      };
    }
    if (existing === wanted) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it is already up to date`, TRUST_NOTE],
      };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, wanted, "utf8");
    return {
      ok: true,
      files: [shown],
      changed: true,
      notes: [
        existing === null ? `wrote the extension ${shown}` : `updated the extension ${shown}`,
        TRUST_NOTE,
      ],
    };
  },
};
