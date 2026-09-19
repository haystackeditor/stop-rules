import * as path from "node:path";
import {
  anyExists,
  contextFrom,
  exitTwoOnStderr,
  failed,
  mergeHookGroup,
  out,
  readJsonFile,
  relative,
  writeJsonFile,
} from "./shared.js";
import type { AgentAdapter, CheckResult, HookContext, HookOutput, InstallResult } from "./types.js";

/**
 * Factory Droid's Stop hook. Verified against the Factory hooks documentation on
 * 2026-09-19: project config is `.factory/hooks.json`, keyed directly by event name, so
 * `{ "Stop": [ { hooks: [ { type: "command", command, timeout } ] } ] }`; the input carries
 * `session_id`, `cwd` and `stop_hook_active`; "Exit code `2` ... `PostToolUse` and `Stop`
 * feed stderr back to Droid"; and "Any other non-zero exit | Non-blocking error. Droid
 * records stderr and continues". The docs tell hooks to resolve project paths through
 * `"$FACTORY_PROJECT_DIR"` because hooks run from Droid's own working directory.
 */
export const droidAdapter: AgentAdapter = {
  name: "droid",
  title: "Factory Droid",
  feedback: "continues-agent",
  effect: "will be told to fix violations before it finishes responding",

  detect(repoRoot: string): boolean {
    return anyExists(repoRoot, [".factory"]);
  },

  command(bundlePath: string): string {
    return `node "$FACTORY_PROJECT_DIR"/${bundlePath} hook --agent droid`;
  },

  parseInput(stdinText: string): HookContext {
    return contextFrom(stdinText, {
      session: ["session_id"],
      cwd: ["cwd"],
      stopHookActive: ["stop_hook_active"],
    });
  },

  deliver(result: CheckResult, report: string): HookOutput {
    return exitTwoOnStderr(result, report);
  },

  deliverError(message: string): HookOutput {
    return out(1, "", `${message}\n`);
  },

  install(repoRoot: string, command: string): InstallResult {
    const file = path.join(repoRoot, ".factory", "hooks.json");
    const shown = relative(repoRoot, file);
    const read = readJsonFile(file, shown);
    if (!read.ok) return failed(shown, read.reason);

    const config = read.value;
    const added = mergeHookGroup(config, "Stop", { type: "command", command, timeout: 120 });
    if (!added) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it already has a stop-rules Stop hook`],
      };
    }
    writeJsonFile(file, config);
    return {
      ok: true,
      files: [shown],
      changed: true,
      notes: [
        read.existed
          ? `merged a Stop hook into ${shown}, keeping everything that was already there`
          : `created ${shown} with a Stop hook`,
      ],
    };
  },
};
