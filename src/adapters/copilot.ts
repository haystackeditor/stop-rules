import * as path from "node:path";
import {
  anyExists,
  asArray,
  asRecord,
  contextFrom,
  failed,
  hasViolations,
  jsonLine,
  mentionsStopRules,
  out,
  readJsonFile,
  relative,
  writeJsonFile,
} from "./shared.js";
import type { AgentAdapter, CheckResult, HookContext, HookOutput, InstallResult } from "./types.js";

/**
 * GitHub Copilot CLI's `agentStop` hook. Verified against the GitHub Copilot hooks
 * reference on 2026-09-19: repository hooks are `.github/hooks/*.json` with
 * `{ "version": 1, "hooks": { "agentStop": [ { type: "command", bash, timeoutSec } ] } }`;
 * the input is `{ sessionId, cwd, stopReason, stop_hook_active }` in camelCase or
 * `{ session_id, cwd, ... }` in the VS Code compatible shape, so both are read; `decision:
 * "block"` "forces another agent turn using `reason` as the prompt"; exit code 2 on this
 * event is only a warning surfaced to the user, so the JSON path is the one that works;
 * empty output falls through to default behavior, so a clean run is silent. The CLI stops
 * overriding a hook after 8 consecutive block continuations, on top of our own loop guard.
 */
export const copilotAdapter: AgentAdapter = {
  name: "copilot",
  title: "GitHub Copilot CLI",
  feedback: "continues-agent",
  effect: "will run another turn with the report as its prompt",

  detect(repoRoot: string): boolean {
    return anyExists(repoRoot, [".github/hooks", ".github/copilot-instructions.md"]);
  },

  command(bundlePath: string): string {
    return `node "${bundlePath}" hook --agent copilot`;
  },

  parseInput(stdinText: string): HookContext {
    return contextFrom(stdinText, {
      session: ["sessionId", "session_id"],
      cwd: ["cwd"],
      stopHookActive: ["stop_hook_active"],
    });
  },

  deliver(result: CheckResult, report: string): HookOutput {
    if (!hasViolations(result)) return out(0);
    return out(0, jsonLine({ decision: "block", reason: report }));
  },

  deliverError(message: string): HookOutput {
    // Logged as a hook failure and the run continues: no block decision, no new turn.
    return out(1, "", `${message}\n`);
  },

  install(repoRoot: string, command: string): InstallResult {
    const file = path.join(repoRoot, ".github", "hooks", "stop-rules.json");
    const shown = relative(repoRoot, file);
    const read = readJsonFile(file, shown);
    if (!read.ok) return failed(shown, read.reason);

    const config = read.value;
    if (typeof config["version"] !== "number") config["version"] = 1;
    const hooks = asRecord(config["hooks"]);
    const list = asArray(hooks["agentStop"]);
    if (list.some(mentionsStopRules)) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it already has a stop-rules agentStop hook`],
      };
    }
    // cwd is documented as relative to the repository root, which is what the command
    // path expects. Copilot CLI hooks otherwise inherit the CLI's own shell directory.
    list.push({ type: "command", bash: command, cwd: ".", timeoutSec: 120 });
    hooks["agentStop"] = list;
    config["hooks"] = hooks;
    writeJsonFile(file, config);
    return {
      ok: true,
      files: [shown],
      changed: true,
      notes: [
        read.existed
          ? `merged an agentStop hook into ${shown}, keeping everything that was already there`
          : `created ${shown} with an agentStop hook`,
      ],
    };
  },
};
