import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ADAPTERS, agentNames, getAdapter } from "./adapters/index.js";
import type { AgentAdapter, InstallResult } from "./adapters/index.js";
import { readTeamEndpoint, TEAM_CONFIG_FILE, writeTeamConfig } from "./credentials.js";
import { findRepo } from "./git.js";
import { parseRules, STARTER_RULES } from "./rules.js";
import { isBundled } from "./version.js";

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
  /** Team mode when this repo sends its questions to a team server, local mode otherwise. */
  mode: "team" | "local";
  bundle: { path: string; written: boolean };
  rules: { path: string; created: boolean };
  /** The team server this repo now points at, and the file that says so. */
  team: { endpoint: string; path: string; written: boolean } | null;
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
  /** Team mode: the stop-rules server every developer's hook should send questions to. */
  team?: string;
  /** Environment, so an endpoint already set in it counts as team mode. */
  env?: NodeJS.ProcessEnv;
}

function failure(repo: string, reason: string): InitReport {
  return {
    ok: false,
    repo,
    mode: "local",
    bundle: { path: BUNDLE_PATH, written: false },
    rules: { path: ".stop-rules.md", created: false },
    team: null,
    agents: [],
    todo: [],
    errors: [reason],
  };
}

/**
 * Where the single file bundle lives right now. When the file running this code IS the
 * bundle, that file is the source, whatever it has been renamed to: a copy called
 * stop-rules-snapshot.mjs used to fail while looking for a stop-rules.mjs beside itself.
 * Running unbundled from dist/cli.js, the bundle is its sibling dist/stop-rules.mjs.
 */
function bundleSource(selfPath: string): string {
  if (isBundled()) return selfPath;
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
    mode: "local",
    bundle: { path: BUNDLE_PATH, written: false },
    rules: { path: ".stop-rules.md", created: false },
    team: null,
    agents: [],
    todo: [],
    errors: [],
  };

  // Team mode: write the endpoint into the repo, so no developer needs the Jev key.
  if (options.team !== undefined) {
    const written = await writeTeamConfig(root, options.team);
    if (!written.ok) {
      return failure(root, written.lines.join(" ").replace(/^stop-rules: /, ""));
    }
    report.mode = "team";
    report.team = { endpoint: options.team.trim(), path: TEAM_CONFIG_FILE, written: true };
  } else {
    // A teammate installing into a repository that is already on a team server.
    const existing = await readTeamEndpoint(root, options.env ?? {});
    if (!existing.ok) return failure(root, existing.reason);
    if (existing.endpoint !== null) {
      report.mode = "team";
      report.team = { endpoint: existing.endpoint, path: existing.source, written: false };
    }
  }

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

  // What is left for the human depends on where the Jev key lives.
  report.todo.push(
    report.mode === "team"
      ? 'Store the team token: printf %s "$TOKEN" | stop-rules login --token-stdin'
      : 'Give it your own Jev key from TypeSafe: set TYPESAFE_API_KEY, or run printf %s "$KEY" | stop-rules login --jev-key-stdin',
  );
  report.todo.push(`Edit ${report.rules.path} so it says what your team actually cares about.`);
  report.todo.push(
    report.mode === "team"
      ? `Commit ${BUNDLE_PATH}, ${TEAM_CONFIG_FILE} and the config files, so teammates and cloud agents get the check too.`
      : `Commit ${BUNDLE_PATH} and the config files, so teammates and cloud agents get the check too.`,
  );
  report.todo.push("Check it works: stop-rules login --check");
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
  if (report.team !== null) {
    lines.push(
      report.team.written
        ? `  wrote ${report.team.path} pointing at ${report.team.endpoint}`
        : `  team server already set to ${report.team.endpoint} (from ${report.team.path})`,
    );
  }
  lines.push(
    report.mode === "team"
      ? "  mode: team (the Jev key stays on your team's server)"
      : "  mode: local (this machine needs your own Jev key)",
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
