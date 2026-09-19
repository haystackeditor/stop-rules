import { aiderAdapter } from "./aider.js";
import { ampAdapter } from "./amp.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { clineAdapter } from "./cline.js";
import { codexAdapter } from "./codex.js";
import { copilotAdapter } from "./copilot.js";
import { cursorAdapter } from "./cursor.js";
import { droidAdapter } from "./droid.js";
import { geminiAdapter } from "./gemini.js";
import { kiroAdapter } from "./kiro.js";
import { opencodeAdapter } from "./opencode.js";
import { plainAdapter } from "./plain.js";
import { windsurfAdapter } from "./windsurf.js";
import type { AgentAdapter } from "./types.js";

export const DEFAULT_AGENT = "claude-code";

/** Registry order is the order `init` reports in, and the order --help lists. */
export const ADAPTERS: readonly AgentAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  geminiAdapter,
  copilotAdapter,
  droidAdapter,
  kiroAdapter,
  opencodeAdapter,
  ampAdapter,
  windsurfAdapter,
  clineAdapter,
  aiderAdapter,
  plainAdapter,
];

export function agentNames(): string[] {
  return ADAPTERS.map((adapter) => adapter.name);
}

export function getAdapter(name: string): AgentAdapter | null {
  return ADAPTERS.find((adapter) => adapter.name === name) ?? null;
}

export type {
  AgentAdapter,
  CheckResult,
  Feedback,
  HookContext,
  HookOutput,
  InstallResult,
} from "./types.js";
