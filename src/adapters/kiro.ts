import * as path from "node:path";
import {
  anyExists,
  asArray,
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
 * Kiro's `Stop` hook. Verified against kiro.dev/docs/hooks, /hooks/types, /hooks/actions and
 * /cli/v3/hooks-migration on 2026-09-19: each hook file is `.kiro/hooks/<id>.json` with
 * `{ "version": "v1", "hooks": [ { name, trigger, action: { type: "command", command },
 * timeout } ] }`, the trigger's PascalCase name is `Stop`, and command actions "run a shell
 * command in your project root" and receive the session context as JSON on stdin
 * (`hook_event_name`, `cwd`, `session_id`, `assistant_response`).
 *
 * The Agent Stop section of /hooks/types documents a block decision:
 *   Exit Code Behavior
 *     0: "Hook succeeded. If STDOUT contains a block decision (see below), the agent
 *         continues instead of stopping."
 *     Other: "Show STDERR warning to user."
 *   Block Decision: "A stop hook can prevent the agent from stopping by returning JSON on
 *   STDOUT:"  {"decision": "block", "reason": "You haven't run the tests yet."}
 *   "When a stop hook returns `decision: block`, the `reason` is sent as a new user message
 *   to the agent, continuing the conversation."
 *
 * So violations are a block decision on stdout at exit 0. A clean run prints nothing,
 * because exit 0 stdout that is not a block decision is added to the agent's context. An
 * infrastructure failure exits 1 with the reason on stderr: no block decision means the
 * agent is never continued, and an empty stdout means nothing reaches its context.
 *
 * The trigger table's "Can block?" column is about blocking the triggering action, not
 * about continuing the agent, and reading it as the latter is what got this wrong first.
 */
export const kiroAdapter: AgentAdapter = {
  name: "kiro",
  title: "Kiro",
  feedback: "continues-agent",
  effect: "will be sent the report as a new user message and told to fix violations",

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
    // Exit 0 stdout that is not a block decision is added to the agent's context, so a
    // clean run must print nothing at all.
    if (!hasViolations(result)) return out(0);
    return out(0, jsonLine({ decision: "block", reason: report }));
  },

  deliverError(message: string): HookOutput {
    // No block decision, so the agent stops as it meant to, and an empty stdout keeps the
    // reason out of its context. Kiro shows a non-zero exit's stderr to the user.
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
