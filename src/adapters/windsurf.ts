import * as path from "node:path";
import {
  anyExists,
  asArray,
  asRecord,
  contextFrom,
  exitTwoOnStderr,
  failed,
  mentionsStopRules,
  out,
  readJsonFile,
  relative,
  writeJsonFile,
} from "./shared.js";
import type { AgentAdapter, CheckResult, HookContext, HookOutput, InstallResult } from "./types.js";

/**
 * Windsurf Cascade's `post_cascade_response` hook. Verified against the Windsurf hooks
 * documentation on 2026-09-19: workspace config is `.windsurf/hooks.json` with
 * `{ "hooks": { "post_cascade_response": [ { command } ] } }`; `working_directory` "Defaults
 * to your workspace root", so a relative command path works; the payload carries
 * `trajectory_id` and `execution_id` but no `cwd`; exit code 2 means "The Cascade agent will
 * see the error message from stderr", and only pre-hooks can block, so the report reaches the
 * agent but cannot force more work; and the docs say `show_output` "does not apply to this
 * hook", so it is left out rather than written and ignored.
 */
export const windsurfAdapter: AgentAdapter = {
  name: "windsurf",
  title: "Windsurf Cascade",
  feedback: "shown-to-user-only",
  effect: "gets the report after the response, but cannot be told to keep working on it",

  detect(repoRoot: string): boolean {
    return anyExists(repoRoot, [".windsurf"]);
  },

  command(bundlePath: string): string {
    return `node "${bundlePath}" hook --agent windsurf`;
  },

  parseInput(stdinText: string): HookContext {
    // No workspace path in this event's payload, so the CLI falls back to its own cwd,
    // which Windsurf sets to the workspace root.
    return contextFrom(stdinText, { session: ["trajectory_id", "execution_id"] });
  },

  deliver(result: CheckResult, report: string): HookOutput {
    return exitTwoOnStderr(result, report);
  },

  deliverError(message: string): HookOutput {
    return out(1, "", `${message}\n`);
  },

  install(repoRoot: string, command: string): InstallResult {
    const file = path.join(repoRoot, ".windsurf", "hooks.json");
    const shown = relative(repoRoot, file);
    const read = readJsonFile(file, shown);
    if (!read.ok) return failed(shown, read.reason);

    const config = read.value;
    const hooks = asRecord(config["hooks"]);
    const list = asArray(hooks["post_cascade_response"]);
    if (list.some(mentionsStopRules)) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it already has a stop-rules post_cascade_response hook`],
      };
    }
    list.push({ command });
    hooks["post_cascade_response"] = list;
    config["hooks"] = hooks;
    writeJsonFile(file, config);
    return {
      ok: true,
      files: [shown],
      changed: true,
      notes: [
        read.existed
          ? `merged a post_cascade_response hook into ${shown}, keeping everything that was already there`
          : `created ${shown} with a post_cascade_response hook`,
      ],
    };
  },
};
