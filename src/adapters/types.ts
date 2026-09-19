import type { CheckReport } from "../types.js";

/** What `check.ts` produced for this turn: clean when `violations` is empty. */
export type CheckResult = CheckReport;

/** What the hook read out of the agent's payload. */
export interface HookContext {
  sessionId: string;
  /**
   * The directory the agent named. Undefined only for the agents whose documented payload
   * carries no directory at all (Windsurf's post_cascade_response, Aider's lint command),
   * where the agent runs the hook in the project root and that is the contract.
   */
  cwd?: string;
  /** Follow-up rounds the agent has already run for this conversation, when it says. */
  loopCount?: number;
  /** The agent's own "you already continued me once" flag, when it has one. */
  stopHookActive?: boolean;
}

export interface HookOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Can this agent be told to keep working, or can we only put text in front of it? */
export type Feedback = "continues-agent" | "shown-to-user-only";

export interface InstallResult {
  ok: boolean;
  /** Files this install wrote or would have written, relative to the repo root. */
  files: string[];
  /** True when something on disk changed. False when the entry was already there. */
  changed: boolean;
  /** One plain line per thing done or not done. Carries the reason when ok is false. */
  notes: string[];
}

export interface AgentAdapter {
  /** The --agent value. */
  name: string;
  /** Human name for messages. */
  title: string;
  feedback: Feedback;
  /** One plain sentence on what this agent does with a violation report. */
  effect: string;
  /** Does this repo already use this agent? */
  detect(repoRoot: string): boolean;
  /** The hook command line for this agent, given the bundle path inside the repo. */
  command(bundlePath: string): string;
  /** "none" for an agent that sends no payload, so the CLI never waits on stdin. */
  stdin?: "json" | "none";
  /** Throws an Error with a plain message when the payload is not usable. */
  parseInput(stdinText: string): HookContext;
  deliver(result: CheckResult, report: string): HookOutput;
  /** An infrastructure failure. Never makes the agent continue: it cannot fix a key. */
  deliverError(message: string): HookOutput;
  /** Merge the hook into this agent's config. Idempotent. */
  install(repoRoot: string, command: string): InstallResult;
}
