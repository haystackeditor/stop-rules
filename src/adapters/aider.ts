import * as fs from "node:fs";
import * as path from "node:path";
import { anyExists, hasViolations, out, relative } from "./shared.js";
import type { AgentAdapter, CheckResult, HookContext, HookOutput, InstallResult } from "./types.js";

const CONFIG = ".aider.conf.yml";

/**
 * Aider has no hook system, so stop-rules installs itself as aider's linter. Verified
 * against aider's linting docs and `aider/linter.py` on 2026-09-19: `--lint-cmd <cmd>`
 * without a `language:` prefix applies to every language, `auto-lint` defaults to true,
 * and aider "expects the command to print [errors] on stdout/stderr and return a non-zero
 * exit code". `Linter.run_cmd` appends the edited file name to the command and runs it
 * through a shell with the repo root as its working directory, capturing stdout with stderr
 * merged in, and ignores all output when the exit status is zero. Hence the trailing `--`
 * in the installed command, which makes stop-rules ignore the appended file name, the
 * report on stdout, and an infrastructure failure reported on stderr with exit 0 so a
 * missing API key is never handed to the model as a lint error.
 */
export const aiderAdapter: AgentAdapter = {
  name: "aider",
  title: "Aider",
  feedback: "continues-agent",
  effect: "reads the report as lint output and tries to fix the violations",
  stdin: "none",

  detect(repoRoot: string): boolean {
    return anyExists(repoRoot, [CONFIG]);
  },

  command(bundlePath: string): string {
    // The trailing -- swallows the file name aider appends to every lint command.
    return `node "${bundlePath}" hook --agent aider --`;
  },

  parseInput(_stdinText: string): HookContext {
    // Aider has no hook payload and no conversation id at all: it runs a lint command in
    // the repository root. So the process cwd and one fixed session id ARE the contract
    // here, not a stand in for something that went missing.
    return { sessionId: "aider" };
  },

  deliver(result: CheckResult, report: string): HookOutput {
    if (!hasViolations(result)) return out(0);
    return out(2, `${report}\n`);
  },

  deliverError(message: string): HookOutput {
    // Exit 0: a non-zero exit would be read as lint errors and handed to the model.
    return out(0, "", `${message}\n`);
  },

  install(repoRoot: string, command: string): InstallResult {
    const file = path.join(repoRoot, CONFIG);
    const shown = relative(repoRoot, file);
    const line = `- ${JSON.stringify(command)}`;
    let existing = "";
    try {
      existing = fs.readFileSync(file, "utf8");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        return {
          ok: false,
          files: [shown],
          changed: false,
          notes: [`could not read ${shown}: ${err.message}`],
        };
      }
    }
    const lines = existing.split(/\r?\n/);
    const hasLintCmd = lines.some((entry) => /^lint-cmd\s*:/.test(entry));
    const hasStopRules = existing.includes("stop-rules.mjs");

    if (hasStopRules) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: its lint-cmd already runs stop-rules`],
      };
    }
    if (hasLintCmd) {
      return {
        ok: false,
        files: [shown],
        changed: false,
        notes: [
          `${shown} already sets lint-cmd. Nothing was changed, so your linter keeps working.`,
          `To run both, add this line under lint-cmd in ${shown}:`,
          `  ${line}`,
        ],
      };
    }

    const hasAutoLint = lines.some((entry) => /^auto-lint\s*:/.test(entry));
    const addition = [
      "",
      "# Added by stop-rules. Re-run \"stop-rules init\" to update it.",
      ...(hasAutoLint ? [] : ["auto-lint: true"]),
      "lint-cmd:",
      `  ${line}`,
      "",
    ].join("\n");
    const body = existing.length === 0 ? addition.replace(/^\n/, "") : `${existing.replace(/\n*$/, "\n")}${addition}`;
    fs.writeFileSync(file, body, "utf8");
    const notes = [
      existing.length === 0 ? `created ${shown} with a lint-cmd` : `added a lint-cmd to ${shown}`,
    ];
    if (hasAutoLint) notes.push(`${shown} already sets auto-lint: check that it is true.`);
    return { ok: true, files: [shown], changed: true, notes };
  },
};
