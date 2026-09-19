#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { DEFAULT_AGENT, agentNames, getAdapter } from "./adapters/index.js";
import type { AgentAdapter, HookContext, HookOutput } from "./adapters/index.js";
import { run, type RunOutcome } from "./check.js";
import { init, renderInit } from "./init.js";
import { version } from "./version.js";

const USAGE = `stop-rules: check the code your agent just wrote against your team's rules.

Usage:
  stop-rules hook [options]            run as a stop hook, reading the agent's JSON on stdin
  stop-rules check [options]           run the same check in a terminal, pre-commit or CI
  stop-rules init [options]            vendor the checker and wire it into your agents

Options:
  --agent <name>       hook mode only: which agent's protocol to speak (default ${DEFAULT_AGENT})
  --agents <a,b,c>     init mode only: which agents to wire up (default: the ones detected)
  --dir <path>         init mode only: the repository to install into (default: this one)
  --rules <path>       rules file (default <repo root>/.stop-rules.md)
  --threshold <0..1>   score at or above which a rule counts as violated (default 0.5)
  --max-calls <n>      hard ceiling on requests to Jev in one run (default 60)
  --base <rev>         check mode only: diff this revision against the working tree
  --json               print the findings, or the init result, as JSON
  --                   stop reading options: anything after it is ignored
  --help               print this text
  --version            print the version

Agents: ${agentNames().join(", ")}

Environment:
  TYPESAFE_API_KEY         your Jev API key
  TYPESAFE_API_KEY_FILE    a file holding the key, used when the variable above is unset
  STOP_RULES_JEV_ENDPOINT  override the Jev endpoint
  STOP_RULES_JEV_MODEL     override the Jev model

Exit codes: 0 clean, 2 violations, 1 could not run. Some agents need a different code to
carry the report, so the hook exit code is whatever that agent documents.
`;

interface ParsedArgs {
  command: string;
  rules?: string;
  threshold: number;
  maxCalls: number;
  base?: string;
  json: boolean;
  agent: string;
  agents?: string[];
  dir?: string;
  help: boolean;
  version: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: "",
    threshold: 0.5,
    maxCalls: 60,
    json: false,
    agent: DEFAULT_AGENT,
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
      case "--rules":
        i += 1;
        parsed.rules = take(i, "--rules");
        break;
      case "--base":
        i += 1;
        parsed.base = take(i, "--base");
        break;
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
        if (parsed.command.length > 0) throw new UsageError(`unexpected argument ${arg}`);
        parsed.command = arg;
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

function emit(delivery: HookOutput): number {
  if (delivery.stdout.length > 0) process.stdout.write(delivery.stdout);
  if (delivery.stderr.length > 0) process.stderr.write(delivery.stderr);
  return delivery.exitCode;
}

function deliverOutcome(adapter: AgentAdapter, outcome: RunOutcome): HookOutput {
  switch (outcome.kind) {
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
  const outcome = await run({
    cwd: input.cwd.length > 0 ? input.cwd : process.cwd(),
    mode: "hook",
    threshold: args.threshold,
    maxCalls: args.maxCalls,
    sessionId: input.sessionId,
    stopHookActive: input.stopHookActive === true,
    ...(input.loopCount !== undefined ? { loopCount: input.loopCount } : {}),
    ...(args.rules !== undefined ? { rulesPath: args.rules } : {}),
  });
  return emit(deliverOutcome(adapter, outcome));
}

async function runCheckCommand(args: ParsedArgs): Promise<number> {
  const outcome = await run({
    cwd: process.cwd(),
    mode: "check",
    threshold: args.threshold,
    maxCalls: args.maxCalls,
    ...(args.rules !== undefined ? { rulesPath: args.rules } : {}),
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

async function runInitCommand(args: ParsedArgs): Promise<number> {
  const report = await init({
    dir: args.dir ?? process.cwd(),
    selfPath: fileURLToPath(import.meta.url),
    ...(args.agents !== undefined ? { agents: args.agents } : {}),
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
    process.stdout.write(`${await version()}\n`);
    return 0;
  }
  if (args.help || args.command.length === 0) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 1;
  }

  switch (args.command) {
    case "hook":
      return runHook(args);
    case "check":
      return runCheckCommand(args);
    case "init":
      return runInitCommand(args);
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
