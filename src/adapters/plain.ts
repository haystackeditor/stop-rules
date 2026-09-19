import { contextFrom, hasViolations, out } from "./shared.js";
import type { AgentAdapter, CheckResult, HookContext, HookOutput, InstallResult } from "./types.js";

/**
 * No agent protocol at all: `{ "session_id", "cwd" }` in, the report on both streams out,
 * exit 2 when there is something to fix. This is what the generated OpenCode and Amp
 * plugins spawn, and what any other runner can use.
 */
export const plainAdapter: AgentAdapter = {
  name: "plain",
  title: "Plain",
  feedback: "continues-agent",
  effect: "prints the report and exits 2, for a wrapper to act on",

  detect(): boolean {
    return false;
  },

  command(bundlePath: string): string {
    return `node "${bundlePath}" hook --agent plain`;
  },

  parseInput(stdinText: string): HookContext {
    if (stdinText.trim().length === 0) return { sessionId: "unknown", cwd: "" };
    return contextFrom(stdinText, {
      session: ["session_id", "sessionId"],
      cwd: ["cwd"],
      loopCount: ["loop_count"],
      stopHookActive: ["stop_hook_active"],
    });
  },

  deliver(result: CheckResult, report: string): HookOutput {
    if (!hasViolations(result)) return out(0);
    return out(2, `${report}\n`, `${report}\n`);
  },

  deliverError(message: string): HookOutput {
    return out(1, "", `${message}\n`);
  },

  install(): InstallResult {
    return {
      ok: true,
      files: [],
      changed: false,
      notes: ["plain has no config to install: call it yourself with a JSON payload"],
    };
  },
};
