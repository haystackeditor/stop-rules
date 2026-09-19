import * as path from "node:path";
import {
  anyExists,
  asArray,
  contextFrom,
  failed,
  hasViolations,
  mentionsStopRules,
  out,
  readJsonFile,
  relative,
  writeJsonFile,
} from "./shared.js";
import type { AgentAdapter, CheckResult, HookContext, HookOutput, InstallResult } from "./types.js";

/**
 * Kiro's `Stop` hook. Verified against kiro.dev/docs/hooks, /hooks/types, /hooks/actions and
 * /cli/v3/hooks-migration on 2026-09-19: each hook file is `.kiro/hooks/<id>.json` with
 * `{ "version": "v1", "hooks": [ { name, trigger, action: { type: "command", command },
 * timeout } ] }`; the trigger's PascalCase name is `Stop` and its "Can block?" column says
 * No, so Kiro cannot be told to keep working; command actions "run a shell command in your
 * project root" and receive the session context as JSON on stdin (`cwd`, `session_id`); and
 * for the shell command action, "If the command returns an exit code of 0 ... the stdout
 * output of the command is added to the agent's context", while any other exit code sends
 * stderr to the agent and reports the hook as errored. So violations go to stdout on exit 0
 * and an infrastructure failure goes to stderr on exit 1.
 */
export const kiroAdapter: AgentAdapter = {
  name: "kiro",
  title: "Kiro",
  feedback: "shown-to-user-only",
  effect:
    "gets the report in its context for the next turn, but cannot be told to keep working on it",

  detect(repoRoot: string): boolean {
    return anyExists(repoRoot, [".kiro"]);
  },

  command(bundlePath: string): string {
    return `node "${bundlePath}" hook --agent kiro`;
  },

  parseInput(stdinText: string): HookContext {
    return contextFrom(stdinText, { session: ["session_id"], cwd: ["cwd"] });
  },

  deliver(result: CheckResult, report: string): HookOutput {
    // Exit 0 stdout is added to the agent's context, so a clean run must print nothing.
    if (!hasViolations(result)) return out(0);
    return out(0, `${report}\n`);
  },

  deliverError(message: string): HookOutput {
    return out(1, "", `${message}\n`);
  },

  install(repoRoot: string, command: string): InstallResult {
    const file = path.join(repoRoot, ".kiro", "hooks", "stop-rules.json");
    const shown = relative(repoRoot, file);
    const read = readJsonFile(file, shown);
    if (!read.ok) return failed(shown, read.reason);

    const config = read.value;
    if (typeof config["version"] !== "string") config["version"] = "v1";
    const hooks = asArray(config["hooks"]);
    if (hooks.some(mentionsStopRules)) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it already has a stop-rules Stop hook`],
      };
    }
    hooks.push({
      name: "stop-rules",
      description: "Check the turn's diff against the team's coding rules.",
      trigger: "Stop",
      action: { type: "command", command },
      timeout: 120,
    });
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
