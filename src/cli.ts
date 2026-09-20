#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { DEFAULT_AGENT, agentNames, getAdapter } from "./adapters/index.js";
import type { AgentAdapter, HookContext, HookOutput } from "./adapters/index.js";
import { resetBaseline, run, type RunOutcome } from "./check.js";
import { login, loginCheck, writeTeamConfig } from "./credentials.js";
import { DEFAULT_MAX_CALLS, DEFAULT_THRESHOLD } from "./engine.js";
import { resolveRepo, type RepoResolution } from "./repo.js";
import { init, renderInit } from "./init.js";
import { DEFAULT_CUT, SETTINGS_FILE } from "./settings.js";
import type { CutMode } from "./types.js";
import { serveMain } from "./server/node.js";
import { VERSION } from "./version.js";

const USAGE = `stop-rules: check the code your agent just wrote against your team's rules.

Usage:
  stop-rules hook [options]            run as a stop hook, reading the agent's JSON on stdin
  stop-rules check [options]           run the same check in a terminal, pre-commit or CI
  stop-rules score [options]           print every piece and every rule's score, no cutoff
  stop-rules init [options]            vendor the checker and wire it into your agents
  stop-rules team <endpoint>           point this repo at your team's stop-rules server
  stop-rules login --token-stdin       store the team token, read from stdin
  stop-rules login --jev-key-stdin     store your own Jev key, read from stdin
  stop-rules login --check             check the endpoint and one real Jev call
  stop-rules serve [--port n]          run the team server (it holds the Jev key)
  stop-rules baseline --reset          forget what was checked; start again from HEAD

Options:
  --agent <name>       hook mode only: which agent's protocol to speak (default ${DEFAULT_AGENT})
  --agents <a,b,c>     init mode only: which agents to wire up (default: the ones detected)
  --dir <path>         the repository to work on (default: the one holding the current folder)
  --team <endpoint>    init mode only: use your team's stop-rules server, not your own key
  --rules <path>       rules file (default <repo root>/.stop-rules.md)
  --cut <mode>         functions (tree-sitter), hunks or chunks (no parser) (default ${DEFAULT_CUT})
  --threshold <0..1>   score at or above which a rule counts as violated (default ${DEFAULT_THRESHOLD})
  --max-calls <n>      hard ceiling on requests to Jev in one run (default ${DEFAULT_MAX_CALLS})
  --base <rev>         check and score modes: diff this revision against the working tree
  --diff <path>        score mode only: score a unified diff file instead of the working tree
  --json               print the findings, or the init result, as JSON
  --port <n>           serve mode only: port to listen on (default PORT or 8080)
  --reset              baseline mode only: clear the saved baseline
  --                   stop reading options: anything after it is ignored
  --help               print this text
  --version            print the version

Agents: ${agentNames().join(", ")}

Settings: ${SETTINGS_FILE} in the repository root holds endpoint, cut, threshold and
maxCalls. It is committed and holds no secret. A flag above beats the file. What each knob
costs is in docs/TUNING.md.

Environment, client:
  STOP_RULES_ENDPOINT      your team's stop-rules server, beats .stop-rules.json
  STOP_RULES_TOKEN         the team token, beats the stored token file
  TYPESAFE_API_KEY         your own Jev API key, used when there is no team endpoint
  TYPESAFE_API_KEY_FILE    a file holding that key, used when the variable above is unset
  STOP_RULES_JEV_ENDPOINT  override the Jev endpoint in local mode
  STOP_RULES_JEV_MODEL     override the Jev model

Environment, server (stop-rules serve and every cloud deploy):
  TYPESAFE_API_KEY         the Jev key the server holds on the team's behalf
  STOP_RULES_TOKEN         the token every developer's hook sends
  STOP_RULES_JEV_UPSTREAM  override where the server forwards questions
  PORT                     port to listen on

Exit codes: 0 clean, 2 violations, 1 could not run. Some agents need a different code to
carry the report, so the hook exit code is whatever that agent documents.
`;

