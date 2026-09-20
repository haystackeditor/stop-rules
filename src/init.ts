import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ADAPTERS, agentNames, getAdapter } from "./adapters/index.js";
import type { AgentAdapter, InstallResult } from "./adapters/index.js";
import { readTeamEndpoint, writeTeamConfig } from "./credentials.js";
import { isSkippedPath } from "./diff.js";
import { findRepo, runGit } from "./git.js";
import {
  EXTENSIONS,
  GRAMMAR_TITLE,
  extensionOf,
  grammarWasmName,
  type GrammarKey,
} from "./languages.js";
import { parseRules, STARTER_RULES } from "./rules.js";
import { DEFAULT_CUT, loadSettings, SETTINGS_FILE, writeSettings } from "./settings.js";
import { grammarWasmPath, runtimeWasmPath, vendorDir } from "./treesitter.js";
import type { CutMode } from "./types.js";
import { isBundled } from "./version.js";

/** Where the vendored single file lands inside the target repository. */
export const BUNDLE_PATH = ".stop-rules/stop-rules.mjs";
const BUNDLE_NAME = "stop-rules.mjs";
/** Where the parser and the grammars land inside the target repository. */
export const VENDOR_DIR = ".stop-rules";

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

/** What the parser side of an install ended up with. */
export interface InitGrammars {
  /** Languages this repository has files in, so their grammars were copied. */
  languages: string[];
  /** Grammar files this run wrote for the first time. */
  added: string[];
  /** Grammar files that were already there. */
  kept: string[];
  /** Size of the whole .stop-rules folder afterwards, in bytes. */
  bytes: number;
}

export interface InitReport {
  ok: boolean;
  repo: string;
  /** How this repo will cut a change into pieces. `hunks` needs no parser files. */
  cut: CutMode;
  /** Team mode when this repo sends its questions to a team server, local mode otherwise. */
  mode: "team" | "local";
  bundle: { path: string; written: boolean };
  grammars: InitGrammars;
  rules: { path: string; created: boolean };
  /** The team server this repo now points at, and the file that says so. */
  team: { endpoint: string; path: string; written: boolean } | null;
  /** The settings file this run wrote, and which keys went into it. */
  settings: { path: string; wrote: string[] } | null;
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
  /** How this repo cuts a change into pieces. `hunks` copies no parser files. */
  cut?: CutMode;
  /** Environment, so an endpoint already set in it counts as team mode. */
  env: NodeJS.ProcessEnv;
}

function noGrammars(): InitGrammars {
  return { languages: [], added: [], kept: [], bytes: 0 };
}

