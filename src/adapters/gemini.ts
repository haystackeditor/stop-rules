import * as path from "node:path";
import {
  anyExists,
  recordAt,
  contextFrom,
  failed,
  hasViolations,
  jsonLine,
  mergeHookGroup,
  out,
  readJsonFile,
  relative,
  wrongShape,
  writeJsonFile,
} from "./shared.js";
import type { AgentAdapter, CheckResult, HookContext, HookOutput, InstallResult } from "./types.js";

/**
 * Gemini CLI's `AfterAgent` hook. Verified against the Gemini CLI hooks reference and index
 * on 2026-09-19: project config is `.gemini/settings.json` under `hooks.AfterAgent[]` with
 * `{ matcher, hooks: [{ name, type: "command", command, timeout }] }` and `timeout` in
 * MILLISECONDS; the base input carries `session_id` and `cwd`; "Exit Code 2 (Retry):
 * Rejects the response and triggers an automatic retry turn using `stderr` as the feedback
 * prompt"; stdout must carry nothing but JSON, and the docs' own no-op prints `{}`, so a
 * clean run prints `{}` rather than staying silent. "Other" exit codes are a non-fatal
 * warning shown to the user, which is what an infrastructure failure should be.
 */
export const geminiAdapter: AgentAdapter = {
  name: "gemini",
  title: "Gemini CLI",
  feedback: "continues-agent",
  effect: "will retry the turn with the report as its feedback prompt",

  detect(repoRoot: string): boolean {
    return anyExists(repoRoot, [".gemini"]);
  },

  command(bundlePath: string): string {
    return `node "$GEMINI_PROJECT_DIR/${bundlePath}" hook --agent gemini`;
  },

  parseInput(stdinText: string): HookContext {
    return contextFrom(stdinText, {
      agent: "Gemini CLI",
      session: ["session_id"],
      cwd: ["cwd"],
      stopHookActive: ["stop_hook_active"],
    });
  },

  deliver(result: CheckResult, report: string): HookOutput {
    if (!hasViolations(result)) return out(0, jsonLine({}));
    return out(2, "", `${report}\n`);
  },

  deliverError(message: string): HookOutput {
    return out(1, "", `${message}\n`);
  },

  install(repoRoot: string, command: string): InstallResult {
    const file = path.join(repoRoot, ".gemini", "settings.json");
    const shown = relative(repoRoot, file);
    const read = readJsonFile(file, shown);
    if (!read.ok) return failed(shown, read.reason);

    const settings = read.value;
    const hooks = recordAt(settings, "hooks");
    if (hooks === null) return failed(shown, wrongShape(shown, "hooks", "an object"));
    const merged = mergeHookGroup(
      hooks,
      shown,
      "AfterAgent",
      { name: "stop-rules", type: "command", command, timeout: 120000 },
      { matcher: "*" },
    );
    if (!merged.ok) return failed(shown, merged.reason);
    if (!merged.changed) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it already has a stop-rules AfterAgent hook`],
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
          ? `merged an AfterAgent hook into ${shown}, keeping everything that was already there`
          : `created ${shown} with an AfterAgent hook`,
      ],
    };
  },
};