interface ParsedArgs {
  command: string;
  /** The one positional a command can take, today only `team <endpoint>`. */
  operand?: string;
  rules?: string;
  /** Undefined when the flag was not given, so the settings file can have its say. */
  threshold?: number;
  maxCalls?: number;
  cut?: CutMode;
  base?: string;
  diff?: string;
  json: boolean;
  agent: string;
  agents?: string[];
  dir?: string;
  team?: string;
  port?: number;
  tokenStdin: boolean;
  jevKeyStdin: boolean;
  check: boolean;
  reset: boolean;
  help: boolean;
  version: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: "",
    json: false,
    agent: DEFAULT_AGENT,
    tokenStdin: false,
    jevKeyStdin: false,
    check: false,
    reset: false,
    help: false,
    version: false,
  };

  const take = (index: number, flag: string): string => {
    const value = argv[index];
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    switch (arg) {
      case "--":
        // Everything after this belongs to whoever wrapped us, such as the file names
        // aider appends to its lint command. Not ours to read.
        return parsed;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--version":
      case "-v":
        parsed.version = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--token-stdin":
        parsed.tokenStdin = true;
        break;
      case "--jev-key-stdin":
        parsed.jevKeyStdin = true;
        break;
      case "--check":
        parsed.check = true;
        break;
      case "--reset":
        parsed.reset = true;
        break;
      case "--port": {
        i += 1;
        const value = Number(take(i, "--port"));
        if (!Number.isInteger(value) || value < 0 || value > 65535) {
          throw new UsageError("--port must be a port number");
        }
        parsed.port = value;
        break;
      }
      case "--rules":
        i += 1;
        parsed.rules = take(i, "--rules");
        break;
      case "--base":
        i += 1;
        parsed.base = take(i, "--base");
        break;
      case "--diff":
        i += 1;
        parsed.diff = take(i, "--diff");
        break;
      case "--cut": {
        i += 1;
        const value = take(i, "--cut");
        if (value !== "functions" && value !== "hunks" && value !== "chunks") {
          throw new UsageError("--cut must be functions, hunks or chunks");
        }
        parsed.cut = value;
        break;
      }
      case "--agent":
        i += 1;
        parsed.agent = take(i, "--agent");
        break;
      case "--agents": {
        i += 1;
        const names = take(i, "--agents")
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0);
        if (names.length === 0) throw new UsageError("--agents needs at least one agent name");
        parsed.agents = names;
        break;
      }
      case "--dir":
        i += 1;
        parsed.dir = take(i, "--dir");
        break;
      case "--team":
        i += 1;
        parsed.team = take(i, "--team");
        break;
      case "--threshold": {
        i += 1;
        const value = Number(take(i, "--threshold"));
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          throw new UsageError("--threshold must be a number between 0 and 1");
        }
        parsed.threshold = value;
        break;
      }
      case "--max-calls": {
        i += 1;
        const value = Number(take(i, "--max-calls"));
        if (!Number.isInteger(value) || value < 1) {
          throw new UsageError("--max-calls must be a whole number of 1 or more");
        }
        parsed.maxCalls = value;
        break;
      }
      default:
        if (arg.startsWith("-")) throw new UsageError(`unknown flag ${arg}`);
        if (parsed.command.length === 0) parsed.command = arg;
        else if (parsed.operand === undefined) parsed.operand = arg;
        else throw new UsageError(`unexpected argument ${arg}`);
    }
  }
  return parsed;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY === true) return "";
  const parts: Buffer[] = [];
  for await (const part of process.stdin) parts.push(part as Buffer);
  return Buffer.concat(parts).toString("utf8");
}

/**
 * The absolute path of the file running right now. `init` vendors it when it is the bundle,
 * and every command compares it with the repository it resolved, so a vendored copy never
 * works on another repository. Node gives a file: URL for every module loaded from disk, so
 * anything else means this code is running somewhere with no file to point at.
 */
function runningFile(): string {
  if (!import.meta.url.startsWith("file:")) {
    throw new Error(`stop-rules is running from ${import.meta.url}, which is not a file on disk`);
  }
  return fileURLToPath(import.meta.url);
}

/** The one repository rule, for every command. Prints the reason and returns null on a stop. */
async function repoFor(args: ParsedArgs, cwd: string): Promise<RepoResolution> {
  return resolveRepo({
    cwd,
    selfPath: runningFile(),
    ...(args.dir !== undefined ? { dir: args.dir } : {}),
  });
}

function reportRepo(resolution: RepoResolution & { ok: false }): number {
  process.stderr.write(`stop-rules: ${resolution.reason}\n`);
  return 1;
}

