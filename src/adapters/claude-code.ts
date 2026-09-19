import * as path from "node:path";
import {
  anyExists,
  recordAt,
  contextFrom,
  exitTwoOnStderr,
  failed,
  mergeHookGroup,
  out,
  readJsonFile,
  relative,
  wrongShape,
  writeJsonFile,
} from "./shared.js";
import type { AgentAdapter, CheckResult, HookContext, HookOutput, InstallResult } from "./types.js";

/**
 * Claude Code's Stop hook. Verified against docs.claude.com/en/docs/claude-code/hooks.md
 * on 2026-09-19: exit code 2 on Stop "Prevents Claude from stopping, continues the
 * conversation", and `asyncRewake: true` "runs in the background and wakes Claude on exit
 * code 2. The hook's stderr ... is shown to Claude as a system reminder". Exit 1 is a non
 * blocking error Claude Code shows to the user and not to the agent. `timeout` is seconds.
 */
export const claudeCodeAdapter: AgentAdapter = {
  name: "claude-code",
  title: "Claude Code",
  feedback: "continues-agent",
  effect: "will be woken in the background and told to fix violations",

  detect(repoRoot: string): boolean {
    return anyExists(repoRoot, [".claude", "CLAUDE.md"]);
  },

  command(bundlePath: string): string {
    return `node "\${CLAUDE_PROJECT_DIR}/${bundlePath}" hook --agent claude-code`;
  },

  parseInput(stdinText: string): HookContext {
    return contextFrom(stdinText, {
      agent: "Claude Code",
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
    const file = path.join(repoRoot, ".claude", "settings.json");
    const shown = relative(repoRoot, file);
    const read = readJsonFile(file, shown);
    if (!read.ok) return failed(shown, read.reason);

    const settings = read.value;
    const hooks = recordAt(settings, "hooks");
    if (hooks === null) return failed(shown, wrongShape(shown, "hooks", "an object"));
    const merged = mergeHookGroup(hooks, shown, "Stop", {
      type: "command",
      command,
      asyncRewake: true,
      timeout: 120,
    });
    if (!merged.ok) return failed(shown, merged.reason);
    if (!merged.changed) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it already has a stop-rules Stop hook`],
      };
    }
    settings["hooks"] = hooks;
    writeJsonFile(file, settings);
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
