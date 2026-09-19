import * as fs from "node:fs";
import * as path from "node:path";
import { opencodePlugin } from "../plugins/opencode.js";
import { anyExists, relative } from "./shared.js";
import type { AgentAdapter, CheckResult, HookOutput, InstallResult } from "./types.js";
import { plainAdapter } from "./plain.js";

const BUNDLE = ".stop-rules/stop-rules.mjs";
const PLUGIN = ".opencode/plugins/stop-rules.ts";

/**
 * OpenCode has no command hooks, only plugins, so `install` writes a small TypeScript
 * plugin that listens for `session.idle` and posts the report back as a user message. The
 * plugin spawns this same bundle with `--agent plain`, so the protocol methods here are the
 * plain ones and exist only so `hook --agent opencode` still behaves.
 */
export const opencodeAdapter: AgentAdapter = {
  name: "opencode",
  title: "OpenCode",
  feedback: "continues-agent",
  effect: "gets the report posted back into the session as a new message",

  detect(repoRoot: string): boolean {
    return anyExists(repoRoot, [".opencode", "opencode.json", "opencode.jsonc"]);
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
    const file = path.join(repoRoot, PLUGIN);
    const shown = relative(repoRoot, file);
    const wanted = opencodePlugin(BUNDLE);
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
        notes: [`${shown} exists and is not a stop-rules plugin. Nothing was changed.`],
      };
    }
    if (existing === wanted) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it is already up to date`],
      };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, wanted, "utf8");
    return {
      ok: true,
      files: [shown],
      changed: true,
      notes: [existing === null ? `wrote the plugin ${shown}` : `updated the plugin ${shown}`],
    };
  },
};
