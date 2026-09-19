import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Rule } from "./types.js";

const TOP_LEVEL_ITEM = /^(?:[-*+]|\d+[.)])\s+(.*)$/;
const FENCE = /^\s*(?:```|~~~)/;

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function ruleId(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
}

/**
 * Each top-level list item is one rule. Indented continuation lines and nested list
 * items join the rule above them. Headings, paragraphs, blank lines, fenced code
 * blocks and HTML comments are ignored.
 */
export function parseRules(markdown: string): Rule[] {
  const lines = markdown.split(/\r?\n/);
  const collected: string[] = [];
  let current: string[] | null = null;
  let inFence = false;
  let inComment = false;

  const flush = (): void => {
    if (current !== null && current.length > 0) collected.push(current.join(" "));
    current = null;
  };

  for (const raw of lines) {
    if (inComment) {
      if (raw.includes("-->")) inComment = false;
      continue;
    }
    if (inFence) {
      if (FENCE.test(raw)) inFence = false;
      continue;
    }
    if (FENCE.test(raw)) {
      inFence = true;
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.startsWith("<!--")) {
      if (!trimmed.includes("-->")) inComment = true;
      continue;
    }
    if (trimmed.length === 0) {
      // A blank line does not end a rule: a loose markdown list may separate an item
      // from its own continuation. A later unindented line ends it.
      continue;
    }
    const indented = /^\s/.test(raw);
    if (indented) {
      if (current !== null) {
        const inner = trimmed.replace(TOP_LEVEL_ITEM, "$1").trim();
        if (inner.length > 0) current.push(inner);
      }
      continue;
    }
    const match = TOP_LEVEL_ITEM.exec(raw);
    if (match) {
      flush();
      const first = (match[1] ?? "").trim();
      current = first.length > 0 ? [first] : [];
      continue;
    }
    // Heading, paragraph or anything else at column 0: ignored, and it ends the rule.
    flush();
  }
  flush();

  const seen = new Set<string>();
  const rules: Rule[] = [];
  for (const entry of collected) {
    const text = normalise(entry);
    if (text.length === 0) continue;
    const id = ruleId(text);
    if (seen.has(id)) continue;
    seen.add(id);
    rules.push({ id, text });
  }
  return rules;
}

export interface RulesLoad {
  ok: boolean;
  rules: Rule[];
  reason?: string;
}

export async function loadRules(rulesPath: string): Promise<RulesLoad> {
  let source: string;
  try {
    source = await fs.readFile(rulesPath, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {
        ok: false,
        rules: [],
        reason: `no rules file at ${rulesPath}. Run "stop-rules init" to create one.`,
      };
    }
    return { ok: false, rules: [], reason: `could not read ${rulesPath}: ${err.message}` };
  }
  const rules = parseRules(source);
  if (rules.length === 0) {
    return {
      ok: false,
      rules: [],
      reason: `no rules found in ${rulesPath}. Each top-level list item is one rule.`,
    };
  }
  return { ok: true, rules };
}

export const STARTER_RULES = `# Coding rules checked by stop-rules

Each top-level bullet is one rule. Write rules as plain sentences a reviewer could apply
to a diff. Headings and paragraphs are ignored.

- Do not silently swallow errors. Every catch block must rethrow, return the failure to the caller, or log it with enough context to debug.
- Do not add fallback values or default branches that hide a failure the caller needs to know about.
- Do not write comments that only restate what the code does, or that narrate the change being made ("now we also handle X", "fixed the bug where").
- Do not leave debugging output (console.log, print, dbg!) in non-test code.
- Do not weaken type safety to make an error go away: no \`any\`, no \`as unknown as\`, no \`@ts-ignore\` or \`# type: ignore\` without a reason on the same line.
- Do not add configuration options, parameters or abstractions that nothing in this change uses.
- Do not delete, skip or loosen an existing test to make it pass.
`;
