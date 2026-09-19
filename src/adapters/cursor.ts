import * as path from "node:path";
import {
  anyExists,
  arrayAt,
  contextFrom,
  failed,
  hasViolations,
  jsonLine,
  mentionsStopRules,
  out,
  readJsonFile,
  recordAt,
  relative,
  wrongShape,
  writeJsonFile,
} from "./shared.js";
import type { AgentAdapter, CheckResult, HookContext, HookOutput, InstallResult } from "./types.js";

/**
 * Cursor's `stop` hook. Verified against cursor.com/docs/hooks.md on 2026-09-19: the
 * config is `.cursor/hooks.json` with `{ "version": 1, "hooks": { "stop": [ { command } ] } }`;
 * the stop input is the shared base (`conversation_id`, `workspace_roots`, ...) plus
 * `status` and `loop_count`, with no `cwd`; the output is `{ "followup_message": "..." }`,
 * which "Cursor will automatically submit as the next user message"; and project hooks run
 * from the project root, so the command may be a path relative to it. Cursor caps automatic
 * follow-ups per script (default 5) through `loop_limit`, on top of our own loop guard.
 */
export const cursorAdapter: AgentAdapter = {
  name: "cursor",
  title: "Cursor",
  feedback: "continues-agent",
  effect: "will be sent the report as the next user message and told to fix violations",

  detect(repoRoot: string): boolean {
    return anyExists(repoRoot, [".cursor"]);
  },

  command(bundlePath: string): string {
    return `node "${bundlePath}" hook --agent cursor`;
  },

  parseInput(stdinText: string): HookContext {
    return contextFrom(stdinText, {
      agent: "Cursor",
      session: ["conversation_id", "session_id"],
      cwdArray: ["workspace_roots"],
      loopCount: ["loop_count"],
    });
  },

  deliver(result: CheckResult, report: string): HookOutput {
    if (!hasViolations(result)) return out(0, jsonLine({}));
    return out(0, jsonLine({ followup_message: report }));
  },

  deliverError(message: string): HookOutput {
    // A non-zero exit other than 2 is a logged hook failure and the turn proceeds, which
    // is what an infrastructure problem should look like: no follow-up message.
    return out(1, "", `${message}\n`);
  },

  install(repoRoot: string, command: string): InstallResult {
    const file = path.join(repoRoot, ".cursor", "hooks.json");
    const shown = relative(repoRoot, file);
    const read = readJsonFile(file, shown);
    if (!read.ok) return failed(shown, read.reason);

    const config = read.value;
    const version = config["version"];
    if (version === undefined) config["version"] = 1;
    else if (typeof version !== "number") {
      return failed(shown, wrongShape(shown, "version", "a number"));
    }
    const hooks = recordAt(config, "hooks");
    if (hooks === null) return failed(shown, wrongShape(shown, "hooks", "an object"));
    const stop = arrayAt(hooks, "stop");
    if (stop === null) return failed(shown, wrongShape(shown, "stop", "a list"));
    if (stop.some(mentionsStopRules)) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it already has a stop-rules stop hook`],
      };
    }
    stop.push({ command });
    hooks["stop"] = stop;
    config["hooks"] = hooks;
    writeJsonFile(file, config);
    return {
      ok: true,
      files: [shown],
      changed: true,
      notes: [
        read.existed
          ? `merged a stop hook into ${shown}, keeping everything that was already there`
          : `created ${shown} with a stop hook`,
      ],
    };
  },
};
