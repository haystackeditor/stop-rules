#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_AGENT, agentNames, getAdapter } from "./adapters/index.js";
import type { HookInput, HookOutcome } from "./adapters/index.js";
import { run, type RunOutcome } from "./check.js";
import { login, loginCheck, writeTeamConfig } from "./credentials.js";
import { findRepo } from "./git.js";
import { init } from "./init.js";
import { serveMain } from "./server/node.js";

const USAGE = `stop-rules: check the code your agent just wrote against your team's rules.

Usage:
  stop-rules hook [options]            run as a Stop hook, reading the hook JSON on stdin
  stop-rules check [options]           run the same check in a terminal, pre-commit or CI
  stop-rules init                      write .stop-rules.md and the Stop hook entry
  stop-rules team <endpoint>           point this repo at your team's stop-rules server
  stop-rules login --token-stdin       store the team token, read from stdin
  stop-rules login --jev-key-stdin     store your own Jev key, read from stdin
  stop-rules login --check             check the endpoint and one real Jev call
  stop-rules serve [--port n]          run the team server (it holds the Jev key)

Options:
  --rules <path>       rules file (default <repo root>/.stop-rules.md)
  --threshold <0..1>   score at or above which a rule counts as violated (default 0.5)
  --max-calls <n>      hard ceiling on requests to Jev in one run (default 60)
  --base <rev>         check mode only: diff this revision against the working tree
  --json               check mode only: print the findings as JSON
  --agent <name>       hook mode only: ${agentNames().join(", ")} (default ${DEFAULT_AGENT})
  --port <n>           serve mode only: port to listen on (default PORT or 8080)
  --help               print this text
  --version            print the version

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

Exit codes: 0 clean, 2 violations, 1 could not run.
`;

interface ParsedArgs {
  command: string;
  /** The one positional a command can take, today only `team <endpoint>`. */
  operand?: string;
  rules?: string;
  threshold: number;
  maxCalls: number;
  base?: string;
  json: boolean;
  agent: string;
  port?: number;
  tokenStdin: boolean;
  jevKeyStdin: boolean;
  check: boolean;
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
    tokenStdin: false,
    jevKeyStdin: false,
    check: false,
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
      case "--agent":
        i += 1;
        parsed.agent = take(i, "--agent");
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

async function version(): Promise<string> {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const raw: unknown = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  const value = (raw as { version?: unknown }).version;
  return typeof value === "string" ? value : "unknown";
}

function toHookOutcome(outcome: RunOutcome): HookOutcome {
  switch (outcome.kind) {
    case "cannot-run":
      return { kind: "cannot-run", reason: outcome.reason };
    case "clean":
      return { kind: "clean" };
    case "violations":
      return { kind: "violations", report: outcome.text };
    case "handoff":
      return { kind: "handoff", report: outcome.text };
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
  let input: HookInput;
  try {
    input = adapter.parseInput(await readStdin());
  } catch (error) {
    process.stderr.write(
      `stop-rules: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  const outcome = await run({
    cwd: input.cwd.length > 0 ? input.cwd : process.cwd(),
    mode: "hook",
    threshold: args.threshold,
    maxCalls: args.maxCalls,
    sessionId: input.sessionId,
    stopHookActive: input.stopHookActive,
    ...(args.rules !== undefined ? { rulesPath: args.rules } : {}),
  });
  const delivery = adapter.deliver(toHookOutcome(outcome));
  if (delivery.stdout.length > 0) process.stdout.write(delivery.stdout);
  if (delivery.stderr.length > 0) process.stderr.write(delivery.stderr);
  return delivery.exitCode;
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

function report(result: { ok: boolean; lines: string[] }): number {
  const stream = result.ok ? process.stdout : process.stderr;
  stream.write(`${result.lines.join("\n")}\n`);
  return result.ok ? 0 : 1;
}

/** Team mode: write the endpoint into the repo so every developer's hook finds it. */
async function runTeamCommand(args: ParsedArgs): Promise<number> {
  if (args.operand === undefined) {
    process.stderr.write("stop-rules: team needs an endpoint, as in stop-rules team https://example.com\n");
    return 1;
  }
  const repo = await findRepo(process.cwd());
  if (repo === null) {
    process.stderr.write(`stop-rules: ${process.cwd()} is not inside a git repository.\n`);
    return 1;
  }
  return report(await writeTeamConfig(repo.root, args.operand));
}

/** Secrets arrive on stdin only, so they never reach shell history or a process list. */
async function runLoginCommand(args: ParsedArgs): Promise<number> {
  if (args.check) {
    const repo = await findRepo(process.cwd());
    const root = repo === null ? process.cwd() : repo.root;
    return report(await loginCheck(root, process.env));
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
  return report(await login(process.env, args.tokenStdin ? "token" : "jev-key", secret));
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

  if (args.operand !== undefined && args.command !== "team") {
    process.stderr.write(`stop-rules: unexpected argument ${args.operand}\n`);
    return 1;
  }

  switch (args.command) {
    case "hook":
      return runHook(args);
    case "check":
      return runCheckCommand(args);
    case "team":
      return runTeamCommand(args);
    case "login":
      return runLoginCommand(args);
    case "serve":
      return serveMain(args.port);
    case "init": {
      const result = await init(process.cwd(), fileURLToPath(import.meta.url));
      const stream = result.ok ? process.stdout : process.stderr;
      stream.write(`${result.lines.join("\n")}\n`);
      return result.ok ? 0 : 1;
    }
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
