import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ADAPTERS, agentNames, getAdapter } from "./adapters/index.js";
import type { AgentAdapter, InstallResult } from "./adapters/index.js";
import { findRepo } from "./git.js";
import { parseRules, STARTER_RULES } from "./rules.js";

/** Where the vendored single file lands inside the target repository. */
export const BUNDLE_PATH = ".stop-rules/stop-rules.mjs";
const BUNDLE_NAME = "stop-rules.mjs";

export interface InitAgentReport {
  name: string;
  title: string;
  feedback: string;
  effect: string;
  command: string;
  files: string[];
  changed: boolean;
  ok: boolean;
  notes: string[];
}

export interface InitReport {
  ok: boolean;
  repo: string;
  bundle: { path: string; written: boolean };
  rules: { path: string; created: boolean };
  agents: InitAgentReport[];
  todo: string[];
  /** Reasons the whole run could not proceed. */
  errors: string[];
}

export interface InitOptions {
  /** Directory to resolve the repository from. */
  dir: string;
  /** Explicit agent names, or undefined to use detection. */
  agents?: string[];
  /** Absolute path of the running module, used to find the bundle to copy. */
  selfPath: string;
}

function failure(repo: string, reason: string): InitReport {
  return {
    ok: false,
    repo,
    bundle: { path: BUNDLE_PATH, written: false },
    rules: { path: ".stop-rules.md", created: false },
    agents: [],
    todo: [],
    errors: [reason],
  };
}

/**
 * Where the single file bundle lives right now: either next to the running CLI in `dist/`,
 * or the running file itself when init is re-run from a repository's vendored copy.
 */
function bundleSource(selfPath: string): string {
  if (path.basename(selfPath) === BUNDLE_NAME) return selfPath;
  return path.join(path.dirname(selfPath), BUNDLE_NAME);
}

export async function init(options: InitOptions): Promise<InitReport> {
  const repo = await findRepo(options.dir);
  if (repo === null) {
    return failure(options.dir, `${options.dir} is not inside a git repository.`);
  }
  const root = repo.root;

  let chosen: AgentAdapter[];
  if (options.agents !== undefined) {
    const unknown = options.agents.filter((name) => getAdapter(name) === null);
    if (unknown.length > 0) {
      return failure(
        root,
        `unknown agent ${unknown.join(", ")}. Known agents: ${agentNames().join(", ")}`,
      );
    }
    const wanted = new Set(options.agents);
    chosen = ADAPTERS.filter((adapter) => wanted.has(adapter.name));
  } else {
    chosen = ADAPTERS.filter((adapter) => adapter.detect(root));
    if (chosen.length === 0) {
      return failure(
        root,
        `no coding agent detected in ${root}. Name one with --agents: ${agentNames().join(", ")}`,
      );
    }
  }

  const report: InitReport = {
    ok: true,
    repo: root,
    bundle: { path: BUNDLE_PATH, written: false },
    rules: { path: ".stop-rules.md", created: false },
    agents: [],
    todo: [],
    errors: [],
  };

  // 3. The vendored single file. Re-running init updates it.
  const source = bundleSource(options.selfPath);
  const target = path.join(root, BUNDLE_PATH);
  if (path.resolve(source) !== path.resolve(target)) {
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
      report.bundle.written = true;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return failure(
        root,
        err.code === "ENOENT"
          ? `no bundle at ${source}. Run "npm run build" in the stop-rules clone first.`
          : `could not copy the bundle to ${target}: ${err.message}`,
      );
    }
  }

  // 4. The rules file, only when it is absent.
  const rulesPath = path.join(root, ".stop-rules.md");
  try {
    await fs.writeFile(rulesPath, STARTER_RULES, { encoding: "utf8", flag: "wx" });
    report.rules.created = true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "EEXIST") {
      return failure(root, `could not write ${rulesPath}: ${err.message}`);
    }
  }

  // 5. One config per agent.
  for (const adapter of chosen) {
    const command = adapter.command(BUNDLE_PATH);
    let result: InstallResult;
    try {
      result = adapter.install(root, command);
    } catch (error) {
      result = {
        ok: false,
        files: [],
        changed: false,
        notes: [`could not install ${adapter.name}: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
    if (!result.ok) report.ok = false;
    report.agents.push({
      name: adapter.name,
      title: adapter.title,
      feedback: adapter.feedback,
      effect: adapter.effect,
      command,
      files: result.files,
      changed: result.changed,
      ok: result.ok,
      notes: result.notes,
    });
  }

  report.todo.push("Set TYPESAFE_API_KEY to your Jev API key from TypeSafe.");
  report.todo.push(
    `Edit ${report.rules.path} so it says what your team actually cares about.`,
  );
  report.todo.push(
    `Commit ${BUNDLE_PATH} and the config files, so teammates and cloud agents get the check too.`,
  );
  return report;
}

/** The human form of an init report. */
export function renderInit(report: InitReport): string[] {
  const lines: string[] = [];
  if (report.errors.length > 0) {
    for (const error of report.errors) lines.push(`stop-rules: ${error}`);
    return lines;
  }

  lines.push(`stop-rules in ${report.repo}`);
  lines.push(
    report.bundle.written
      ? `  wrote ${report.bundle.path}`
      : `  kept ${report.bundle.path} (it is the file running now)`,
  );
  lines.push(
    report.rules.created
      ? `  wrote ${report.rules.path} with ${parseRules(STARTER_RULES).length} starter rules`
      : `  kept the rules file already at ${report.rules.path}`,
  );
  lines.push("");
  for (const agent of report.agents) {
    lines.push(`${agent.title}: ${agent.effect}`);
    for (const note of agent.notes) lines.push(`  ${note}`);
    if (agent.changed) lines.push(`  command: ${agent.command}`);
  }
  lines.push("");
  lines.push("Left for you:");
  report.todo.forEach((item, index) => {
    lines.push(`  ${index + 1}. ${item}`);
  });
  return lines;
}
