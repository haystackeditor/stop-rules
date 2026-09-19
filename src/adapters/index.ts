import { claudeCodeAdapter } from "./claude-code.js";
import type { AgentAdapter } from "./types.js";

export const DEFAULT_AGENT = "claude-code";

const ADAPTERS: readonly AgentAdapter[] = [claudeCodeAdapter];

export function agentNames(): string[] {
  return ADAPTERS.map((adapter) => adapter.name);
}

export function getAdapter(name: string): AgentAdapter | null {
  return ADAPTERS.find((adapter) => adapter.name === name) ?? null;
}

export type { AgentAdapter, Delivery, HookInput, HookOutcome } from "./types.js";
