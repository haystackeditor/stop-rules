/** What the hook has to tell the coding agent, before any agent specific encoding. */
export type HookOutcome =
  | { kind: "clean" }
  | { kind: "violations"; report: string }
  /** Too many rounds on the same violations: this one is for the user, not the agent. */
  | { kind: "handoff"; report: string }
  /** The check could not run at all. The agent cannot fix a missing API key. */
  | { kind: "cannot-run"; reason: string };

export interface HookInput {
  sessionId: string;
  /** May be empty, in which case the CLI uses its own working directory. */
  cwd: string;
  stopHookActive: boolean;
}

export interface Delivery {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface AgentAdapter {
  name: string;
  /** Throws an Error with a plain message when the payload is not usable. */
  parseInput(stdinText: string): HookInput;
  deliver(result: HookOutcome): Delivery;
}
