import * as path from "node:path";
import {
  anyExists,
  asRecord,
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
 * Codex's Stop hook. Verified against developers.openai.com/codex/hooks on 2026-09-19:
 * config lives in `.codex/hooks.json` under `hooks.Stop[].hooks[]` with `timeout` in
 * seconds; the Stop input carries `session_id`, `cwd` and `stop_hook_active`; "You can
 * also use exit code `2` and write the continuation reason to `stderr`"; and "Exit `0`
 * with no output is treated as success and Codex continues", which is why a clean run
 * prints nothing rather than `{}`. The docs also say to resolve repo-local hook paths from
 * the git root rather than a relative path, because Codex may start in a subdirectory.
 */
export const codexAdapter: AgentAdapter = {
  name: "codex",
  title: "Codex",
  feedback: "continues-agent",
  effect: "will be told to fix violations before the turn ends",

  detect(repoRoot: string): boolean {
    return anyExists(repoRoot, [".codex"]);
  },

  command(bundlePath: string): string {
    return `node "$(git rev-parse --show-toplevel)/${bundlePath}" hook --agent codex`;
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
    // Not exit 2: that is the "keep going" signal. Codex records a failed hook run.
    return out(1, "", `${message}\n`);
  },

  install(repoRoot: string, command: string): InstallResult {
    const file = path.join(repoRoot, ".codex", "hooks.json");
    const shown = relative(repoRoot, file);
    const read = readJsonFile(file, shown);
    if (!read.ok) return failed(shown, read.reason);

    const config = read.value;
    const hooks = asRecord(config["hooks"]);
    const added = mergeHookGroup(hooks, "Stop", { type: "command", command, timeout: 120 });
    if (!added) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it already has a stop-rules Stop hook`],
      };
    }
    config["hooks"] = hooks;
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
