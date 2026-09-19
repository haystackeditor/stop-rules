import type { AgentAdapter, Delivery, HookInput, HookOutcome } from "./types.js";

/**
 * Everything specific to Claude Code's Stop hook protocol.
 *
 * Exit 0 is a silent success. Exit 2 feeds stderr back to the agent: with
 * "asyncRewake": true it wakes the agent with that text, without it the stop is blocked
 * and the text is handed over before the turn ends. Exit 1 is a non blocking error that
 * Claude Code shows to the user and not to the agent.
 */
export const claudeCodeAdapter: AgentAdapter = {
  name: "claude-code",

  parseInput(stdinText: string): HookInput {
    const trimmed = stdinText.trim();
    if (trimmed.length === 0) {
      throw new Error("no hook payload on stdin");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `hook payload on stdin is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("hook payload on stdin is not a JSON object");
    }
    const payload = parsed as Record<string, unknown>;
    const sessionId = typeof payload["session_id"] === "string" ? payload["session_id"] : "unknown";
    const cwd = typeof payload["cwd"] === "string" ? payload["cwd"] : "";
    return { sessionId, cwd, stopHookActive: payload["stop_hook_active"] === true };
  },

  deliver(result: HookOutcome): Delivery {
    switch (result.kind) {
      case "clean":
        return { stdout: "", stderr: "", exitCode: 0 };
      case "violations":
        return { stdout: "", stderr: `${result.report}\n`, exitCode: 2 };
      case "handoff":
        return { stdout: "", stderr: `${result.report}\n`, exitCode: 1 };
      case "cannot-run":
        return { stdout: "", stderr: `stop-rules: ${result.reason}\n`, exitCode: 1 };
    }
  },
};