function failure(repo: string, reason: string): InitReport {
  return {
    ok: false,
    repo,
    cut: DEFAULT_CUT,
    mode: "local",
    bundle: { path: BUNDLE_PATH, written: false },
    grammars: noGrammars(),
    rules: { path: ".stop-rules.md", created: false },
    team: null,
    settings: null,
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

  // The cut mode a flag asks for, else the one this repo already set, else the default.
  const existingSettings = await loadSettings(root);
  if (!existingSettings.ok) return failure(root, existingSettings.reason);
  const cut = options.cut ?? existingSettings.loaded.settings.cut ?? DEFAULT_CUT;

  const report: InitReport = {
    ok: true,
    repo: root,
    cut,
    mode: "local",
    bundle: { path: BUNDLE_PATH, written: false },
    grammars: noGrammars(),
    rules: { path: ".stop-rules.md", created: false },
    team: null,
    settings: null,
    agents: [],
    todo: [],
    errors: [],
  };

  // Team mode: write the endpoint into the repo, so no developer needs the Jev key.
  const wroteKeys: string[] = [];
  if (options.team !== undefined) {
    const written = await writeTeamConfig(root, options.team);
    if (!written.ok) {
      return failure(root, written.lines.join(" ").replace(/^stop-rules: /, ""));
    }
    report.mode = "team";
    report.team = { endpoint: options.team.trim(), path: SETTINGS_FILE, written: true };
    wroteKeys.push("endpoint");
  } else {
    // A teammate installing into a repository that is already on a team server.
    const existing = readTeamEndpoint(existingSettings.loaded, options.env);
    if (!existing.ok) return failure(root, existing.reason);
    if (existing.endpoint !== null) {
      report.mode = "team";
      report.team = { endpoint: existing.endpoint, path: existing.source, written: false };
    }
  }

  // The settings file is written only when this run has something to put in it.
  if (options.cut !== undefined) {
    const written = await writeSettings(root, { cut: options.cut });
    if (!written.ok) return failure(root, written.reason ?? `could not write ${written.file}`);
    wroteKeys.push("cut");
  }
  if (wroteKeys.length > 0) report.settings = { path: SETTINGS_FILE, wrote: wroteKeys };

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

  // 3b. The parser and the grammars, in functions mode. Hunks mode parses nothing, so it
  // copies no wasm files and .stop-rules holds only the one script.
  try {
    report.grammars =
      cut === "hunks"
        ? { languages: [], added: [], kept: [], bytes: await folderBytes(path.join(root, VENDOR_DIR)) }
        : await copyGrammars(root);
  } catch (error) {
    return failure(root, error instanceof Error ? error.message : String(error));
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
  const vendored = cut === "hunks" ? "the checker" : "the checker and its grammars";
  report.todo.push(
    report.mode === "team"
      ? `Commit ${VENDOR_DIR}/ (${vendored}), ${SETTINGS_FILE} and the config files, so teammates and cloud agents get the check too.`
      : `Commit ${VENDOR_DIR}/ (${vendored}) and the config files, so teammates and cloud agents get the check too.`,
  );
  report.todo.push("Check it works: stop-rules login --check");
  return report;
}

/**
 * Which grammars this repository needs, from the extensions of its tracked files. Files the
 * check skips anyway, including our own vendored bundle, do not earn a grammar.
 */
async function languagesInRepo(root: string): Promise<GrammarKey[]> {
  const listed = await runGit(root, ["ls-files"]);
  if (listed.code !== 0) {
    throw new Error(`git ls-files failed in ${root}: ${listed.stderr.trim()}`);
  }
  const keys = new Set<GrammarKey>();
  for (const line of listed.stdout.split("\n")) {
    if (line.length === 0) continue;
    if (isSkippedPath(line)) continue;
    const key = EXTENSIONS[extensionOf(line)];
    if (key !== undefined) keys.add(key);
  }
  return [...keys].sort();
}

async function copyIfNew(source: string, target: string): Promise<boolean> {
  let fresh = true;
  try {
    await fs.access(target);
    fresh = false;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw new Error(`could not look at ${target}: ${err.message}`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.copyFile(source, target);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    throw new Error(
      err.code === "ENOENT"
        ? `no file at ${source}. This stop-rules copy is incomplete: clone it again.`
        : `could not copy ${source} to ${target}: ${err.message}`,
    );
  }
  return fresh;
}

/** Bytes used by a folder and everything in it. */
async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await folderBytes(full);
    else total += (await fs.stat(full)).size;
  }
  return total;
}

/**
 * Copies the tree-sitter runtime and only the grammars this repository needs. Running init
 * again adds the ones that are missing and leaves the rest alone.
 */
async function copyGrammars(root: string): Promise<InitGrammars> {
  const from = vendorDir();
  const into = path.join(root, VENDOR_DIR);
  const languages = await languagesInRepo(root);
  await copyIfNew(runtimeWasmPath(from), path.join(into, "tree-sitter.wasm"));
  const added: string[] = [];
  const kept: string[] = [];
  for (const key of languages) {
    const name = grammarWasmName(key);
    const fresh = await copyIfNew(grammarWasmPath(key, from), path.join(into, "grammars", name));
    if (fresh) added.push(name);
    else kept.push(name);
  }
  return {
    languages: languages.map((key) => GRAMMAR_TITLE[key]),
    added,
    kept,
    bytes: await folderBytes(into),
  };
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
  const grammars = report.grammars;
  const megabytes = (grammars.bytes / 1_000_000).toFixed(1);
  if (report.cut === "hunks") {
    lines.push(
      `  cut: hunks, so no parser and no grammars were copied (${VENDOR_DIR} is ${megabytes} MB)`,
    );
  } else {
    lines.push(
      grammars.languages.length === 0
        ? `  no file in this repo has a language stop-rules can parse, so it copied no grammars (${VENDOR_DIR} is ${megabytes} MB)`
        : `  grammars for ${grammars.languages.join(", ")}: ${grammars.added.length} copied, ${grammars.kept.length} already there (${VENDOR_DIR} is ${megabytes} MB)`,
    );
  }
  lines.push(
    report.rules.created
      ? `  wrote ${report.rules.path} with ${parseRules(STARTER_RULES).length} starter rules`
      : `  kept the rules file already at ${report.rules.path}`,
  );
  // The endpoint has a line of its own below, so only the other keys are named here.
  const otherKeys = report.settings?.wrote.filter((key) => key !== "endpoint") ?? [];
  if (report.settings !== null && otherKeys.length > 0) {
    lines.push(`  wrote ${otherKeys.join(" and ")} into ${report.settings.path}`);
  }
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
