import { promises as fs } from "node:fs";
import * as path from "node:path";
import { findRepo } from "./git.js";
import { parseRules, STARTER_RULES } from "./rules.js";

export interface InitResult {
  ok: boolean;
  /** Lines to print, whether or not it worked. */
  lines: string[];
}

interface HookCommandEntry {
  type: string;
  command: string;
  asyncRewake?: boolean;
  timeout?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStopRulesHook(stopEntries: unknown): boolean {
  if (!Array.isArray(stopEntries)) return false;
  for (const group of stopEntries) {
    if (!isRecord(group)) continue;
    const hooks = group["hooks"];
    if (!Array.isArray(hooks)) continue;
    for (const hook of hooks) {
      if (!isRecord(hook)) continue;
      const command = hook["command"];
      if (typeof command === "string" && command.includes("stop-rules")) return true;
    }
  }
  return false;
}

/** Writes the starter rules file and merges a Stop hook into .claude/settings.json. */
export async function init(cwd: string, cliPath: string): Promise<InitResult> {
  const lines: string[] = [];
  const repo = await findRepo(cwd);
  if (repo === null) {
    return { ok: false, lines: [`stop-rules: ${cwd} is not inside a git repository.`] };
  }

  const rulesPath = path.join(repo.root, ".stop-rules.md");
  try {
    await fs.writeFile(rulesPath, STARTER_RULES, { encoding: "utf8", flag: "wx" });
    lines.push(`wrote ${rulesPath} with ${parseRules(STARTER_RULES).length} starter rules`);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "EEXIST") {
      return { ok: false, lines: [`stop-rules: could not write ${rulesPath}: ${err.message}`] };
    }
    lines.push(`kept the rules file that is already at ${rulesPath}`);
  }

  const settingsPath = path.join(repo.root, ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  let existed = false;
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    existed = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        ok: false,
        lines: [
          `stop-rules: ${settingsPath} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
          "Nothing was changed. Fix the file and run init again.",
        ],
      };
    }
    if (!isRecord(parsed)) {
      return {
        ok: false,
        lines: [
          `stop-rules: ${settingsPath} does not hold a JSON object.`,
          "Nothing was changed. Fix the file and run init again.",
        ],
      };
    }
    settings = parsed;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      return { ok: false, lines: [`stop-rules: could not read ${settingsPath}: ${err.message}`] };
    }
  }

  const hooks = isRecord(settings["hooks"]) ? settings["hooks"] : {};
  const stop = Array.isArray(hooks["Stop"]) ? [...(hooks["Stop"] as unknown[])] : [];

  if (hasStopRulesHook(stop)) {
    lines.push(`left ${settingsPath} alone: it already has a stop-rules Stop hook`);
  } else {
    const entry: HookCommandEntry = {
      type: "command",
      command: `node "${cliPath}" hook`,
      asyncRewake: true,
      timeout: 120,
    };
    stop.push({ hooks: [entry] });
    hooks["Stop"] = stop;
    settings["hooks"] = hooks;
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    lines.push(
      existed
        ? `merged a Stop hook into ${settingsPath}, keeping everything that was already there`
        : `created ${settingsPath} with a Stop hook`,
    );
    lines.push(`  command: node "${cliPath}" hook`);
    lines.push("  asyncRewake: true, timeout: 120");
  }

  lines.push("");
  lines.push("Two things left for you:");
  lines.push("  1. Set TYPESAFE_API_KEY to your Jev API key from TypeSafe.");
  lines.push(`  2. Edit ${rulesPath} so it says what your team actually cares about.`);
  return { ok: true, lines };
}