function emit(delivery: HookOutput): number {
  if (delivery.stdout.length > 0) process.stdout.write(delivery.stdout);
  if (delivery.stderr.length > 0) process.stderr.write(delivery.stderr);
  return delivery.exitCode;
}

function deliverOutcome(adapter: AgentAdapter, outcome: RunOutcome): HookOutput {
  switch (outcome.kind) {
    case "scored":
      throw new Error("internal error: the hook asked for a check and got a score report");
    case "cannot-run":
      return adapter.deliverError(`stop-rules: ${outcome.reason}`);
    case "handoff":
      // Too many rounds on the same violations. This one is for the user, not the agent.
      return adapter.deliverError(outcome.text);
    case "clean":
    case "violations":
      return adapter.deliver(outcome.report, outcome.text);
  }
}

async function runHook(args: ParsedArgs): Promise<number> {
  const adapter = getAdapter(args.agent);
  if (adapter === null) {
    process.stderr.write(
      `stop-rules: unknown agent ${args.agent}. Known agents: ${agentNames().join(", ")}\n`,
    );
    return 1;
  }
  let input: HookContext;
  try {
    const payload = adapter.stdin === "none" ? "" : await readStdin();
    input = adapter.parseInput(payload);
  } catch (error) {
    process.stderr.write(`stop-rules: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  // The payload's directory, or this process's when the agent documents none. --dir beats
  // both, and either way the repository is resolved by the one rule.
  const cwd = input.cwd === undefined ? process.cwd() : input.cwd;
  const resolved = await repoFor(args, cwd);
  if (!resolved.ok) return emit(adapter.deliverError(`stop-rules: ${resolved.reason}`));
  const outcome = await run({
    repo: resolved.repo,
    cwd,
    mode: "hook",
    sessionId: input.sessionId,
    stopHookActive: input.stopHookActive === true,
    ...knobArgs(args),
    ...(input.loopCount !== undefined ? { loopCount: input.loopCount } : {}),
  });
  return emit(deliverOutcome(adapter, outcome));
}

/** The knobs a flag can set. Left out when the flag was not given. */
function knobArgs(args: ParsedArgs): {
  threshold?: number;
  maxCalls?: number;
  cut?: CutMode;
  rulesPath?: string;
} {
  return {
    ...(args.threshold !== undefined ? { threshold: args.threshold } : {}),
    ...(args.maxCalls !== undefined ? { maxCalls: args.maxCalls } : {}),
    ...(args.cut !== undefined ? { cut: args.cut } : {}),
    ...(args.rules !== undefined ? { rulesPath: args.rules } : {}),
  };
}

async function runCheckCommand(args: ParsedArgs): Promise<number> {
  const resolved = await repoFor(args, process.cwd());
  if (!resolved.ok) return reportRepo(resolved);
  const outcome = await run({
    repo: resolved.repo,
    cwd: process.cwd(),
    mode: "check",
    ...knobArgs(args),
    ...(args.base !== undefined ? { base: args.base } : {}),
  });
  if (outcome.kind === "cannot-run") {
    process.stderr.write(`stop-rules: ${outcome.reason}\n`);
    return 1;
  }
  if (args.json) process.stdout.write(`${JSON.stringify(outcome.report, null, 2)}\n`);
  else process.stdout.write(`${outcome.text}\n`);
  return outcome.kind === "violations" ? 2 : 0;
}

/** Read only: every piece, every rule, every score, and no cutoff applied. */
async function runScoreCommand(args: ParsedArgs): Promise<number> {
  if (args.diff !== undefined && args.base !== undefined) {
    process.stderr.write("stop-rules: score takes --diff or --base, not both\n");
    return 1;
  }
  const resolved = await repoFor(args, process.cwd());
  if (!resolved.ok) return reportRepo(resolved);
  const outcome = await run({
    repo: resolved.repo,
    cwd: process.cwd(),
    mode: "score",
    ...knobArgs(args),
    ...(args.base !== undefined ? { base: args.base } : {}),
    ...(args.diff !== undefined ? { diffFile: args.diff } : {}),
  });
  if (outcome.kind === "cannot-run") {
    process.stderr.write(`stop-rules: ${outcome.reason}\n`);
    return 1;
  }
  if (outcome.kind !== "scored") {
    throw new Error(`internal error: score mode returned a ${outcome.kind} outcome`);
  }
  if (args.json) process.stdout.write(`${JSON.stringify(outcome.report, null, 2)}\n`);
  else process.stdout.write(`${outcome.text}\n`);
  return 0;
}

async function runInitCommand(args: ParsedArgs): Promise<number> {
  const report = await init({
    dir: args.dir ?? process.cwd(),
    selfPath: runningFile(),
    env: process.env,
    ...(args.agents !== undefined ? { agents: args.agents } : {}),
    ...(args.team !== undefined ? { team: args.team } : {}),
    ...(args.cut !== undefined ? { cut: args.cut } : {}),
  });
  if (args.json) {
    const stream = report.ok ? process.stdout : process.stderr;
    stream.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  }
  const lines = renderInit(report);
  const stream = report.ok ? process.stdout : process.stderr;
  stream.write(`${lines.join("\n")}\n`);
  return report.ok ? 0 : 1;
}

function writeResult(result: { ok: boolean; lines: string[] }): number {
  const stream = result.ok ? process.stdout : process.stderr;
  stream.write(`${result.lines.join("\n")}\n`);
  return result.ok ? 0 : 1;
}

/** The only way to start over after git has thrown the recorded baseline away. */
async function runBaselineCommand(args: ParsedArgs): Promise<number> {
  if (!args.reset) {
    process.stderr.write("stop-rules: baseline only takes --reset, as in stop-rules baseline --reset\n");
    return 1;
  }
  const resolved = await repoFor(args, process.cwd());
  if (!resolved.ok) return reportRepo(resolved);
  return writeResult(await resetBaseline(resolved.repo));
}

/** Team mode: write the endpoint into the repo so every developer's hook finds it. */
async function runTeamCommand(args: ParsedArgs): Promise<number> {
  if (args.operand === undefined) {
    process.stderr.write("stop-rules: team needs an endpoint, as in stop-rules team https://example.com\n");
    return 1;
  }
  const resolved = await repoFor(args, process.cwd());
  if (!resolved.ok) return reportRepo(resolved);
  return writeResult(await writeTeamConfig(resolved.repo.root, args.operand));
}

/** Secrets arrive on stdin only, so they never reach shell history or a process list. */
async function runLoginCommand(args: ParsedArgs): Promise<number> {
  if (args.check) {
    // A credential can be checked outside a repository, where there are no settings to read,
    // so only a --dir that is not a repository and a vendored copy pointed elsewhere stop it.
    const resolved = await repoFor(args, process.cwd());
    if (!resolved.ok && (resolved.kind === "other-repo" || args.dir !== undefined)) {
      return reportRepo(resolved);
    }
    const root = resolved.ok ? resolved.repo.root : process.cwd();
    return writeResult(await loginCheck(root, process.env));
  }
  if (args.tokenStdin === args.jevKeyStdin) {
    process.stderr.write(
      [
        "stop-rules: login needs one of --token-stdin, --jev-key-stdin or --check.",
        '  printf %s "$TOKEN" | stop-rules login --token-stdin',
        '  printf %s "$JEV_KEY" | stop-rules login --jev-key-stdin',
        "  stop-rules login --check",
      ].join("\n") + "\n",
    );
    return 1;
  }
  const secret = await readStdin();
  return writeResult(await login(process.env, args.tokenStdin ? "token" : "jev-key", secret));
}

async function main(): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`stop-rules: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(USAGE);
    return 1;
  }

  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.help || args.command.length === 0) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 1;
  }

  if (args.operand !== undefined && args.command !== "team") {
    process.stderr.write(`stop-rules: unexpected argument ${args.operand}\n`);
    return 1;
  }

  switch (args.command) {
    case "hook":
      return runHook(args);
    case "check":
      return runCheckCommand(args);
    case "score":
      return runScoreCommand(args);
    case "init":
      return runInitCommand(args);
    case "team":
      return runTeamCommand(args);
    case "login":
      return runLoginCommand(args);
    case "serve":
      try {
        return await serveMain(args.port);
      } catch (error) {
        // A port that cannot be used is the user's to fix, so it reads as one line.
        process.stderr.write(
          `stop-rules: ${error instanceof Error ? error.message : String(error)}
`,
        );
        return 1;
      }
    case "baseline":
      return runBaselineCommand(args);
    default:
      process.stderr.write(`stop-rules: unknown command ${args.command}\n`);
      process.stderr.write(USAGE);
      return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Nothing above this point is allowed to lose an error.
    process.stderr.write(
      `stop-rules: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
