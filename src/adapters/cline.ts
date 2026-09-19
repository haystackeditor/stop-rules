import * as fs from "node:fs";
import * as path from "node:path";
import { clineHookScript } from "../plugins/cline.js";
import {
  anyExists,
  contextFrom,
  hasViolations,
  jsonLine,
  out,
  relative,
  writeExecutable,
} from "./shared.js";
import type { AgentAdapter, CheckResult, HookContext, HookOutput, InstallResult } from "./types.js";

/**
 * Cline's `TaskComplete` hook. Verified against the hooks README in the cline/cline
 * repository on 2026-09-19: hooks are executable files with a shebang, and the workspace
 * location for this event is `.clinerules/hooks/TaskComplete`; every hook gets
 * `{ clineVersion, hookName, taskId, workspaceRoots, ... }` on stdin; and every hook must
 * answer with `{ "cancel": boolean, "contextModification"?: string, "errorMessage"?: string }`
 * on stdout, where `contextModification` is "Context for future AI decisions". That is where
 * the report goes. The same README marks TaskComplete "coming soon!", so this adapter is
 * written to the documented contract but cannot fire until Cline ships the event. Exit codes
 * are not part of the documented contract, so every delivery exits 0 and answers in JSON.
 */
export const clineAdapter: AgentAdapter = {
  name: "cline",
  title: "Cline",
  feedback: "shown-to-user-only",
  effect:
    "gets the report as context for its next decisions, but cannot be told to keep working on it",

  detect(repoRoot: string): boolean {
    return anyExists(repoRoot, [".clinerules", ".cline"]);
  },

  command(bundlePath: string): string {
    return `node "<repo>/${bundlePath}" hook --agent cline`;
  },

  parseInput(stdinText: string): HookContext {
    return contextFrom(stdinText, {
      session: ["taskId"],
      cwdArray: ["workspaceRoots"],
    });
  },

  deliver(result: CheckResult, report: string): HookOutput {
    if (!hasViolations(result)) return out(0, jsonLine({ cancel: false }));
    return out(0, jsonLine({ cancel: false, contextModification: report }));
  },

  deliverError(message: string): HookOutput {
    // Answer the documented shape so Cline never treats the hook as broken, and put the
    // reason where a human can see it. Nothing is added to the agent's context.
    return out(0, jsonLine({ cancel: false }), `${message}\n`);
  },

  install(repoRoot: string, _command: string): InstallResult {
    const bundle = ".stop-rules/stop-rules.mjs";
    const file = path.join(repoRoot, ".clinerules", "hooks", "TaskComplete");
    const shown = relative(repoRoot, file);
    const wanted = clineHookScript(bundle);
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(file, "utf8");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        return { ok: false, files: [shown], changed: false, notes: [`could not read ${shown}: ${err.message}`] };
      }
    }
    if (existing !== null && !existing.includes("stop-rules")) {
      return {
        ok: false,
        files: [shown],
        changed: false,
        notes: [
          `${shown} already exists and is not a stop-rules hook. Nothing was changed.`,
          `Add this line to it yourself: exec node "$repo/${bundle}" hook --agent cline`,
        ],
      };
    }
    if (existing === wanted) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it is already the stop-rules hook`],
      };
    }
    writeExecutable(file, wanted);
    return {
      ok: true,
      files: [shown],
      changed: true,
      notes: [
        existing === null
          ? `wrote the executable hook ${shown}`
          : `updated the executable hook ${shown}`,
        "Cline runs hooks only when Enable Hooks is on in its Feature Settings.",
      ],
    };
  },
};
