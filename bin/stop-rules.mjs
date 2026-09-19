#!/usr/bin/env node

// src/cli.ts
import { fileURLToPath } from "node:url";

// src/adapters/aider.ts
import * as fs2 from "node:fs";
import * as path2 from "node:path";

// src/adapters/shared.ts
import * as fs from "node:fs";
import * as path from "node:path";
function isRecord(value2) {
  return typeof value2 === "object" && value2 !== null && !Array.isArray(value2);
}
function hasViolations(result) {
  return result.violations.length > 0;
}
function parseJsonPayload(stdinText) {
  const trimmed = stdinText.trim();
  if (trimmed.length === 0) throw new Error("no hook payload on stdin");
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `hook payload on stdin is not JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isRecord(parsed)) throw new Error("hook payload on stdin is not a JSON object");
  return parsed;
}
function pickString(payload, keys) {
  for (const key of keys) {
    const value2 = payload[key];
    if (typeof value2 === "string" && value2.length > 0) return value2;
  }
  return null;
}
function pickNumber(payload, keys) {
  for (const key of keys) {
    const value2 = payload[key];
    if (typeof value2 === "number" && Number.isFinite(value2)) return value2;
  }
  return void 0;
}
function pickFirstOfArray(payload, keys) {
  for (const key of keys) {
    const value2 = payload[key];
    if (!Array.isArray(value2)) continue;
    const first = value2[0];
    if (typeof first === "string" && first.length > 0) return first;
  }
  return null;
}
function contextFrom(stdinText, fields) {
  const payload = parseJsonPayload(stdinText);
  const missing = (names) => new Error(`the ${fields.agent} hook input has no ${names.join(" or ")}`);
  const sessionId = pickString(payload, fields.session);
  if (sessionId === null) throw missing(fields.session);
  let cwd;
  if (fields.cwd !== void 0) {
    const found = pickString(payload, fields.cwd);
    if (found === null) throw missing(fields.cwd);
    cwd = found;
  } else if (fields.cwdArray !== void 0) {
    const found = pickFirstOfArray(payload, fields.cwdArray);
    if (found === null) throw missing(fields.cwdArray);
    cwd = found;
  }
  const loopCount = fields.loopCount ? pickNumber(payload, fields.loopCount) : void 0;
  const active = fields.stopHookActive ? fields.stopHookActive.some((key) => payload[key] === true) : false;
  return {
    sessionId,
    ...cwd !== void 0 ? { cwd } : {},
    ...loopCount !== void 0 ? { loopCount } : {},
    stopHookActive: active
  };
}
function out(exitCode, stdout = "", stderr = "") {
  return { stdout, stderr, exitCode };
}
function exitTwoOnStderr(result, report) {
  return hasViolations(result) ? out(2, "", `${report}
`) : out(0);
}
function jsonLine(value2) {
  return `${JSON.stringify(value2)}
`;
}
function relative2(repoRoot, target) {
  return path.relative(repoRoot, target).split(path.sep).join("/");
}
function failed(file, reason) {
  return { ok: false, files: [file], changed: false, notes: [reason] };
}
function readJsonFile(file, shown) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    const err = error;
    if (err.code === "ENOENT") return { ok: true, value: {}, existed: false };
    return { ok: false, reason: `could not read ${shown}: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      reason: `${shown} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Nothing was changed.`
    };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: `${shown} does not hold a JSON object. Nothing was changed.` };
  }
  return { ok: true, value: parsed, existed: true };
}
function writeJsonFile(file, value2) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value2, null, 2)}
`, "utf8");
}
function writeExecutable(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { encoding: "utf8", mode: 493 });
  fs.chmodSync(file, 493);
}
function mentionsStopRules(value2) {
  if (typeof value2 === "string") return value2.includes("stop-rules");
  if (Array.isArray(value2)) return value2.some(mentionsStopRules);
  if (isRecord(value2)) return Object.values(value2).some(mentionsStopRules);
  return false;
}
function arrayAt(container, key) {
  const value2 = container[key];
  if (value2 === void 0) return [];
  if (!Array.isArray(value2)) return null;
  return [...value2];
}
function recordAt(container, key) {
  const value2 = container[key];
  if (value2 === void 0) return {};
  if (!isRecord(value2)) return null;
  return value2;
}
function wrongShape(shown, key, expected) {
  return `in ${shown}, "${key}" is not ${expected}. Nothing was changed: fix the file and run init again.`;
}
function anyExists(repoRoot, names) {
  return names.some((name) => fs.existsSync(path.join(repoRoot, name)));
}
function mergeHookGroup(container, shown, event, entry, group = {}) {
  const list = arrayAt(container, event);
  if (list === null) return { ok: false, reason: wrongShape(shown, event, "a list") };
  if (list.some(mentionsStopRules)) return { ok: true, changed: false };
  list.push({ ...group, hooks: [entry] });
  container[event] = list;
  return { ok: true, changed: true };
}

// src/adapters/aider.ts
var CONFIG = ".aider.conf.yml";
var aiderAdapter = {
  name: "aider",
  title: "Aider",
  feedback: "continues-agent",
  effect: "reads the report as lint output and tries to fix the violations",
  stdin: "none",
  detect(repoRoot) {
    return anyExists(repoRoot, [CONFIG]);
  },
  command(bundlePath) {
    return `node "${bundlePath}" hook --agent aider --`;
  },
  parseInput(_stdinText) {
    return { sessionId: "aider" };
  },
  deliver(result, report) {
    if (!hasViolations(result)) return out(0);
    return out(2, `${report}
`);
  },
  deliverError(message) {
    return out(0, "", `${message}
`);
  },
  install(repoRoot, command) {
    const file = path2.join(repoRoot, CONFIG);
    const shown = relative2(repoRoot, file);
    const line = `- ${JSON.stringify(command)}`;
    let existing = "";
    try {
      existing = fs2.readFileSync(file, "utf8");
    } catch (error) {
      const err = error;
      if (err.code !== "ENOENT") {
        return {
          ok: false,
          files: [shown],
          changed: false,
          notes: [`could not read ${shown}: ${err.message}`]
        };
      }
    }
    const lines = existing.split(/\r?\n/);
    const hasLintCmd = lines.some((entry) => /^lint-cmd\s*:/.test(entry));
    const hasStopRules = existing.includes("stop-rules.mjs");
    if (hasStopRules) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: its lint-cmd already runs stop-rules`]
      };
    }
    if (hasLintCmd) {
      return {
        ok: false,
        files: [shown],
        changed: false,
        notes: [
          `${shown} already sets lint-cmd. Nothing was changed, so your linter keeps working.`,
          `To run both, add this line under lint-cmd in ${shown}:`,
          `  ${line}`
        ]
      };
    }
    const hasAutoLint = lines.some((entry) => /^auto-lint\s*:/.test(entry));
    const addition = [
      "",
      '# Added by stop-rules. Re-run "stop-rules init" to update it.',
      ...hasAutoLint ? [] : ["auto-lint: true"],
      "lint-cmd:",
      `  ${line}`,
      ""
    ].join("\n");
    const body = existing.length === 0 ? addition.replace(/^\n/, "") : `${existing.replace(/\n*$/, "\n")}${addition}`;
    fs2.writeFileSync(file, body, "utf8");
    const notes = [
      existing.length === 0 ? `created ${shown} with a lint-cmd` : `added a lint-cmd to ${shown}`
    ];
    if (hasAutoLint) notes.push(`${shown} already sets auto-lint: check that it is true.`);
    return { ok: true, files: [shown], changed: true, notes };
  }
};

// src/adapters/amp.ts
import * as fs3 from "node:fs";
import * as path3 from "node:path";

// src/plugins/amp.ts
function ampPlugin(bundlePath) {
  return `// Written by stop-rules. Re-run "stop-rules init" to update it.
import { spawn } from "node:child_process"
import { join } from "node:path"

const BUNDLE = ${JSON.stringify(bundlePath)}

type Run = { code: number; stdout: string; stderr: string }

// Uri is whatever type Amp's own workspaceRoot has: the plugin only ever hands it back to
// filePathFromURI, so it never needs to know the shape.
type AmpLike<Uri> = {
  workspaceRoot: Uri | null
  helpers: { filePathFromURI: (uri: Uri) => string }
  logger: { log: (message: string) => void }
  on: (
    event: "agent.end",
    handler: (event: { thread: { id: string }; status: string }) =>
      | Promise<{ action: "continue"; userMessage: string } | undefined>
      | { action: "continue"; userMessage: string }
      | undefined,
  ) => void
}

function runStopRules(root: string, sessionID: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, BUNDLE), "hook", "--agent", "plain"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", reject)
    child.on("close", (code, signal) => {
      // A signal death has no exit code. Calling that 0 would report a killed check as clean.
      if (code === null) {
        reject(new Error("stop-rules was killed by " + String(signal)))
        return
      }
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(JSON.stringify({ session_id: sessionID, cwd: root }))
  })
}

export default function <Uri>(amp: AmpLike<Uri>) {
  amp.on("agent.end", async (event) => {
    if (event.status !== "done") return undefined
    const root = amp.workspaceRoot === null ? "" : amp.helpers.filePathFromURI(amp.workspaceRoot)
    if (root.length === 0) {
      amp.logger.log("stop-rules: no workspace root, nothing to check")
      return undefined
    }

    let run: Run
    try {
      run = await runStopRules(root, event.thread.id)
    } catch (error) {
      // Never swallow it: the user needs to know the check did not run.
      amp.logger.log("stop-rules: could not run the check: " + String(error))
      return undefined
    }
    if (run.code === 2) {
      const report = (run.stdout.trim().length > 0 ? run.stdout : run.stderr).trim()
      if (report.length === 0) return undefined
      return { action: "continue" as const, userMessage: report }
    }
    if (run.code !== 0) amp.logger.log("stop-rules: " + run.stderr.trim())
    return undefined
  })
}
`;
}

// src/adapters/plain.ts
var plainAdapter = {
  name: "plain",
  title: "Plain",
  feedback: "continues-agent",
  effect: "prints the report and exits 2, for a wrapper to act on",
  detect() {
    return false;
  },
  command(bundlePath) {
    return `node "${bundlePath}" hook --agent plain`;
  },
  parseInput(stdinText) {
    return contextFrom(stdinText, {
      agent: "plain",
      session: ["session_id", "sessionId"],
      cwd: ["cwd"],
      loopCount: ["loop_count"],
      stopHookActive: ["stop_hook_active"]
    });
  },
  deliver(result, report) {
    if (!hasViolations(result)) return out(0);
    return out(2, `${report}
`, `${report}
`);
  },
  deliverError(message) {
    return out(1, "", `${message}
`);
  },
  install() {
    return {
      ok: true,
      files: [],
      changed: false,
      notes: ["plain has no config to install: call it yourself with a JSON payload"]
    };
  }
};

// src/adapters/amp.ts
var BUNDLE = ".stop-rules/stop-rules.mjs";
var PLUGIN = ".amp/plugins/stop-rules.ts";
var ampAdapter = {
  name: "amp",
  title: "Amp",
  feedback: "continues-agent",
  effect: "starts one more turn with the report as the user message",
  detect(repoRoot) {
    return anyExists(repoRoot, [".amp"]);
  },
  command(bundlePath) {
    return `node "${bundlePath}" hook --agent plain`;
  },
  parseInput(stdinText) {
    return plainAdapter.parseInput(stdinText);
  },
  deliver(result, report) {
    return plainAdapter.deliver(result, report);
  },
  deliverError(message) {
    return plainAdapter.deliverError(message);
  },
  install(repoRoot, _command) {
    const file = path3.join(repoRoot, PLUGIN);
    const shown = relative2(repoRoot, file);
    const wanted = ampPlugin(BUNDLE);
    let existing = null;
    try {
      existing = fs3.readFileSync(file, "utf8");
    } catch (error) {
      const err = error;
      if (err.code !== "ENOENT") {
        return {
          ok: false,
          files: [shown],
          changed: false,
          notes: [`could not read ${shown}: ${err.message}`]
        };
      }
    }
    if (existing !== null && !existing.includes("stop-rules")) {
      return {
        ok: false,
        files: [shown],
        changed: false,
        notes: [`${shown} exists and is not a stop-rules plugin. Nothing was changed.`]
      };
    }
    if (existing === wanted) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it is already up to date`]
      };
    }
    fs3.mkdirSync(path3.dirname(file), { recursive: true });
    fs3.writeFileSync(file, wanted, "utf8");
    return {
      ok: true,
      files: [shown],
      changed: true,
      notes: [existing === null ? `wrote the plugin ${shown}` : `updated the plugin ${shown}`]
    };
  }
};

// src/adapters/claude-code.ts
import * as path4 from "node:path";
var claudeCodeAdapter = {
  name: "claude-code",
  title: "Claude Code",
  feedback: "continues-agent",
  effect: "will be woken in the background and told to fix violations",
  detect(repoRoot) {
    return anyExists(repoRoot, [".claude", "CLAUDE.md"]);
  },
  command(bundlePath) {
    return `node "\${CLAUDE_PROJECT_DIR}/${bundlePath}" hook --agent claude-code`;
  },
  parseInput(stdinText) {
    return contextFrom(stdinText, {
      agent: "Claude Code",
      session: ["session_id"],
      cwd: ["cwd"],
      stopHookActive: ["stop_hook_active"]
    });
  },
  deliver(result, report) {
    return exitTwoOnStderr(result, report);
  },
  deliverError(message) {
    return out(1, "", `${message}
`);
  },
  install(repoRoot, command) {
    const file = path4.join(repoRoot, ".claude", "settings.json");
    const shown = relative2(repoRoot, file);
    const read = readJsonFile(file, shown);
    if (!read.ok) return failed(shown, read.reason);
    const settings = read.value;
    const hooks = recordAt(settings, "hooks");
    if (hooks === null) return failed(shown, wrongShape(shown, "hooks", "an object"));
    const merged = mergeHookGroup(hooks, shown, "Stop", {
      type: "command",
      command,
      asyncRewake: true,
      timeout: 120
    });
    if (!merged.ok) return failed(shown, merged.reason);
    if (!merged.changed) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it already has a stop-rules Stop hook`]
      };
    }
    settings["hooks"] = hooks;
    writeJsonFile(file, settings);
    return {
      ok: true,
      files: [shown],
      changed: true,
      notes: [
        read.existed ? `merged a Stop hook into ${shown}, keeping everything that was already there` : `created ${shown} with a Stop hook`
      ]
    };
  }
};

// src/adapters/cline.ts
import * as fs4 from "node:fs";
import * as path5 from "node:path";

// src/plugins/cline.ts
function clineHookScript(bundlePath) {
  return `#!/usr/bin/env bash
# Written by stop-rules. Re-run "stop-rules init" to update it.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
exec node "$repo/${bundlePath}" hook --agent cline
`;
}

// src/adapters/cline.ts
var clineAdapter = {
  name: "cline",
  title: "Cline",
  feedback: "shown-to-user-only",
  effect: "gets the report as context for its next decisions, but cannot be told to keep working on it",
  detect(repoRoot) {
    return anyExists(repoRoot, [".clinerules", ".cline"]);
  },
  command(bundlePath) {
    return `node "<repo>/${bundlePath}" hook --agent cline`;
  },
  parseInput(stdinText) {
    return contextFrom(stdinText, {
      agent: "Cline",
      session: ["taskId"],
      cwdArray: ["workspaceRoots"]
    });
  },
  deliver(result, report) {
    if (!hasViolations(result)) return out(0, jsonLine({ cancel: false }));
    return out(0, jsonLine({ cancel: false, contextModification: report }));
  },
  deliverError(message) {
    return out(0, jsonLine({ cancel: false }), `${message}
`);
  },
  install(repoRoot, _command) {
    const bundle = ".stop-rules/stop-rules.mjs";
    const file = path5.join(repoRoot, ".clinerules", "hooks", "TaskComplete");
    const shown = relative2(repoRoot, file);
    const wanted = clineHookScript(bundle);
    let existing = null;
    try {
      existing = fs4.readFileSync(file, "utf8");
    } catch (error) {
      const err = error;
      if (err.code !== "ENOENT") {
        return { ok: false, files: [shown], changed: false, notes: [`could not read ${shown}: ${err.message}`] };
      }
    }
    if (existing !== null && !existing.includes("stop-rules")) {
      return {
        ok: false,
        files: [shown],
        changed: false,
        notes: [
          `${shown} already exists and is not a stop-rules hook. Nothing was changed.`,
          `Add this line to it yourself: exec node "$repo/${bundle}" hook --agent cline`
        ]
      };
    }
    if (existing === wanted) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it is already the stop-rules hook`]
      };
    }
    writeExecutable(file, wanted);
    return {
      ok: true,
      files: [shown],
      changed: true,
      notes: [
        existing === null ? `wrote the executable hook ${shown}` : `updated the executable hook ${shown}`,
        "Cline runs hooks only when Enable Hooks is on in its Feature Settings."
      ]
    };
  }
};

// src/adapters/codex.ts
import * as path6 from "node:path";
var codexAdapter = {
  name: "codex",
  title: "Codex",
  feedback: "continues-agent",
  effect: "will be told to fix violations before the turn ends",
  detect(repoRoot) {
    return anyExists(repoRoot, [".codex"]);
  },
  command(bundlePath) {
    return `node "$(git rev-parse --show-toplevel)/${bundlePath}" hook --agent codex`;
  },
  parseInput(stdinText) {
    return contextFrom(stdinText, {
      agent: "Codex",
      session: ["session_id"],
      cwd: ["cwd"],
      stopHookActive: ["stop_hook_active"]
    });
  },
  deliver(result, report) {
    return exitTwoOnStderr(result, report);
  },
  deliverError(message) {
    return out(1, "", `${message}
`);
  },
  install(repoRoot, command) {
    const file = path6.join(repoRoot, ".codex", "hooks.json");
    const shown = relative2(repoRoot, file);
    const read = readJsonFile(file, shown);
    if (!read.ok) return failed(shown, read.reason);
    const config = read.value;
    const hooks = recordAt(config, "hooks");
    if (hooks === null) return failed(shown, wrongShape(shown, "hooks", "an object"));
    const merged = mergeHookGroup(hooks, shown, "Stop", { type: "command", command, timeout: 120 });
    if (!merged.ok) return failed(shown, merged.reason);
    if (!merged.changed) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it already has a stop-rules Stop hook`]
      };
    }
    config["hooks"] = hooks;
    writeJsonFile(file, config);
    return {
      ok: true,
      files: [shown],
      changed: true,
      notes: [
        read.existed ? `merged a Stop hook into ${shown}, keeping everything that was already there` : `created ${shown} with a Stop hook`
      ]
    };
  }
};

// src/adapters/copilot.ts
import * as path7 from "node:path";
var copilotAdapter = {
  name: "copilot",
  title: "GitHub Copilot CLI",
  feedback: "continues-agent",
  effect: "will run another turn with the report as its prompt",
  detect(repoRoot) {
    return anyExists(repoRoot, [".github/hooks", ".github/copilot-instructions.md"]);
  },
  command(bundlePath) {
    return `node "${bundlePath}" hook --agent copilot`;
  },
  parseInput(stdinText) {
    return contextFrom(stdinText, {
      agent: "Copilot CLI",
      session: ["sessionId", "session_id"],
      cwd: ["cwd"],
      stopHookActive: ["stop_hook_active"]
    });
  },
  deliver(result, report) {
    if (!hasViolations(result)) return out(0);
    return out(0, jsonLine({ decision: "block", reason: report }));
  },
  deliverError(message) {
    return out(1, "", `${message}
`);
  },
  install(repoRoot, command) {
    const file = path7.join(repoRoot, ".github", "hooks", "stop-rules.json");
    const shown = relative2(repoRoot, file);
    const read = readJsonFile(file, shown);
    if (!read.ok) return failed(shown, read.reason);
    const config = read.value;
    const version = config["version"];
    if (version === void 0) config["version"] = 1;
    else if (typeof version !== "number") {
      return failed(shown, wrongShape(shown, "version", "a number"));
    }
    const hooks = recordAt(config, "hooks");
    if (hooks === null) return failed(shown, wrongShape(shown, "hooks", "an object"));
    const list = arrayAt(hooks, "agentStop");
    if (list === null) return failed(shown, wrongShape(shown, "agentStop", "a list"));
    if (list.some(mentionsStopRules)) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it already has a stop-rules agentStop hook`]
      };
    }
    list.push({ type: "command", bash: command, cwd: ".", timeoutSec: 120 });
    hooks["agentStop"] = list;
    config["hooks"] = hooks;
    writeJsonFile(file, config);
    return {
      ok: true,
      files: [shown],
      changed: true,
      notes: [
        read.existed ? `merged an agentStop hook into ${shown}, keeping everything that was already there` : `created ${shown} with an agentStop hook`
      ]
    };
  }
};

// src/adapters/cursor.ts
import * as path8 from "node:path";
var cursorAdapter = {
  name: "cursor",
  title: "Cursor",
  feedback: "continues-agent",
  effect: "will be sent the report as the next user message and told to fix violations",
  detect(repoRoot) {
    return anyExists(repoRoot, [".cursor"]);
  },
  command(bundlePath) {
    return `node "${bundlePath}" hook --agent cursor`;
  },
  parseInput(stdinText) {
    return contextFrom(stdinText, {
      agent: "Cursor",
      session: ["conversation_id", "session_id"],
      cwdArray: ["workspace_roots"],
      loopCount: ["loop_count"]
    });
  },
  deliver(result, report) {
    if (!hasViolations(result)) return out(0, jsonLine({}));
    return out(0, jsonLine({ followup_message: report }));
  },
  deliverError(message) {
    return out(1, "", `${message}
`);
  },
  install(repoRoot, command) {
    const file = path8.join(repoRoot, ".cursor", "hooks.json");
    const shown = relative2(repoRoot, file);
    const read = readJsonFile(file, shown);
    if (!read.ok) return failed(shown, read.reason);
    const config = read.value;
    const version = config["version"];
    if (version === void 0) config["version"] = 1;
    else if (typeof version !== "number") {
      return failed(shown, wrongShape(shown, "version", "a number"));
    }
    const hooks = recordAt(config, "hooks");
    if (hooks === null) return failed(shown, wrongShape(shown, "hooks", "an object"));
    const stop = arrayAt(hooks, "stop");
    if (stop === null) return failed(shown, wrongShape(shown, "stop", "a list"));
    if (stop.some(mentionsStopRules)) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it already has a stop-rules stop hook`]
      };
    }
    stop.push({ command });
    hooks["stop"] = stop;
    config["hooks"] = hooks;
    writeJsonFile(file, config);
    return {
      ok: true,
      files: [shown],
      changed: true,
      notes: [
        read.existed ? `merged a stop hook into ${shown}, keeping everything that was already there` : `created ${shown} with a stop hook`
      ]
    };
  }
};

// src/adapters/droid.ts
import * as path9 from "node:path";
var droidAdapter = {
  name: "droid",
  title: "Factory Droid",
  feedback: "continues-agent",
  effect: "will be told to fix violations before it finishes responding",
  detect(repoRoot) {
    return anyExists(repoRoot, [".factory"]);
  },
  command(bundlePath) {
    return `node "$FACTORY_PROJECT_DIR"/${bundlePath} hook --agent droid`;
  },
  parseInput(stdinText) {
    return contextFrom(stdinText, {
      agent: "Droid",
      session: ["session_id"],
      cwd: ["cwd"],
      stopHookActive: ["stop_hook_active"]
    });
  },
  deliver(result, report) {
    return exitTwoOnStderr(result, report);
  },
  deliverError(message) {
    return out(1, "", `${message}
`);
  },
  install(repoRoot, command) {
    const file = path9.join(repoRoot, ".factory", "hooks.json");
    const shown = relative2(repoRoot, file);
    const read = readJsonFile(file, shown);
    if (!read.ok) return failed(shown, read.reason);
    const config = read.value;
    const merged = mergeHookGroup(config, shown, "Stop", { type: "command", command, timeout: 120 });
    if (!merged.ok) return failed(shown, merged.reason);
    if (!merged.changed) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it already has a stop-rules Stop hook`]
      };
    }
    writeJsonFile(file, config);
    return {
      ok: true,
      files: [shown],
      changed: true,
      notes: [
        read.existed ? `merged a Stop hook into ${shown}, keeping everything that was already there` : `created ${shown} with a Stop hook`
      ]
    };
  }
};

// src/adapters/gemini.ts
import * as path10 from "node:path";
var geminiAdapter = {
  name: "gemini",
  title: "Gemini CLI",
  feedback: "continues-agent",
  effect: "will retry the turn with the report as its feedback prompt",
  detect(repoRoot) {
    return anyExists(repoRoot, [".gemini"]);
  },
  command(bundlePath) {
    return `node "$GEMINI_PROJECT_DIR/${bundlePath}" hook --agent gemini`;
  },
  parseInput(stdinText) {
    return contextFrom(stdinText, {
      agent: "Gemini CLI",
      session: ["session_id"],
      cwd: ["cwd"],
      stopHookActive: ["stop_hook_active"]
    });
  },
  deliver(result, report) {
    if (!hasViolations(result)) return out(0, jsonLine({}));
    return out(2, "", `${report}
`);
  },
  deliverError(message) {
    return out(1, "", `${message}
`);
  },
  install(repoRoot, command) {
    const file = path10.join(repoRoot, ".gemini", "settings.json");
    const shown = relative2(repoRoot, file);
    const read = readJsonFile(file, shown);
    if (!read.ok) return failed(shown, read.reason);
    const settings = read.value;
    const hooks = recordAt(settings, "hooks");
    if (hooks === null) return failed(shown, wrongShape(shown, "hooks", "an object"));
    const merged = mergeHookGroup(
      hooks,
      shown,
      "AfterAgent",
      { name: "stop-rules", type: "command", command, timeout: 12e4 },
      { matcher: "*" }
    );
    if (!merged.ok) return failed(shown, merged.reason);
    if (!merged.changed) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it already has a stop-rules AfterAgent hook`]
      };
    }
    settings["hooks"] = hooks;
    writeJsonFile(file, settings);
    return {
      ok: true,
      files: [shown],
      changed: true,
      notes: [
        read.existed ? `merged an AfterAgent hook into ${shown}, keeping everything that was already there` : `created ${shown} with an AfterAgent hook`
      ]
    };
  }
};

// src/adapters/kiro.ts
import * as path11 from "node:path";
var kiroAdapter = {
  name: "kiro",
  title: "Kiro",
  feedback: "continues-agent",
  effect: "will be sent the report as a new user message and told to fix violations",
  detect(repoRoot) {
    return anyExists(repoRoot, [".kiro"]);
  },
  command(bundlePath) {
    return `node "${bundlePath}" hook --agent kiro`;
  },
  parseInput(stdinText) {
    return contextFrom(stdinText, { agent: "Kiro", session: ["session_id"], cwd: ["cwd"] });
  },
  deliver(result, report) {
    if (!hasViolations(result)) return out(0);
    return out(0, jsonLine({ decision: "block", reason: report }));
  },
  deliverError(message) {
    return out(1, "", `${message}
`);
  },
  install(repoRoot, command) {
    const file = path11.join(repoRoot, ".kiro", "hooks", "stop-rules.json");
    const shown = relative2(repoRoot, file);
    const read = readJsonFile(file, shown);
    if (!read.ok) return failed(shown, read.reason);
    const config = read.value;
    const version = config["version"];
    if (version === void 0) config["version"] = "v1";
    else if (typeof version !== "string") {
      return failed(shown, wrongShape(shown, "version", "a string"));
    }
    const hooks = arrayAt(config, "hooks");
    if (hooks === null) return failed(shown, wrongShape(shown, "hooks", "a list"));
    if (hooks.some(mentionsStopRules)) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it already has a stop-rules Stop hook`]
      };
    }
    hooks.push({
      name: "stop-rules",
      description: "Check the turn's diff against the team's coding rules.",
      trigger: "Stop",
      action: { type: "command", command },
      timeout: 120
    });
    config["hooks"] = hooks;
    writeJsonFile(file, config);
    return {
      ok: true,
      files: [shown],
      changed: true,
      notes: [
        read.existed ? `merged a Stop hook into ${shown}, keeping everything that was already there` : `created ${shown} with a Stop hook`
      ]
    };
  }
};

// src/adapters/opencode.ts
import * as fs5 from "node:fs";
import * as path12 from "node:path";

// src/plugins/opencode.ts
function opencodePlugin(bundlePath) {
  return `// Written by stop-rules. Re-run "stop-rules init" to update it.
import { spawn } from "node:child_process"
import { join } from "node:path"

const BUNDLE = ${JSON.stringify(bundlePath)}

type Run = { code: number; stdout: string; stderr: string }

function runStopRules(root: string, sessionID: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, BUNDLE), "hook", "--agent", "plain"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", reject)
    child.on("close", (code, signal) => {
      // A signal death has no exit code. Calling that 0 would report a killed check as clean.
      if (code === null) {
        reject(new Error("stop-rules was killed by " + String(signal)))
        return
      }
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(JSON.stringify({ session_id: sessionID, cwd: root }))
  })
}

type PromptInput = { path: { id: string }; body: { parts: { type: "text"; text: string }[] } }

export const StopRules = async ({ client, directory, worktree }: {
  client: { session: { prompt: (input: PromptInput) => Promise<unknown> } }
  directory: string
  worktree?: string
}) => {
  const root = worktree ?? directory
  return {
    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      if (event.type !== "session.idle") return
      const sessionID = event.properties?.["sessionID"]
      if (typeof sessionID !== "string" || sessionID.length === 0) return

      let run: Run
      try {
        run = await runStopRules(root, sessionID)
      } catch (error) {
        // Never swallow it: the user needs to know the check did not run.
        console.error("stop-rules: could not run the check:", error)
        return
      }
      if (run.code === 2) {
        const report = (run.stdout.trim().length > 0 ? run.stdout : run.stderr).trim()
        if (report.length === 0) return
        await client.session.prompt({
          path: { id: sessionID },
          body: { parts: [{ type: "text", text: report }] },
        })
        return
      }
      if (run.code !== 0) console.error("stop-rules:", run.stderr.trim())
    },
  }
}
`;
}

// src/adapters/opencode.ts
var BUNDLE2 = ".stop-rules/stop-rules.mjs";
var PLUGIN2 = ".opencode/plugins/stop-rules.ts";
var opencodeAdapter = {
  name: "opencode",
  title: "OpenCode",
  feedback: "continues-agent",
  effect: "gets the report posted back into the session as a new message",
  detect(repoRoot) {
    return anyExists(repoRoot, [".opencode", "opencode.json", "opencode.jsonc"]);
  },
  command(bundlePath) {
    return `node "${bundlePath}" hook --agent plain`;
  },
  parseInput(stdinText) {
    return plainAdapter.parseInput(stdinText);
  },
  deliver(result, report) {
    return plainAdapter.deliver(result, report);
  },
  deliverError(message) {
    return plainAdapter.deliverError(message);
  },
  install(repoRoot, _command) {
    const file = path12.join(repoRoot, PLUGIN2);
    const shown = relative2(repoRoot, file);
    const wanted = opencodePlugin(BUNDLE2);
    let existing = null;
    try {
      existing = fs5.readFileSync(file, "utf8");
    } catch (error) {
      const err = error;
      if (err.code !== "ENOENT") {
        return {
          ok: false,
          files: [shown],
          changed: false,
          notes: [`could not read ${shown}: ${err.message}`]
        };
      }
    }
    if (existing !== null && !existing.includes("stop-rules")) {
      return {
        ok: false,
        files: [shown],
        changed: false,
        notes: [`${shown} exists and is not a stop-rules plugin. Nothing was changed.`]
      };
    }
    if (existing === wanted) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it is already up to date`]
      };
    }
    fs5.mkdirSync(path12.dirname(file), { recursive: true });
    fs5.writeFileSync(file, wanted, "utf8");
    return {
      ok: true,
      files: [shown],
      changed: true,
      notes: [existing === null ? `wrote the plugin ${shown}` : `updated the plugin ${shown}`]
    };
  }
};

// src/adapters/windsurf.ts
import * as path13 from "node:path";
var windsurfAdapter = {
  name: "windsurf",
  title: "Windsurf Cascade",
  feedback: "shown-to-user-only",
  effect: "gets the report after the response, but cannot be told to keep working on it",
  detect(repoRoot) {
    return anyExists(repoRoot, [".windsurf"]);
  },
  command(bundlePath) {
    return `node "${bundlePath}" hook --agent windsurf`;
  },
  parseInput(stdinText) {
    return contextFrom(stdinText, { agent: "Windsurf", session: ["trajectory_id", "execution_id"] });
  },
  deliver(result, report) {
    return exitTwoOnStderr(result, report);
  },
  deliverError(message) {
    return out(1, "", `${message}
`);
  },
  install(repoRoot, command) {
    const file = path13.join(repoRoot, ".windsurf", "hooks.json");
    const shown = relative2(repoRoot, file);
    const read = readJsonFile(file, shown);
    if (!read.ok) return failed(shown, read.reason);
    const config = read.value;
    const hooks = recordAt(config, "hooks");
    if (hooks === null) return failed(shown, wrongShape(shown, "hooks", "an object"));
    const list = arrayAt(hooks, "post_cascade_response");
    if (list === null) {
      return failed(shown, wrongShape(shown, "post_cascade_response", "a list"));
    }
    if (list.some(mentionsStopRules)) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it already has a stop-rules post_cascade_response hook`]
      };
    }
    list.push({ command });
    hooks["post_cascade_response"] = list;
    config["hooks"] = hooks;
    writeJsonFile(file, config);
    return {
      ok: true,
      files: [shown],
      changed: true,
      notes: [
        read.existed ? `merged a post_cascade_response hook into ${shown}, keeping everything that was already there` : `created ${shown} with a post_cascade_response hook`
      ]
    };
  }
};

// src/adapters/index.ts
var DEFAULT_AGENT = "claude-code";
var ADAPTERS = [
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
  plainAdapter
];
function agentNames() {
  return ADAPTERS.map((adapter) => adapter.name);
}
function getAdapter(name) {
  return ADAPTERS.find((adapter) => adapter.name === name) ?? null;
}

// src/check.ts
import * as path17 from "node:path";

// src/credentials.ts
import { promises as fs7 } from "node:fs";
import { homedir } from "node:os";
import * as path14 from "node:path";

// src/jev.ts
var DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
var DEFAULT_MODEL = "jev-latest";
var AUTH_REJECTED = "Jev rejected the API key";
var BILLING_EXHAUSTED = "the Jev account is out of credits. Add credits at TypeSafe, then run again.";
function holdsBaseline(failure2) {
  return failure2 === "network" || failure2 === "server" || failure2 === "rate_limit" || failure2 === "auth" || failure2 === "billing" || failure2 === "budget";
}
var MAX_ATTEMPTS = 3;
var BACKOFF_START_MS = 1e3;
var BACKOFF_CAP_MS = 16e3;
function defaultSleep(ms) {
  return new Promise((resolve3) => {
    globalThis.setTimeout(resolve3, ms);
  });
}
function parseRetryAfter(header) {
  if (header === null) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1e3;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(when - Date.now(), 0);
}
function readAnswers(body) {
  if (typeof body !== "object" || body === null) return null;
  const answers = body.answers;
  if (typeof answers !== "object" || answers === null) return null;
  const out2 = {};
  for (const [id, value2] of Object.entries(answers)) {
    if (typeof value2 !== "object" || value2 === null) continue;
    const noul = value2.noul;
    if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) continue;
    out2[id] = noul;
  }
  return out2;
}
function readUsage(body) {
  if (typeof body !== "object" || body === null) return { inputTokens: 0, outputTokens: 0 };
  const usage = body.usage;
  if (typeof usage !== "object" || usage === null) return { inputTokens: 0, outputTokens: 0 };
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  return {
    inputTokens: typeof input === "number" ? input : 0,
    outputTokens: typeof output === "number" ? output : 0
  };
}
var JevClient = class {
  constructor(options) {
    this.options = options;
    this.limit = options.concurrency ?? 4;
    this.sleep = options.sleep ?? defaultSleep;
  }
  callsUsed = 0;
  limit;
  sleep;
  usage = { inputTokens: 0, outputTokens: 0 };
  get calls() {
    return this.callsUsed;
  }
  /** Removes the key from any text that is about to be shown or logged. */
  redact(text) {
    if (this.options.apiKey.length === 0) return text;
    return text.split(this.options.apiKey).join("[redacted]");
  }
  /** One logical request, including retries. Every attempt costs one unit of budget. */
  async send(state, questions) {
    const body = JSON.stringify({ state, model: this.options.model, questions });
    let attempt = 0;
    let backoff = BACKOFF_START_MS;
    for (; ; ) {
      if (this.callsUsed >= this.options.maxCalls) {
        return { ok: false, failure: "budget", message: "call budget exhausted" };
      }
      this.callsUsed += 1;
      attempt += 1;
      let response;
      try {
        response = await this.options.fetchImpl(this.options.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            "Content-Type": "application/json"
          },
          body,
          signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 9e4)
        });
      } catch (error) {
        const message = this.redact(error instanceof Error ? error.message : String(error));
        if (attempt < MAX_ATTEMPTS) {
          this.options.note(`network error, retrying: ${message}`);
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
          continue;
        }
        this.options.note(`network error, giving up: ${message}`);
        return { ok: false, failure: "network", message: `network error: ${message}` };
      }
      let text;
      try {
        text = await response.text();
      } catch (error) {
        const message = this.redact(error instanceof Error ? error.message : String(error));
        if (attempt < MAX_ATTEMPTS) {
          this.options.note(`could not read response body, retrying: ${message}`);
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
          continue;
        }
        return { ok: false, failure: "network", message: `unreadable response: ${message}` };
      }
      if (response.status === 200) {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (error) {
          const message = this.redact(error instanceof Error ? error.message : String(error));
          if (attempt < MAX_ATTEMPTS) {
            this.options.note(`unparseable 200 body, retrying: ${message}`);
            await this.sleep(backoff);
            backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
            continue;
          }
          return { ok: false, failure: "server", message: `unparseable response: ${message}` };
        }
        const answers = readAnswers(parsed);
        if (answers === null) {
          if (attempt < MAX_ATTEMPTS) {
            this.options.note("200 response without an answers object, retrying");
            await this.sleep(backoff);
            backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
            continue;
          }
          return { ok: false, failure: "server", message: "response had no answers object" };
        }
        const usage = readUsage(parsed);
        this.usage.inputTokens += usage.inputTokens;
        this.usage.outputTokens += usage.outputTokens;
        return { ok: true, answers, usage };
      }
      if (response.status === 402 || text.includes('"billing_error"')) {
        return { ok: false, failure: "billing", message: BILLING_EXHAUSTED };
      }
      if (response.status === 429) {
        this.limit = 1;
        const wait = parseRetryAfter(response.headers.get("retry-after")) ?? backoff;
        if (attempt < MAX_ATTEMPTS) {
          this.options.note(`rate limited, waiting ${wait} ms`);
          await this.sleep(wait);
          backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
          continue;
        }
        return { ok: false, failure: "rate_limit", message: "rate limited by Jev" };
      }
      if (response.status === 400 && text.includes("max_tokens_exceeded")) {
        return { ok: false, failure: "too_large", message: "max_tokens_exceeded" };
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, failure: "auth", message: AUTH_REJECTED };
      }
      if (response.status >= 500) {
        if (attempt < MAX_ATTEMPTS) {
          this.options.note(`Jev returned ${response.status}, retrying`);
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
          continue;
        }
        return { ok: false, failure: "server", message: `Jev returned ${response.status}` };
      }
      const snippet = this.redact(text.slice(0, 200).replace(/\s+/g, " ").trim());
      return {
        ok: false,
        failure: "client",
        message: `Jev returned ${response.status}: ${snippet}`
      };
    }
  }
  /**
   * Runs nodes with bounded concurrency. A node the service calls too long is halved and
   * both halves are queued; a node that cannot halve is returned as a failure.
   */
  async askAll(nodes) {
    const queue = [...nodes];
    const results = [];
    let active = 0;
    let settled = false;
    return new Promise((resolve3) => {
      const pump = () => {
        if (settled) return;
        if (queue.length === 0 && active === 0) {
          settled = true;
          resolve3(results);
          return;
        }
        while (active < this.limit && queue.length > 0) {
          const node = queue.shift();
          if (node === void 0) break;
          active += 1;
          this.send(node.state, node.questions).then((outcome) => {
            if (!outcome.ok && outcome.failure === "too_large") {
              const halves = node.halve();
              if (halves !== null) {
                this.options.note("request too long for Jev, resending as two halves");
                queue.push(halves[0], halves[1]);
                return;
              }
              results.push({
                node,
                outcome: {
                  ok: false,
                  failure: "client",
                  message: "too long for Jev and cannot be split further"
                }
              });
              return;
            }
            results.push({ node, outcome });
          }).catch((error) => {
            const message = this.redact(error instanceof Error ? error.message : String(error));
            this.options.note(`unexpected error while asking Jev: ${message}`);
            results.push({
              node,
              outcome: { ok: false, failure: "network", message }
            });
          }).finally(() => {
            active -= 1;
            pump();
          });
        }
      };
      pump();
    });
  }
};

// src/key.ts
import { promises as fs6 } from "node:fs";
async function resolveApiKey(env) {
  const direct = env["TYPESAFE_API_KEY"];
  if (typeof direct === "string") {
    if (direct.trim().length === 0) {
      return { ok: false, reason: "TYPESAFE_API_KEY is set but empty. Unset it or put your key in it." };
    }
    return { ok: true, key: direct.trim() };
  }
  const file = env["TYPESAFE_API_KEY_FILE"];
  if (typeof file === "string") {
    if (file.trim().length === 0) {
      return {
        ok: false,
        reason: "TYPESAFE_API_KEY_FILE is set but empty. Unset it or point it at a file holding your key."
      };
    }
    const keyPath = file.trim();
    try {
      const key = (await fs6.readFile(keyPath, "utf8")).trim();
      if (key.length === 0) {
        return { ok: false, reason: `${keyPath}, named by TYPESAFE_API_KEY_FILE, is empty` };
      }
      return { ok: true, key };
    } catch (error) {
      const err = error;
      return {
        ok: false,
        reason: `could not read ${keyPath}, named by TYPESAFE_API_KEY_FILE: ${err.code ?? err.message}`
      };
    }
  }
  return {
    ok: false,
    reason: "no Jev API key. Set TYPESAFE_API_KEY, or TYPESAFE_API_KEY_FILE to a file holding it."
  };
}

// src/credentials.ts
var TEAM_CONFIG_FILE = ".stop-rules.json";
var SYSTEMONE_PATH = "/v1/systemone";
var TOKEN_FILE = "token";
var JEV_KEY_FILE = "jev-key";
var TOKEN_REJECTED = "the team token is missing or wrong; run stop-rules login";
function envValue(env, name) {
  const raw = env[name];
  if (raw === void 0) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: `${name} is set but empty. Unset it or give it a value.` };
  }
  return { ok: true, value: trimmed };
}
function configDir(env) {
  const xdg = envValue(env, "XDG_CONFIG_HOME");
  if (!xdg.ok) throw new Error(xdg.reason);
  const base = xdg.value === null ? path14.join(homedir(), ".config") : xdg.value;
  return path14.join(base, "stop-rules");
}
function tokenPath(env) {
  return path14.join(configDir(env), TOKEN_FILE);
}
function jevKeyPath(env) {
  return path14.join(configDir(env), JEV_KEY_FILE);
}
async function readTrimmed(file) {
  let text;
  try {
    text = (await fs7.readFile(file, "utf8")).trim();
  } catch (error) {
    const err = error;
    if (err.code === "ENOENT") return { value: null };
    return { value: null, error: `could not read ${file}: ${err.code ?? err.message}` };
  }
  if (text.length === 0) return { value: null, error: `${file} is empty. Store the secret again.` };
  return { value: text };
}
function parseEndpoint(raw) {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return { ok: false, reason: "the team endpoint is empty" };
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: `${raw} is not a URL` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `the team endpoint must start with http:// or https://, not ${parsed.protocol}` };
  }
  const isFull = trimmed.endsWith(SYSTEMONE_PATH);
  return {
    ok: true,
    base: isFull ? trimmed.slice(0, -SYSTEMONE_PATH.length) : trimmed,
    post: isFull ? trimmed : `${trimmed}${SYSTEMONE_PATH}`
  };
}
async function readTeamEndpoint(repoRoot, env) {
  const fromEnv = envValue(env, "STOP_RULES_ENDPOINT");
  if (!fromEnv.ok) return { ok: false, reason: fromEnv.reason };
  if (fromEnv.value !== null) {
    return { ok: true, endpoint: fromEnv.value, source: "STOP_RULES_ENDPOINT" };
  }
  const file = path14.join(repoRoot, TEAM_CONFIG_FILE);
  let raw;
  try {
    raw = await fs7.readFile(file, "utf8");
  } catch (error) {
    const err = error;
    if (err.code === "ENOENT") return { ok: true, endpoint: null, source: "none" };
    return { ok: false, reason: `could not read ${file}: ${err.code ?? err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      reason: `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `${file} does not hold a JSON object.` };
  }
  const endpoint = parsed.endpoint;
  if (endpoint === void 0) {
    return {
      ok: false,
      reason: `${file} has no endpoint. Write one with stop-rules team <url>, or delete the file to use your own Jev key.`
    };
  }
  if (typeof endpoint !== "string") {
    return { ok: false, reason: `the endpoint in ${file} is not a string.` };
  }
  if (endpoint.trim().length === 0) {
    return { ok: false, reason: `the endpoint in ${file} is empty.` };
  }
  return { ok: true, endpoint, source: file };
}
async function resolveCredentials(repoRoot, env) {
  const configHome = envValue(env, "XDG_CONFIG_HOME");
  if (!configHome.ok) return { ok: false, reason: configHome.reason };
  const model = envValue(env, "STOP_RULES_JEV_MODEL");
  if (!model.ok) return { ok: false, reason: model.reason };
  const chosenModel = model.value === null ? DEFAULT_MODEL : model.value;
  const team = await readTeamEndpoint(repoRoot, env);
  if (!team.ok) return { ok: false, reason: team.reason };
  if (team.endpoint !== null) {
    const parsed = parseEndpoint(team.endpoint);
    if (!parsed.ok) return { ok: false, reason: `${parsed.reason} (from ${team.source})` };
    const fromEnv = envValue(env, "STOP_RULES_TOKEN");
    if (!fromEnv.ok) return { ok: false, reason: fromEnv.reason };
    let token = fromEnv.value;
    if (token === null) {
      const file = await readTrimmed(tokenPath(env));
      if (file.error !== void 0) return { ok: false, reason: file.error };
      token = file.value;
    }
    if (token === null) {
      return {
        ok: false,
        reason: `no team token for ${parsed.base}. Store one with: printf %s "$TOKEN" | stop-rules login --token-stdin`
      };
    }
    return {
      ok: true,
      credentials: {
        mode: "team",
        endpoint: parsed.post,
        bearer: token,
        model: chosenModel,
        teamBase: parsed.base
      }
    };
  }
  const override = envValue(env, "STOP_RULES_JEV_ENDPOINT");
  if (!override.ok) return { ok: false, reason: override.reason };
  const endpoint = override.value === null ? DEFAULT_ENDPOINT : override.value;
  if (env["TYPESAFE_API_KEY"] !== void 0 || env["TYPESAFE_API_KEY_FILE"] !== void 0) {
    const key = await resolveApiKey(env);
    if (!key.ok) return { ok: false, reason: key.reason };
    return {
      ok: true,
      credentials: { mode: "local", endpoint, bearer: key.key, model: chosenModel }
    };
  }
  const stored = await readTrimmed(jevKeyPath(env));
  if (stored.error !== void 0) return { ok: false, reason: stored.error };
  if (stored.value !== null) {
    return {
      ok: true,
      credentials: { mode: "local", endpoint, bearer: stored.value, model: chosenModel }
    };
  }
  return {
    ok: false,
    reason: "no Jev API key and no team endpoint. Set TYPESAFE_API_KEY, or store a key with stop-rules login --jev-key-stdin, or point this repo at your team server with stop-rules team <url>."
  };
}
async function writeTeamConfig(repoRoot, endpoint) {
  const parsed = parseEndpoint(endpoint);
  if (!parsed.ok) return { ok: false, lines: [`stop-rules: ${parsed.reason}`] };
  const file = path14.join(repoRoot, TEAM_CONFIG_FILE);
  let settings = {};
  let existed = false;
  try {
    const raw = await fs7.readFile(file, "utf8");
    existed = true;
    const parsedFile = JSON.parse(raw);
    if (typeof parsedFile !== "object" || parsedFile === null || Array.isArray(parsedFile)) {
      return {
        ok: false,
        lines: [`stop-rules: ${file} does not hold a JSON object. Nothing was changed.`]
      };
    }
    settings = parsedFile;
  } catch (error) {
    const err = error;
    if (err.code !== "ENOENT") {
      return {
        ok: false,
        lines: [
          `stop-rules: could not use ${file}: ${err.message}`,
          "Nothing was changed. Fix the file and try again."
        ]
      };
    }
  }
  settings["endpoint"] = parsed.base;
  await fs7.writeFile(file, `${JSON.stringify(settings, null, 2)}
`, "utf8");
  return {
    ok: true,
    lines: [
      existed ? `updated ${file}` : `wrote ${file}`,
      `  endpoint: ${parsed.base}`,
      "Commit that file: it holds no secret. Every developer then only needs the team token:",
      '  printf %s "$TOKEN" | stop-rules login --token-stdin'
    ]
  };
}
async function login(env, target, secret) {
  const value2 = secret.trim();
  if (value2.length === 0) {
    return {
      ok: false,
      lines: [
        "stop-rules: nothing arrived on stdin.",
        'Use: printf %s "$SECRET" | stop-rules login --token-stdin'
      ]
    };
  }
  const dir = configDir(env);
  const file = target === "token" ? tokenPath(env) : jevKeyPath(env);
  await fs7.mkdir(dir, { recursive: true, mode: 448 });
  await fs7.writeFile(file, `${value2}
`, { encoding: "utf8", mode: 384 });
  await fs7.chmod(file, 384);
  return {
    ok: true,
    lines: [
      `wrote ${file} with mode 0600`,
      target === "token" ? "That is the team token. The Jev key stays on your team's server." : "That is your own Jev key, used when this repo has no team endpoint.",
      "Check it with: stop-rules login --check"
    ]
  };
}
async function loginCheck(repoRoot, env, fetchImpl = (url, init2) => fetch(url, init2)) {
  const resolved = await resolveCredentials(repoRoot, env);
  if (!resolved.ok) return { ok: false, lines: [`stop-rules: ${resolved.reason}`] };
  const { mode, endpoint, bearer: bearer2, model, teamBase } = resolved.credentials;
  const lines = [`mode: ${mode}`, `endpoint: ${endpoint}`];
  let ok = true;
  if (teamBase !== void 0) {
    try {
      const response = await fetch(`${teamBase}/health`, { headers: { accept: "application/json" } });
      const text = (await response.text()).slice(0, 300).replace(/\s+/g, " ").trim();
      lines.push(`health: ${response.status === 200 ? "pass" : "fail"} (${response.status}) ${text}`);
      if (response.status !== 200) ok = false;
    } catch (error) {
      lines.push(`health: fail (${error instanceof Error ? error.message : String(error)})`);
      ok = false;
    }
  }
  const client = new JevClient({
    endpoint,
    model,
    apiKey: bearer2,
    // Room for the transport's own three attempts, so a network failure reports itself as
    // one rather than as an exhausted budget.
    maxCalls: 4,
    fetchImpl,
    note: (message) => {
      lines.push(`  note: ${message}`);
    }
  });
  const outcome = await client.send(
    { probe: "stop-rules connectivity check" },
    { q0: { type: "noul", instructions: "This request reached Jev." } }
  );
  if (outcome.ok) {
    const answer = outcome.answers["q0"];
    lines.push(
      answer === void 0 ? "jev: fail (the answer for q0 was missing)" : `jev: pass (answered ${answer.toFixed(2)})`
    );
    if (answer === void 0) ok = false;
  } else {
    const message = outcome.failure === "auth" && mode === "team" ? TOKEN_REJECTED : outcome.message;
    lines.push(`jev: fail (${message})`);
    ok = false;
  }
  return { ok, lines };
}

// src/diff.ts
var CHUNK_MAX_BYTES = 12e3;
var LONG_LINE_LIMIT = 1e3;
function longLineMarker(chars) {
  return `<stop-rules left out a ${chars} character line here: data, not code>`;
}
var LONG_LINE_MARKER_RE = /^<stop-rules left out a \d+ character line here: data, not code>$/;
function isLongLineMarker(text) {
  return LONG_LINE_MARKER_RE.test(text);
}
var encoder = new TextEncoder();
function utf8Bytes(text) {
  return encoder.encode(text).length;
}
function baseName(filePath) {
  const cut = filePath.lastIndexOf("/");
  return cut === -1 ? filePath : filePath.slice(cut + 1);
}
var SKIP_BASENAMES = /* @__PURE__ */ new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
  "Gemfile.lock",
  "composer.lock",
  // Our own two files: the rules being checked and the team endpoint. Configuration, not
  // code any rule is about.
  ".stop-rules.md",
  ".stop-rules.json"
]);
var SKIP_SUFFIXES = [
  ".min.js",
  ".min.css",
  ".map",
  ".snap",
  ".log",
  ".jsonl",
  ".ndjson",
  ".csv",
  ".tsv",
  ".svg",
  ".lock"
];
var OWN_DIR = ".stop-rules/";
var OWN_FILES = /* @__PURE__ */ new Set([".opencode/plugins/stop-rules.ts", ".amp/plugins/stop-rules.ts"]);
function isSkippedPath(filePath, extraSkip = []) {
  if (filePath.startsWith(OWN_DIR) || OWN_FILES.has(filePath)) return true;
  const base = baseName(filePath);
  if (SKIP_BASENAMES.has(base)) return true;
  if (SKIP_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;
  return extraSkip.includes(filePath);
}
function countOld(lines) {
  let n = 0;
  for (const line of lines) {
    if (line.startsWith(" ") || line.startsWith("-")) n += 1;
  }
  return n;
}
function countNew(lines) {
  let n = 0;
  for (const line of lines) {
    if (line.startsWith(" ") || line.startsWith("+")) n += 1;
  }
  return n;
}
function hunkHeader(hunk) {
  const oldCount = countOld(hunk.lines);
  const newCount = countNew(hunk.lines);
  return `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@${hunk.context}`;
}
function hunkText(hunk) {
  return `${hunkHeader(hunk)}
${hunk.lines.join("\n")}
`;
}
function chunkText(chunk) {
  return `${chunk.header.join("\n")}
${chunk.hunks.map(hunkText).join("")}`;
}
function shortenBodyLine(body) {
  const marker = body[0];
  if (marker === void 0) throw new Error("internal error: an empty diff body line");
  const text = body.slice(1);
  if (text.length <= LONG_LINE_LIMIT) return body;
  return `${marker}${longLineMarker(text.length)}`;
}
function addedLines(chunk) {
  const out2 = [];
  for (const hunk of chunk.hunks) {
    let lineNo = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        out2.push({ line: lineNo, text: line.slice(1) });
        lineNo += 1;
      } else if (line.startsWith(" ")) {
        lineNo += 1;
      }
    }
  }
  return out2;
}
function chunkRange(chunk) {
  let from = Number.POSITIVE_INFINITY;
  let to = 0;
  for (const hunk of chunk.hunks) {
    const newCount = countNew(hunk.lines);
    from = Math.min(from, hunk.newStart);
    to = Math.max(to, hunk.newStart + Math.max(newCount, 1) - 1);
  }
  if (!Number.isFinite(from)) return { from: 0, to: 0 };
  return { from, to };
}
var SIMPLE_ESCAPES = {
  '"': 34,
  "\\": 92,
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11
};
function decodeQuotedPath(raw) {
  if (!raw.startsWith('"')) return { ok: true, path: raw };
  if (raw.length < 2 || !raw.endsWith('"')) {
    return { ok: false, reason: "git quoted this path but the closing quote is missing" };
  }
  const body = raw.slice(1, -1);
  const bytes = [];
  let plain = "";
  const flush = () => {
    if (plain.length === 0) return;
    for (const byte of encoder.encode(plain)) bytes.push(byte);
    plain = "";
  };
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === void 0) break;
    if (char !== "\\") {
      plain += char;
      continue;
    }
    i += 1;
    const escape = body[i];
    if (escape === void 0) {
      return { ok: false, reason: "git quoted this path but a backslash escape is cut short" };
    }
    const simple = SIMPLE_ESCAPES[escape];
    if (simple !== void 0) {
      flush();
      bytes.push(simple);
      continue;
    }
    if (escape >= "0" && escape <= "7") {
      const digits = body.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(digits)) {
        return { ok: false, reason: `git quoted this path with an octal escape stop-rules cannot read: \\${digits}` };
      }
      flush();
      bytes.push(Number.parseInt(digits, 8));
      i += 2;
      continue;
    }
    return { ok: false, reason: `git quoted this path with an escape stop-rules does not know: \\${escape}` };
  }
  flush();
  try {
    return { ok: true, path: new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `this path is not valid UTF-8, so stop-rules cannot name it (${message})` };
  }
}
function stripPrefix(raw) {
  const read = decodeQuotedPath(raw);
  if (!read.ok) return read;
  if (read.path.startsWith("a/") || read.path.startsWith("b/")) {
    return { ok: true, path: read.path.slice(2) };
  }
  return read;
}
var HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
function parseDiff(diff, extraSkip = []) {
  const lines = diff.split("\n");
  const files = [];
  const skipped = [];
  const failures = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.startsWith("diff --git ")) {
      i += 1;
      continue;
    }
    const header = [line];
    let binary = false;
    let newPath = null;
    let deleted = false;
    let unreadablePath = null;
    i += 1;
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (current.startsWith("diff --git ") || current.startsWith("@@ ")) break;
      header.push(current);
      i += 1;
      if (current.startsWith("Binary files ") || current.startsWith("GIT binary patch")) {
        binary = true;
        break;
      }
      if (current.startsWith("+++ ")) {
        const target = current.slice(4).trim();
        if (target === "/dev/null") {
          deleted = true;
        } else {
          const read = stripPrefix(target);
          if (read.ok) newPath = read.path;
          else unreadablePath = { file: target, reason: read.reason };
        }
        break;
      }
    }
    const hunks = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (current.startsWith("diff --git ")) break;
      const match = HUNK_RE.exec(current);
      if (!match) {
        i += 1;
        continue;
      }
      const hunk = {
        oldStart: Number(match[1]),
        newStart: Number(match[3]),
        context: match[5] ?? "",
        lines: []
      };
      i += 1;
      while (i < lines.length) {
        const body = lines[i] ?? "";
        if (body.startsWith("diff --git ") || HUNK_RE.test(body)) break;
        if (body.startsWith(" ") || body.startsWith("+") || body.startsWith("-") || body.startsWith("\\")) {
          hunk.lines.push(shortenBodyLine(body));
          i += 1;
          continue;
        }
        if (body.length === 0) {
          if (i === lines.length - 1) {
            i += 1;
            break;
          }
          hunk.lines.push(" ");
          i += 1;
          continue;
        }
        break;
      }
      hunks.push(hunk);
    }
    if (unreadablePath !== null) {
      failures.push(unreadablePath);
      continue;
    }
    if (binary) {
      skipped.push({ file: newPath ?? headerPath(line, failures), reason: "binary file" });
      continue;
    }
    if (deleted || newPath === null) continue;
    if (isSkippedPath(newPath, extraSkip)) {
      skipped.push({ file: newPath, reason: "generated or data file" });
      continue;
    }
    const added = hunks.flatMap((hunk) => hunk.lines.filter((l) => l.startsWith("+")));
    if (added.length === 0) continue;
    if (added.every((l) => isLongLineMarker(l.slice(1)))) {
      skipped.push({ file: newPath, reason: "every added line is data, not code" });
      continue;
    }
    files.push({ file: newPath, header, hunks });
  }
  return { files, skipped, failures };
}
function headerPath(headerLine, failures) {
  const rest = headerLine.slice("diff --git ".length);
  const cut = rest.lastIndexOf(" b/");
  if (cut === -1) {
    failures.push({ file: rest, reason: "stop-rules could not find a file name in this diff header" });
    return rest;
  }
  const read = stripPrefix(rest.slice(cut + 1));
  if (read.ok) return read.path;
  failures.push({ file: rest, reason: read.reason });
  return rest;
}
function splitHunk(hunk, pieces) {
  if (pieces < 2 || hunk.lines.length < 2) return [hunk];
  const per = Math.ceil(hunk.lines.length / pieces);
  const out2 = [];
  let oldCursor = hunk.oldStart;
  let newCursor = hunk.newStart;
  for (let start = 0; start < hunk.lines.length; start += per) {
    const slice = hunk.lines.slice(start, start + per);
    out2.push({ oldStart: oldCursor, newStart: newCursor, context: hunk.context, lines: slice });
    oldCursor += countOld(slice);
    newCursor += countNew(slice);
  }
  return out2;
}
function splitHunkToFit(hunk, headerBytes) {
  const budget = Math.max(CHUNK_MAX_BYTES - headerBytes, 1);
  if (utf8Bytes(hunkText(hunk)) <= budget) return [hunk];
  if (hunk.lines.length < 2) return [hunk];
  let pieces = 2;
  for (; ; ) {
    const parts = splitHunk(hunk, pieces);
    const tooBig = parts.some((part) => utf8Bytes(hunkText(part)) > budget);
    if (!tooBig || pieces >= hunk.lines.length) return parts;
    pieces *= 2;
  }
}
function chunkFile(file) {
  const headerBytes = utf8Bytes(`${file.header.join("\n")}
`);
  const fitted = [];
  for (const hunk of file.hunks) {
    fitted.push(...splitHunkToFit(hunk, headerBytes));
  }
  const chunks = [];
  let current = [];
  let currentBytes = headerBytes;
  for (const hunk of fitted) {
    const size = utf8Bytes(hunkText(hunk));
    if (current.length > 0 && currentBytes + size > CHUNK_MAX_BYTES) {
      chunks.push({ file: file.file, header: file.header, hunks: current });
      current = [];
      currentBytes = headerBytes;
    }
    current.push(hunk);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push({ file: file.file, header: file.header, hunks: current });
  return chunks.filter((chunk) => chunk.hunks.some((h) => h.lines.some((l) => l.startsWith("+"))));
}
function halveChunk(chunk) {
  if (chunk.hunks.length > 1) {
    const mid = Math.ceil(chunk.hunks.length / 2);
    return [
      { file: chunk.file, header: chunk.header, hunks: chunk.hunks.slice(0, mid) },
      { file: chunk.file, header: chunk.header, hunks: chunk.hunks.slice(mid) }
    ];
  }
  const only = chunk.hunks[0];
  if (only === void 0 || only.lines.length < 2) return null;
  const parts = splitHunk(only, 2);
  const first = parts[0];
  const second = parts[1];
  if (first === void 0 || second === void 0) return null;
  return [
    { file: chunk.file, header: chunk.header, hunks: [first] },
    { file: chunk.file, header: chunk.header, hunks: [second] }
  ];
}

// src/engine.ts
var MAX_LINES_PER_VIOLATION = 3;
var MAX_RULES_PER_CALL = 200;
var CACHE_KEY_VERSION = "v1";
function stage1Claim(rule) {
  return `The added lines in this diff violate this coding rule: ${rule.text}`;
}
function stage2Claim(line) {
  return `Added line ${line.line} is where this diff violates the rule: ${line.text.trim()}`;
}
var encoder2 = new TextEncoder();
async function sha256Hex(parts) {
  const digest2 = await globalThis.crypto.subtle.digest(
    "SHA-256",
    encoder2.encode(parts.join("\0"))
  );
  return [...new Uint8Array(digest2)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function cacheKey(model, claim, state) {
  return sha256Hex([CACHE_KEY_VERSION, model, claim, JSON.stringify(state)]);
}
function unlocalisedFor(entry) {
  if (entry.candidates.size > 0) return null;
  const first = entry.unlocalised[0];
  if (first === void 0) {
    throw new Error(`internal error: ${entry.file} has neither a line nor a reason for having none`);
  }
  return first;
}
function entryKey(file, ruleId2) {
  return `${file}\0${ruleId2}`;
}
function reasonFor(failure2, message) {
  return failure2 === "budget" ? "call budget exhausted" : message;
}
function notCheckedFor(chunk, reason) {
  const range = chunkRange(chunk);
  return { file: chunk.file, fromLine: range.from, toLine: range.to, reason };
}
function makeStage1Node(chunk, rules) {
  const questions = {};
  const byQuestion = {};
  rules.forEach((rule, index) => {
    const id = `q${index}`;
    questions[id] = { type: "noul", instructions: stage1Claim(rule) };
    byQuestion[id] = rule;
  });
  return {
    payload: { chunk, rules, byQuestion },
    state: { file: chunk.file, diff: chunkText(chunk) },
    questions,
    halve: () => {
      const halves = halveChunk(chunk);
      if (halves === null) return null;
      return [makeStage1Node(halves[0], rules), makeStage1Node(halves[1], rules)];
    }
  };
}
function makeStage2Node(chunk, rule, lines) {
  const questions = {};
  const byQuestion = {};
  lines.forEach((line, index) => {
    const id = `q${index}`;
    questions[id] = { type: "noul", instructions: stage2Claim(line) };
    byQuestion[id] = line;
  });
  return {
    payload: { chunk, rule, byQuestion },
    state: { file: chunk.file, diff: chunkText(chunk), rule: rule.text },
    questions,
    halve: () => {
      if (lines.length < 2) return null;
      const mid = Math.ceil(lines.length / 2);
      return [
        makeStage2Node(chunk, rule, lines.slice(0, mid)),
        makeStage2Node(chunk, rule, lines.slice(mid))
      ];
    }
  };
}
function localisableLines(chunk) {
  return addedLines(chunk).filter(
    (line) => /[A-Za-z0-9]/.test(line.text) && !isLongLineMarker(line.text)
  );
}
async function runEngine(input) {
  const { cache, note, threshold, model } = input;
  const client = new JevClient({
    endpoint: input.endpoint,
    model,
    apiKey: input.apiKey,
    maxCalls: input.maxCalls,
    fetchImpl: input.fetchImpl,
    note,
    ...input.sleep ? { sleep: input.sleep } : {},
    ...input.concurrency !== void 0 ? { concurrency: input.concurrency } : {}
  });
  const notChecked = [];
  const hits = [];
  let cacheHits = 0;
  let answered = 0;
  let holdBaseline = false;
  let transportFailed = false;
  let blocked = null;
  const noteFailure = (failure2) => {
    if (blocked !== null) return;
    if (failure2 === "auth") blocked = "auth";
    else if (failure2 === "billing") blocked = "billing";
  };
  const stage1Nodes = [];
  for (const chunk of input.chunks) {
    const chunkState = { file: chunk.file, diff: chunkText(chunk) };
    const uncached = [];
    for (const rule of input.rules) {
      const cached = cache.get(await cacheKey(model, stage1Claim(rule), chunkState));
      if (cached === void 0) {
        uncached.push(rule);
        continue;
      }
      cacheHits += 1;
      answered += 1;
      if (cached >= threshold) hits.push({ chunk, rule, score: cached });
    }
    for (let i = 0; i < uncached.length; i += MAX_RULES_PER_CALL) {
      stage1Nodes.push(makeStage1Node(chunk, uncached.slice(i, i + MAX_RULES_PER_CALL)));
    }
  }
  for (const result of await client.askAll(stage1Nodes)) {
    const { chunk, byQuestion } = result.node.payload;
    if (!result.outcome.ok) {
      const failure2 = result.outcome.failure;
      if (holdsBaseline(failure2)) holdBaseline = true;
      noteFailure(failure2);
      if (failure2 !== "budget") transportFailed = true;
      notChecked.push(notCheckedFor(chunk, reasonFor(failure2, result.outcome.message)));
      continue;
    }
    for (const [id, rule] of Object.entries(byQuestion)) {
      const noul = result.outcome.answers[id];
      if (noul === void 0) {
        note(`Jev returned no answer for rule ${rule.id} on ${chunk.file}`);
        notChecked.push(notCheckedFor(chunk, `Jev returned no answer for rule ${rule.id}`));
        continue;
      }
      answered += 1;
      cache.set(await cacheKey(model, stage1Claim(rule), result.node.state), noul);
      if (noul >= threshold) hits.push({ chunk, rule, score: noul });
    }
  }
  const fresh = input.skipFinding === void 0 ? hits : hits.filter((hit) => !input.skipFinding?.(hit.rule.id, chunkText(hit.chunk)));
  const stage2Nodes = [];
  const scores = /* @__PURE__ */ new Map();
  const localiseFailures = /* @__PURE__ */ new Map();
  const hitKey = (rule, chunk) => `${rule.id}\0${chunkText(chunk)}`;
  for (const hit of fresh) {
    const lineState = { file: hit.chunk.file, diff: chunkText(hit.chunk), rule: hit.rule.text };
    const perLine = /* @__PURE__ */ new Map();
    scores.set(hitKey(hit.rule, hit.chunk), perLine);
    const uncached = [];
    for (const line of localisableLines(hit.chunk)) {
      const cached = cache.get(await cacheKey(model, stage2Claim(line), lineState));
      if (cached === void 0) {
        uncached.push(line);
        continue;
      }
      cacheHits += 1;
      perLine.set(line.line, cached);
    }
    if (uncached.length > 0) stage2Nodes.push(makeStage2Node(hit.chunk, hit.rule, uncached));
  }
  for (const result of await client.askAll(stage2Nodes)) {
    const { chunk, rule, byQuestion } = result.node.payload;
    const target = scores.get(hitKey(rule, chunk));
    if (!result.outcome.ok) {
      const failure2 = result.outcome.failure;
      if (holdsBaseline(failure2)) holdBaseline = true;
      noteFailure(failure2);
      const why = `the question about which line failed: ${reasonFor(failure2, result.outcome.message)}`;
      note(`could not localise rule ${rule.id} in ${chunk.file}: ${why}`);
      localiseFailures.set(hitKey(rule, chunk), why);
      continue;
    }
    for (const [id, line] of Object.entries(byQuestion)) {
      const noul = result.outcome.answers[id];
      if (noul === void 0) {
        note(`Jev returned no answer for line ${line.line} of ${chunk.file}`);
        continue;
      }
      cache.set(await cacheKey(model, stage2Claim(line), result.node.state), noul);
      target?.set(line.line, noul);
    }
  }
  const entries = /* @__PURE__ */ new Map();
  const findings = [];
  for (const hit of fresh) {
    const key2 = hitKey(hit.rule, hit.chunk);
    const perLine = scores.get(key2);
    if (perLine === void 0) {
      throw new Error(`internal error: no line scores were recorded for ${hit.chunk.file}`);
    }
    const textByLine = new Map(addedLines(hit.chunk).map((line) => [line.line, line.text.trim()]));
    const byScore = [...perLine.entries()].sort((a, b) => b[1] - a[1]);
    const above = byScore.filter(([, score]) => score >= threshold).slice(0, MAX_LINES_PER_VIOLATION);
    findings.push({ ruleId: hit.rule.id, chunkText: chunkText(hit.chunk) });
    const range = chunkRange(hit.chunk);
    let unlocalised = null;
    if (above.length === 0) {
      const failed2 = localiseFailures.get(key2);
      if (failed2 !== void 0) unlocalised = failed2;
      else if (byScore.length > 0) {
        unlocalised = `no added line reached the ${threshold} cutoff`;
      } else if (localisableLines(hit.chunk).length === 0) {
        unlocalised = "no added line in this block has text to point at";
      } else {
        unlocalised = "no line scores came back for this block";
      }
    }
    const key = entryKey(hit.chunk.file, hit.rule.id);
    let entry = entries.get(key);
    if (entry === void 0) {
      entry = {
        file: hit.chunk.file,
        ruleId: hit.rule.id,
        rule: hit.rule.text,
        confidence: hit.score,
        fromLine: range.from,
        toLine: range.to,
        unlocalised: [],
        candidates: /* @__PURE__ */ new Map()
      };
      entries.set(key, entry);
    }
    entry.confidence = Math.max(entry.confidence, hit.score);
    entry.fromLine = Math.min(entry.fromLine, range.from);
    entry.toLine = Math.max(entry.toLine, range.to);
    if (unlocalised !== null) entry.unlocalised.push(unlocalised);
    for (const [lineNo, score] of above) {
      const text = textByLine.get(lineNo);
      if (text === void 0) {
        throw new Error(`internal error: line ${lineNo} is not an added line of ${hit.chunk.file}`);
      }
      const existing = entry.candidates.get(lineNo);
      if (existing === void 0 || existing.score < score) {
        entry.candidates.set(lineNo, { text, score });
      }
    }
  }
  const violations = [...entries.values()].map((entry) => ({
    file: entry.file,
    lines: [...entry.candidates.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, MAX_LINES_PER_VIOLATION).map(([line, value2]) => ({ line, text: value2.text })).sort((a, b) => a.line - b.line),
    fromLine: entry.fromLine,
    toLine: entry.toLine,
    // One line named is enough for the entry; the reason is only reported when none is.
    unlocalised: unlocalisedFor(entry),
    ruleId: entry.ruleId,
    rule: entry.rule,
    confidence: entry.confidence
  }));
  const firstLine = (violation) => {
    const first = violation.lines[0];
    return first === void 0 ? violation.fromLine : first.line;
  };
  violations.sort(
    (a, b) => a.file === b.file ? firstLine(a) - firstLine(b) : a.file < b.file ? -1 : 1
  );
  const fromLineOf = (entry) => entry.fromLine === void 0 ? 0 : entry.fromLine;
  notChecked.sort(
    (a, b) => a.file === b.file ? fromLineOf(a) - fromLineOf(b) : a.file < b.file ? -1 : 1
  );
  return {
    violations,
    notChecked,
    calls: client.calls,
    cacheHits,
    answered,
    transportFailed,
    holdBaseline,
    blocked,
    usage: client.usage,
    findings
  };
}

// src/git.ts
import { execFile } from "node:child_process";
import { promises as fs8 } from "node:fs";
import * as path15 from "node:path";
import { randomBytes } from "node:crypto";
var MAX_BUFFER = 256 * 1024 * 1024;
function runGit(cwd, args, extraEnv) {
  return new Promise((resolve3, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
        maxBuffer: MAX_BUFFER,
        encoding: "utf8"
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve3({ code: 0, stdout, stderr });
          return;
        }
        const withCode = error;
        if (typeof withCode.code === "number") {
          resolve3({ code: withCode.code, stdout, stderr });
          return;
        }
        reject(new Error(`could not run git ${args.join(" ")}: ${error.message}`));
      }
    );
  });
}
async function gitOrThrow(cwd, args, extraEnv) {
  const result = await runGit(cwd, args, extraEnv);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}
async function findRepo(cwd) {
  const root = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (root.code !== 0) return null;
  const gitDir = await runGit(cwd, ["rev-parse", "--absolute-git-dir"]);
  if (gitDir.code !== 0) return null;
  return { root: root.stdout.trim(), gitDir: gitDir.stdout.trim() };
}
async function hasHead(root) {
  const result = await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return result.code === 0;
}
async function objectExists(root, rev) {
  const result = await runGit(root, ["cat-file", "-e", `${rev}^{object}`]);
  return result.code === 0;
}
async function resolveTree(root, rev) {
  const result = await runGit(root, ["rev-parse", "--verify", "--quiet", `${rev}^{tree}`]);
  if (result.code !== 0) return null;
  const tree = result.stdout.trim();
  return tree.length > 0 ? tree : null;
}
async function emptyTree(root) {
  const out2 = await gitOrThrow(root, ["hash-object", "-w", "-t", "tree", "--stdin"]);
  return out2.trim();
}
async function snapshotWorkingTree(repo, stateDir) {
  await fs8.mkdir(stateDir, { recursive: true });
  const indexPath = path15.join(stateDir, `index-${process.pid}-${randomBytes(4).toString("hex")}`);
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    if (await hasHead(repo.root)) {
      await gitOrThrow(repo.root, ["read-tree", "HEAD"], env);
    }
    await gitOrThrow(repo.root, ["add", "-A", "--", "."], env);
    const tree = await gitOrThrow(repo.root, ["write-tree"], env);
    return tree.trim();
  } finally {
    await fs8.rm(indexPath, { force: true });
    await fs8.rm(`${indexPath}.lock`, { force: true });
  }
}
async function diffTrees(root, base, head) {
  return gitOrThrow(root, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    "-U8",
    base,
    head
  ]);
}

// src/report.ts
var MAX_QUOTED_LINE = 160;
function confidence(score) {
  return score.toFixed(2);
}
function trimQuoted(text) {
  if (text.length <= MAX_QUOTED_LINE) return text;
  return `${text.slice(0, MAX_QUOTED_LINE)}...`;
}
function notCheckedLine(entry) {
  if (entry.fromLine === void 0 || entry.toLine === void 0) {
    return `${entry.file}: ${entry.reason}`;
  }
  const where = entry.fromLine === entry.toLine ? `line ${entry.fromLine}` : `lines ${entry.fromLine}-${entry.toLine}`;
  return `${entry.file} ${where}: ${entry.reason}`;
}
function violationBlock(violation, index) {
  if (violation.unlocalised !== null) {
    const range = violation.fromLine === violation.toLine ? `line ${violation.fromLine}` : `lines ${violation.fromLine}-${violation.toLine}`;
    return [
      `${index}. ${violation.file} ${range}`,
      `   Rule: ${violation.rule}`,
      `   No single line identified: ${violation.unlocalised}`,
      `   Confidence: ${confidence(violation.confidence)}`
    ].join("\n");
  }
  const where = violation.lines.map((line) => line.line).join(", ");
  return [
    `${index}. ${violation.file}:${where}`,
    `   Rule: ${violation.rule}`,
    ...violation.lines.map((line) => `   Line: ${trimQuoted(line.text)}`),
    `   Confidence: ${confidence(violation.confidence)}`
  ].join("\n");
}
function renderReport(report) {
  const { violations, notChecked, stats } = report;
  const sections = [];
  if (violations.length === 0) {
    sections.push(
      stats.chunks === 0 ? "stop-rules: no changes to check." : "stop-rules: no rule violations in your latest changes."
    );
  } else {
    const count = violations.length === 1 ? "1 rule violation" : `${violations.length} rule violations`;
    sections.push(
      `stop-rules: ${count} in your latest changes.
Fix each one. If a rule truly should not apply here, leave the code and tell the user why.`
    );
    sections.push(violations.map((violation, i) => violationBlock(violation, i + 1)).join("\n\n"));
  }
  if (notChecked.length === 1) {
    const only = notChecked[0];
    if (only !== void 0) sections.push(`Not checked (1): ${notCheckedLine(only)}`);
  } else if (notChecked.length > 1) {
    sections.push(
      `Not checked (${notChecked.length}):
` + notChecked.map((entry) => `  ${notCheckedLine(entry)}`).join("\n")
    );
  }
  return sections.join("\n\n");
}

// src/rules.ts
import { createHash } from "node:crypto";
import { promises as fs9 } from "node:fs";
var TOP_LEVEL_ITEM = /^(?:[-*+]|\d+[.)])\s+(.*)$/;
var FENCE = /^\s*(?:```|~~~)/;
function normalise(text) {
  return text.replace(/\s+/g, " ").trim();
}
function ruleId(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
}
function parseRules(markdown) {
  const lines = markdown.split(/\r?\n/);
  const collected = [];
  let current = null;
  let inFence = false;
  let inComment = false;
  const flush = () => {
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
    flush();
  }
  flush();
  const seen = /* @__PURE__ */ new Set();
  const rules = [];
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
async function loadRules(rulesPath) {
  let source;
  try {
    source = await fs9.readFile(rulesPath, "utf8");
  } catch (error) {
    const err = error;
    if (err.code === "ENOENT") {
      return {
        ok: false,
        reason: `no rules file at ${rulesPath}. Run "stop-rules init" to create one.`
      };
    }
    return { ok: false, reason: `could not read ${rulesPath}: ${err.message}` };
  }
  const rules = parseRules(source);
  if (rules.length === 0) {
    return {
      ok: false,
      reason: `no rules found in ${rulesPath}. Each top-level list item is one rule.`
    };
  }
  return { ok: true, rules };
}
var STARTER_RULES = `# Coding rules checked by stop-rules

Each top-level bullet is one rule. Write rules as plain sentences a reviewer could apply
to a diff. Headings and paragraphs are ignored.

If a linter can check it, use the linter. These rules are for things that need judgment.
A rule must also be something a reviewer could judge from one piece of a change, without
seeing the rest of the codebase.

- Do not silently swallow errors. When code catches or receives an error it must rethrow it, return it to the caller, or log it with enough context to debug.
- Do not add fallback values or default branches that hide a failure the caller needs to know about.
- Do not write comments that only restate what the code does, or that narrate the change being made ("now we also handle X", "fixed the bug where"). A comment that explains why the code must be this way is fine.
- Do not delete, skip or loosen an existing test to make it pass.
- Do not hardcode a value or special-case a specific input just to make a test or check pass.
- Do not leave stubs, placeholders, TODO implementations or fake data in code that is presented as finished.
- An error message must say what failed and include the value or identifier that caused it.
`;

// src/state.ts
import { createHash as createHash2, randomBytes as randomBytes2 } from "node:crypto";
import { promises as fs10 } from "node:fs";
import * as path16 from "node:path";
import { setTimeout as delay } from "node:timers/promises";
var MAX_CACHE_ENTRIES = 5e3;
var MAX_REPORTED_ENTRIES = 5e3;
var MAX_LOG_BYTES = 1024 * 1024;
var LOCK_POLL_MS = 200;
function stateDirFor(gitDir) {
  return path16.join(gitDir, "stop-rules");
}
function emptyState() {
  return { version: 1, reported: {}, sessions: {} };
}
function emptyCache() {
  return { version: 1, entries: {} };
}
async function readJson(file) {
  let text;
  try {
    text = await fs10.readFile(file, "utf8");
  } catch (error) {
    const err = error;
    if (err.code === "ENOENT") return null;
    throw new Error(`could not read ${file}: ${err.code ?? err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Run stop-rules baseline --reset to start again.`
    );
  }
}
async function writeJsonAtomic(file, value2) {
  const temp = `${file}.tmp-${process.pid}-${randomBytes2(4).toString("hex")}`;
  await fs10.mkdir(path16.dirname(file), { recursive: true });
  await fs10.writeFile(temp, `${JSON.stringify(value2)}
`, "utf8");
  await fs10.rename(temp, file);
}
function isRecord2(value2) {
  return typeof value2 === "object" && value2 !== null && !Array.isArray(value2);
}
async function loadState(stateDir) {
  const file = path16.join(stateDir, "state.json");
  const raw = await readJson(file);
  if (raw === null) return emptyState();
  if (!isRecord2(raw)) {
    throw new Error(`${file} does not hold a JSON object. Run stop-rules baseline --reset.`);
  }
  const lastTree = raw["lastTree"];
  const reported = raw["reported"];
  const sessions = raw["sessions"];
  const wrong = (field) => new Error(`${file} has a ${field} that stop-rules did not write. Run stop-rules baseline --reset.`);
  if (lastTree !== void 0 && typeof lastTree !== "string") throw wrong("lastTree");
  if (reported !== void 0 && !isRecord2(reported)) throw wrong("reported");
  if (sessions !== void 0 && !isRecord2(sessions)) throw wrong("sessions");
  return {
    version: 1,
    ...typeof lastTree === "string" ? { lastTree } : {},
    reported: isRecord2(reported) ? reported : {},
    sessions: isRecord2(sessions) ? sessions : {}
  };
}
function prune(entries, at, max) {
  const keys = Object.keys(entries);
  if (keys.length <= max) return;
  keys.sort((a, b) => at(entries[a]) - at(entries[b])).slice(0, keys.length - max).forEach((key) => {
    delete entries[key];
  });
}
async function saveState(stateDir, state) {
  prune(state.reported, (value2) => value2, MAX_REPORTED_ENTRIES);
  await writeJsonAtomic(path16.join(stateDir, "state.json"), state);
}
async function loadCache(stateDir) {
  const file = path16.join(stateDir, "cache.json");
  const raw = await readJson(file);
  if (raw === null) return emptyCache();
  if (!isRecord2(raw) || !isRecord2(raw["entries"])) {
    throw new Error(`${file} is not a stop-rules cache. Delete it and run again.`);
  }
  return { version: 1, entries: raw["entries"] };
}
async function resetState(stateDir) {
  await writeJsonAtomic(path16.join(stateDir, "state.json"), emptyState());
}
async function saveCache(stateDir, cache) {
  prune(cache.entries, (value2) => value2.at, MAX_CACHE_ENTRIES);
  await writeJsonAtomic(path16.join(stateDir, "cache.json"), cache);
}
function reportedKey(ruleId2, chunkText2) {
  return createHash2("sha256").update(`${ruleId2}\0${chunkText2}`, "utf8").digest("hex");
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error;
    if (err.code === "EPERM") return true;
    return false;
  }
}
async function acquireLock(stateDir, timeoutMs = 6e4) {
  await fs10.mkdir(stateDir, { recursive: true });
  const lockPath = path16.join(stateDir, "lock");
  const deadline = Date.now() + timeoutMs;
  for (; ; ) {
    try {
      const handle2 = await fs10.open(lockPath, "wx");
      try {
        await handle2.writeFile(String(process.pid), "utf8");
      } finally {
        await handle2.close();
      }
      return async () => {
        try {
          const owner = await fs10.readFile(lockPath, "utf8");
          if (owner.trim() === String(process.pid)) await fs10.rm(lockPath, { force: true });
        } catch (error) {
          const err = error;
          if (err.code !== "ENOENT") {
            process.stderr.write(`stop-rules: could not release the lock: ${err.message}
`);
          }
        }
      };
    } catch (error) {
      const err = error;
      if (err.code !== "EEXIST") throw err;
    }
    let ownerPid = 0;
    try {
      ownerPid = Number.parseInt((await fs10.readFile(lockPath, "utf8")).trim(), 10);
    } catch (readError) {
      const err = readError;
      if (err.code !== "ENOENT") throw err;
      continue;
    }
    if (!pidAlive(ownerPid)) {
      await fs10.rm(lockPath, { force: true });
      continue;
    }
    if (Date.now() >= deadline) return null;
    await delay(LOCK_POLL_MS);
  }
}
async function appendRunLog(stateDir, line) {
  const logPath = path16.join(stateDir, "run.log");
  await fs10.mkdir(stateDir, { recursive: true });
  await fs10.appendFile(logPath, `${JSON.stringify(line)}
`, "utf8");
  const stats = await fs10.stat(logPath);
  if (stats.size <= MAX_LOG_BYTES) return;
  const contents = await fs10.readFile(logPath, "utf8");
  const lines = contents.split("\n").filter((entry) => entry.length > 0);
  const kept = lines.slice(Math.floor(lines.length / 2));
  const temp = `${logPath}.tmp-${process.pid}-${randomBytes2(4).toString("hex")}`;
  await fs10.writeFile(temp, `${kept.join("\n")}
`, "utf8");
  await fs10.rename(temp, logPath);
}

// src/check.ts
var LOOP_GUARD_ROUNDS = 3;
var MAX_SESSIONS_KEPT = 100;
function cannotRun(reason) {
  return { kind: "cannot-run", reason };
}
function fileCache(cache) {
  return {
    get: (key) => cache.entries[key]?.noul,
    set: (key, noul) => {
      cache.entries[key] = { noul, at: Date.now() };
    }
  };
}
async function resetBaseline(cwd) {
  const repo = await findRepo(cwd);
  if (repo === null) {
    return { ok: false, lines: [`stop-rules: ${cwd} is not inside a git repository.`] };
  }
  const stateDir = stateDirFor(repo.gitDir);
  await resetState(stateDir);
  return {
    ok: true,
    lines: [
      `cleared the saved baseline in ${stateDir}`,
      "The next check starts from HEAD and reports everything it finds."
    ]
  };
}
async function run(options) {
  const started = Date.now();
  const env = options.env ?? process.env;
  const notes = [];
  const note = (message) => {
    notes.push(message);
  };
  const repo = await findRepo(options.cwd);
  if (repo === null) return cannotRun(`${options.cwd} is not inside a git repository.`);
  const rulesPath = options.rulesPath ? path17.resolve(options.cwd, options.rulesPath) : path17.join(repo.root, ".stop-rules.md");
  const rulesLoad = await loadRules(rulesPath);
  if (!rulesLoad.ok) return cannotRun(rulesLoad.reason);
  const credentials = await resolveCredentials(repo.root, env);
  if (!credentials.ok) return cannotRun(credentials.reason);
  const stateDir = stateDirFor(repo.gitDir);
  const release = await acquireLock(stateDir);
  if (release === null) {
    return cannotRun("another stop-rules run is still holding the lock after 60 seconds.");
  }
  try {
    return await runLocked({
      options,
      repo,
      rulesPath,
      rules: rulesLoad.rules,
      credentials: credentials.credentials,
      stateDir,
      notes,
      note,
      started
    });
  } finally {
    await release();
  }
}
async function runLocked(args) {
  const { options, repo, rulesPath, rules, credentials, stateDir, notes, note, started } = args;
  const model = credentials.model;
  let state;
  let cache;
  try {
    state = await loadState(stateDir);
    cache = await loadCache(stateDir);
  } catch (error) {
    return cannotRun(error instanceof Error ? error.message : String(error));
  }
  const snapshot = await snapshotWorkingTree(repo, stateDir);
  let baseline;
  if (options.base !== void 0) {
    const resolved = await resolveTree(repo.root, options.base);
    if (resolved === null) return cannotRun(`unknown revision ${options.base}.`);
    baseline = resolved;
  } else if (state.lastTree !== void 0) {
    if (!await objectExists(repo.root, state.lastTree)) {
      return cannotRun(
        "the saved baseline is gone (git cleaned it up). Run stop-rules baseline --reset to start again from HEAD."
      );
    }
    baseline = state.lastTree;
  } else if (await hasHead(repo.root)) {
    const head = await resolveTree(repo.root, "HEAD");
    if (head === null) return cannotRun("git could not resolve HEAD to a tree in this repository.");
    baseline = head;
  } else {
    baseline = await emptyTree(repo.root);
  }
  const rulesRelative = path17.relative(repo.root, rulesPath).split(path17.sep).join("/");
  const parsed = parseDiff(await diffTrees(repo.root, baseline, snapshot), [rulesRelative]);
  const files = parsed.files;
  const chunks = files.flatMap(chunkFile);
  const parseFailures = parsed.failures.map((failure2) => ({
    file: failure2.file,
    reason: failure2.reason
  }));
  const alreadyReported = state.reported;
  const engineResult = await runEngine({
    chunks,
    rules,
    threshold: options.threshold,
    maxCalls: options.maxCalls,
    model,
    endpoint: credentials.endpoint,
    apiKey: credentials.bearer,
    fetchImpl: options.fetchImpl ?? ((url, init2) => fetch(url, init2)),
    cache: fileCache(cache),
    note,
    ...options.mode === "hook" ? {
      skipFinding: (ruleId2, chunkText2) => alreadyReported[reportedKey(ruleId2, chunkText2)] !== void 0
    } : {},
    ...options.sleep ? { sleep: options.sleep } : {}
  });
  if (engineResult.blocked !== null) {
    await saveCache(stateDir, cache);
    if (engineResult.blocked === "billing") return cannotRun(BILLING_EXHAUSTED);
    return cannotRun(credentials.mode === "team" ? TOKEN_REJECTED : `${AUTH_REJECTED}.`);
  }
  if (chunks.length > 0 && engineResult.answered === 0 && engineResult.transportFailed) {
    await saveCache(stateDir, cache);
    return cannotRun("could not reach Jev for any chunk of this diff.");
  }
  const notChecked = [...parseFailures, ...engineResult.notChecked];
  const stats = {
    files: files.length,
    chunks: chunks.length,
    skipped: parsed.skipped.length,
    calls: engineResult.calls,
    cacheHits: engineResult.cacheHits,
    violations: engineResult.violations.length,
    notChecked: notChecked.length,
    inputTokens: engineResult.usage.inputTokens,
    outputTokens: engineResult.usage.outputTokens,
    durationMs: Date.now() - started
  };
  const report = {
    violations: engineResult.violations,
    notChecked,
    skipped: parsed.skipped,
    stats
  };
  const outcome = decide(options, report, state, engineResult.findings, snapshot, engineResult.holdBaseline);
  if (options.mode === "hook") await saveState(stateDir, state);
  await saveCache(stateDir, cache);
  await appendRunLog(stateDir, {
    at: (/* @__PURE__ */ new Date()).toISOString(),
    mode: options.mode + (options.stopHookActive === true ? " (stop_hook_active)" : ""),
    files: stats.files,
    chunks: stats.chunks,
    skipped: stats.skipped,
    calls: stats.calls,
    cacheHits: stats.cacheHits,
    violations: stats.violations,
    notChecked: stats.notChecked,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    durationMs: stats.durationMs,
    exitCode: outcome.kind === "violations" ? 2 : outcome.kind === "clean" ? 0 : 1,
    notes
  });
  return outcome;
}
function decide(options, report, state, findings, snapshot, holdBaseline) {
  const text = renderReport(report);
  const hasViolations2 = report.violations.length > 0;
  if (options.mode !== "hook") {
    return hasViolations2 ? { kind: "violations", report, text } : { kind: "clean", report, text };
  }
  const sessionId = options.sessionId;
  if (sessionId === void 0) {
    throw new Error("internal error: hook mode ran without a session id");
  }
  const session = state.sessions[sessionId] ?? { violationRuns: 0, at: Date.now() };
  let handoff = false;
  if (hasViolations2) {
    const rounds = Math.max(session.violationRuns, options.loopCount ?? 0);
    if (rounds >= LOOP_GUARD_ROUNDS) handoff = true;
    else session.violationRuns = rounds + 1;
  } else {
    session.violationRuns = 0;
  }
  session.at = Date.now();
  state.sessions[sessionId] = session;
  const ids = Object.keys(state.sessions);
  if (ids.length > MAX_SESSIONS_KEPT) {
    ids.sort((a, b) => (state.sessions[a]?.at ?? 0) - (state.sessions[b]?.at ?? 0)).slice(0, ids.length - MAX_SESSIONS_KEPT).forEach((id) => {
      delete state.sessions[id];
    });
  }
  if (handoff) {
    const headline = `stop-rules: still ${report.violations.length} violations after ${LOOP_GUARD_ROUNDS} rounds, leaving them for the user`;
    return { kind: "handoff", report, text: `${headline}

${text}` };
  }
  for (const finding of findings) {
    state.reported[reportedKey(finding.ruleId, finding.chunkText)] = Date.now();
  }
  if (!holdBaseline) state.lastTree = snapshot;
  return hasViolations2 ? { kind: "violations", report, text } : { kind: "clean", report, text };
}

// src/init.ts
import { promises as fs11 } from "node:fs";
import * as path18 from "node:path";

// src/version.ts
var VERSION = "0.1.0";
function isBundled() {
  return true;
}

// src/init.ts
var BUNDLE_PATH = ".stop-rules/stop-rules.mjs";
var BUNDLE_NAME = "stop-rules.mjs";
function failure(repo, reason) {
  return {
    ok: false,
    repo,
    mode: "local",
    bundle: { path: BUNDLE_PATH, written: false },
    rules: { path: ".stop-rules.md", created: false },
    team: null,
    agents: [],
    todo: [],
    errors: [reason]
  };
}
function bundleSource(selfPath) {
  if (isBundled()) return selfPath;
  return path18.join(path18.dirname(selfPath), BUNDLE_NAME);
}
async function init(options) {
  const repo = await findRepo(options.dir);
  if (repo === null) {
    return failure(options.dir, `${options.dir} is not inside a git repository.`);
  }
  const root = repo.root;
  let chosen;
  if (options.agents !== void 0) {
    const unknown = options.agents.filter((name) => getAdapter(name) === null);
    if (unknown.length > 0) {
      return failure(
        root,
        `unknown agent ${unknown.join(", ")}. Known agents: ${agentNames().join(", ")}`
      );
    }
    const wanted = new Set(options.agents);
    chosen = ADAPTERS.filter((adapter) => wanted.has(adapter.name));
  } else {
    chosen = ADAPTERS.filter((adapter) => adapter.detect(root));
    if (chosen.length === 0) {
      return failure(
        root,
        `no coding agent detected in ${root}. Name one with --agents: ${agentNames().join(", ")}`
      );
    }
  }
  const report = {
    ok: true,
    repo: root,
    mode: "local",
    bundle: { path: BUNDLE_PATH, written: false },
    rules: { path: ".stop-rules.md", created: false },
    team: null,
    agents: [],
    todo: [],
    errors: []
  };
  if (options.team !== void 0) {
    const written = await writeTeamConfig(root, options.team);
    if (!written.ok) {
      return failure(root, written.lines.join(" ").replace(/^stop-rules: /, ""));
    }
    report.mode = "team";
    report.team = { endpoint: options.team.trim(), path: TEAM_CONFIG_FILE, written: true };
  } else {
    const existing = await readTeamEndpoint(root, options.env);
    if (!existing.ok) return failure(root, existing.reason);
    if (existing.endpoint !== null) {
      report.mode = "team";
      report.team = { endpoint: existing.endpoint, path: existing.source, written: false };
    }
  }
  const source = bundleSource(options.selfPath);
  const target = path18.join(root, BUNDLE_PATH);
  if (path18.resolve(source) !== path18.resolve(target)) {
    try {
      await fs11.mkdir(path18.dirname(target), { recursive: true });
      await fs11.copyFile(source, target);
      report.bundle.written = true;
    } catch (error) {
      const err = error;
      return failure(
        root,
        err.code === "ENOENT" ? `no bundle at ${source}. Run "npm run build" in the stop-rules clone first.` : `could not copy the bundle to ${target}: ${err.message}`
      );
    }
  }
  const rulesPath = path18.join(root, ".stop-rules.md");
  try {
    await fs11.writeFile(rulesPath, STARTER_RULES, { encoding: "utf8", flag: "wx" });
    report.rules.created = true;
  } catch (error) {
    const err = error;
    if (err.code !== "EEXIST") {
      return failure(root, `could not write ${rulesPath}: ${err.message}`);
    }
  }
  for (const adapter of chosen) {
    const command = adapter.command(BUNDLE_PATH);
    let result;
    try {
      result = adapter.install(root, command);
    } catch (error) {
      result = {
        ok: false,
        files: [],
        changed: false,
        notes: [`could not install ${adapter.name}: ${error instanceof Error ? error.message : String(error)}`]
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
      notes: result.notes
    });
  }
  report.todo.push(
    report.mode === "team" ? 'Store the team token: printf %s "$TOKEN" | stop-rules login --token-stdin' : 'Give it your own Jev key from TypeSafe: set TYPESAFE_API_KEY, or run printf %s "$KEY" | stop-rules login --jev-key-stdin'
  );
  report.todo.push(`Edit ${report.rules.path} so it says what your team actually cares about.`);
  report.todo.push(
    report.mode === "team" ? `Commit ${BUNDLE_PATH}, ${TEAM_CONFIG_FILE} and the config files, so teammates and cloud agents get the check too.` : `Commit ${BUNDLE_PATH} and the config files, so teammates and cloud agents get the check too.`
  );
  report.todo.push("Check it works: stop-rules login --check");
  return report;
}
function renderInit(report) {
  const lines = [];
  if (report.errors.length > 0) {
    for (const error of report.errors) lines.push(`stop-rules: ${error}`);
    return lines;
  }
  lines.push(`stop-rules in ${report.repo}`);
  lines.push(
    report.bundle.written ? `  wrote ${report.bundle.path}` : `  kept ${report.bundle.path} (it is the file running now)`
  );
  lines.push(
    report.rules.created ? `  wrote ${report.rules.path} with ${parseRules(STARTER_RULES).length} starter rules` : `  kept the rules file already at ${report.rules.path}`
  );
  if (report.team !== null) {
    lines.push(
      report.team.written ? `  wrote ${report.team.path} pointing at ${report.team.endpoint}` : `  team server already set to ${report.team.endpoint} (from ${report.team.path})`
    );
  }
  lines.push(
    report.mode === "team" ? "  mode: team (the Jev key stays on your team's server)" : "  mode: local (this machine needs your own Jev key)"
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

// src/server/node.ts
import { createServer } from "node:http";

// src/server/handler.ts
var SERVER_VERSION = "0.1.0";
var DEFAULT_UPSTREAM = "https://api.typesafe.ai/v1/systemone";
var DEFAULT_MODEL2 = "jev-latest";
var MAX_BODY_BYTES = 1e6;
var UPSTREAM_TIMEOUT_MS = 3e4;
var REQUIRED_ENV = ["TYPESAFE_API_KEY", "STOP_RULES_TOKEN"];
function value(env, name) {
  const raw = env[name];
  return typeof raw === "string" ? raw.trim() : "";
}
function missingEnv(env) {
  return REQUIRED_ENV.filter((name) => value(env, name).length === 0);
}
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
function redact(env, text) {
  let out2 = text;
  for (const name of REQUIRED_ENV) {
    const secret = value(env, name);
    if (secret.length > 0) out2 = out2.split(secret).join("[redacted]");
  }
  return out2;
}
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
function isObject(candidate) {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}
async function digest(text) {
  const bytes = new TextEncoder().encode(text);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}
async function secretsMatch(offered, expected) {
  const [left, right] = await Promise.all([digest(offered), digest(expected)]);
  let diff = left.length ^ right.length;
  for (let i = 0; i < left.length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}
function bearer(request) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? "";
}
function rejectPayload(body) {
  if (!isObject(body)) return "the body must be a JSON object";
  if (!isObject(body["state"])) return "state must be a JSON object";
  const questions = body["questions"];
  if (!isObject(questions)) return "questions must be a JSON object";
  const ids = Object.keys(questions);
  if (ids.length === 0) return "questions must hold at least one question";
  for (const id of ids) {
    const question = questions[id];
    if (!isObject(question)) return `question ${id} must be a JSON object`;
    if (question["type"] !== "noul") return `question ${id} must have type noul`;
  }
  return null;
}
function health(env) {
  const missing = missingEnv(env);
  return json(200, {
    ok: true,
    service: "stop-rules",
    version: SERVER_VERSION,
    configured: missing.length === 0,
    missing
  });
}
async function forward(env, payload) {
  const upstream = value(env, "STOP_RULES_JEV_UPSTREAM") || DEFAULT_UPSTREAM;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(upstream, {
      method: "POST",
      headers: {
        authorization: `Bearer ${value(env, "TYPESAFE_API_KEY")}`,
        "content-type": "application/json"
      },
      body: payload,
      signal: controller.signal
    });
    const text = await response.text();
    const headers = {
      "content-type": response.headers.get("content-type") ?? "application/json"
    };
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter !== null) headers["retry-after"] = retryAfter;
    const empty = response.status === 204 || response.status === 304;
    return new Response(empty ? null : text, { status: response.status, headers });
  } catch (error) {
    return json(502, {
      error: "upstream_unreachable",
      message: redact(env, `could not reach ${upstream}: ${describe(error)}`)
    });
  } finally {
    clearTimeout(timer);
  }
}
async function systemone(request, env) {
  const missing = missingEnv(env);
  if (missing.length > 0) {
    return json(503, {
      error: "not_configured",
      message: "this stop-rules server is missing environment variables",
      missing
    });
  }
  if (!await secretsMatch(bearer(request), value(env, "STOP_RULES_TOKEN"))) {
    return json(401, {
      error: "unauthorized",
      message: "send Authorization: Bearer with your team token. Run stop-rules login."
    });
  }
  const tooLarge = json(413, {
    error: "payload_too_large",
    message: `the body must be at most ${MAX_BODY_BYTES} bytes`
  });
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge;
  let raw;
  try {
    raw = await request.arrayBuffer();
  } catch (error) {
    return json(400, { error: "unreadable_body", message: redact(env, describe(error)) });
  }
  if (raw.byteLength > MAX_BODY_BYTES) return tooLarge;
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch (error) {
    return json(400, { error: "invalid_json", message: redact(env, describe(error)) });
  }
  const reason = rejectPayload(body);
  if (reason !== null) return json(400, { error: "invalid_request", message: reason });
  const asked = body;
  return forward(
    env,
    JSON.stringify({
      state: asked.state,
      model: value(env, "STOP_RULES_JEV_MODEL") || DEFAULT_MODEL2,
      questions: asked.questions
    })
  );
}
async function route(request, env) {
  const path19 = new URL(request.url).pathname.replace(/\/+$/, "");
  if (request.method === "GET" && (path19 === "" || path19.endsWith("/health"))) return health(env);
  if (request.method === "POST" && path19.endsWith("/v1/systemone")) return systemone(request, env);
  return json(404, {
    error: "not_found",
    message: "stop-rules serves GET /health and POST /v1/systemone"
  });
}
async function handle(request, env) {
  try {
    return await route(request, env);
  } catch (error) {
    return json(500, { error: "server_error", message: redact(env, describe(error)) });
  }
}

// src/server/node.ts
var DEFAULT_PORT = 8080;
var HOST = "0.0.0.0";
var HOP_BY_HOP = /* @__PURE__ */ new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
function requestFrom(req, body) {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(req.headers)) {
    if (raw === void 0 || HOP_BY_HOP.has(name)) continue;
    headers.set(name, Array.isArray(raw) ? raw.join(", ") : raw);
  }
  const method = req.method;
  if (method === void 0) throw new Error("this request had no method");
  if (req.url === void 0) throw new Error("this request had no URL");
  const authority = req.headers.host === void 0 ? `localhost:${DEFAULT_PORT}` : req.headers.host;
  const url = new URL(req.url, `http://${authority}`);
  const init2 = { method, headers };
  if (method !== "GET" && method !== "HEAD") init2.body = body;
  return new Request(url, init2);
}
async function writeResponse(res, response) {
  const headers = {};
  response.headers.forEach((headerValue, name) => {
    headers[name] = headerValue;
  });
  const body = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, headers);
  res.end(body);
}
function fail(res, error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`stop-rules serve: ${message}
`);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "server_error", message: "see the server log" }));
}
function createStopRulesServer(env = process.env) {
  return createServer((req, res) => {
    const chunks = [];
    req.on("error", (error) => {
      fail(res, error);
    });
    req.on("data", (chunk) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      let request;
      try {
        request = requestFrom(req, Buffer.concat(chunks));
      } catch (error) {
        fail(res, error);
        return;
      }
      handle(request, env).then((response) => writeResponse(res, response)).catch((error) => {
        fail(res, error);
      });
    });
  });
}
function resolvePort(env, override) {
  if (override !== void 0) return override;
  const set = env["PORT"];
  if (set === void 0) return DEFAULT_PORT;
  const raw = set.trim();
  if (raw.length === 0) throw new Error("PORT is set but empty. Unset it or give it a port number.");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT is not a port number: ${raw}`);
  }
  return port;
}
function startServer(port, env = process.env) {
  const server = createStopRulesServer(env);
  return new Promise((resolve3, reject) => {
    let listening = false;
    server.on("error", (error) => {
      if (!listening) {
        reject(error);
        return;
      }
      process.stderr.write(`stop-rules serve: ${error.message}
`);
    });
    server.listen(port, HOST, () => {
      listening = true;
      resolve3(server);
    });
  });
}
function startupLines(port, env) {
  const lines = [`stop-rules ${SERVER_VERSION} listening on http://${HOST}:${port}`];
  const missing = missingEnv(env);
  if (missing.length > 0) {
    lines.push(`not configured yet: set ${missing.join(" and ")} and restart`);
  }
  return lines;
}
async function serveMain(port) {
  const resolved = resolvePort(process.env, port);
  const server = await startServer(resolved);
  process.stdout.write(`${startupLines(resolved, process.env).join("\n")}
`);
  const stop = () => {
    server.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return 0;
}

// src/cli.ts
var USAGE = `stop-rules: check the code your agent just wrote against your team's rules.

Usage:
  stop-rules hook [options]            run as a stop hook, reading the agent's JSON on stdin
  stop-rules check [options]           run the same check in a terminal, pre-commit or CI
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
  --dir <path>         init mode only: the repository to install into (default: this one)
  --team <endpoint>    init mode only: use your team's stop-rules server, not your own key
  --rules <path>       rules file (default <repo root>/.stop-rules.md)
  --threshold <0..1>   score at or above which a rule counts as violated (default 0.5)
  --max-calls <n>      hard ceiling on requests to Jev in one run (default 60)
  --base <rev>         check mode only: diff this revision against the working tree
  --json               print the findings, or the init result, as JSON
  --port <n>           serve mode only: port to listen on (default PORT or 8080)
  --reset              baseline mode only: clear the saved baseline
  --                   stop reading options: anything after it is ignored
  --help               print this text
  --version            print the version

Agents: ${agentNames().join(", ")}

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
var UsageError = class extends Error {
};
function parseArgs(argv) {
  const parsed = {
    command: "",
    threshold: 0.5,
    maxCalls: 60,
    json: false,
    agent: DEFAULT_AGENT,
    tokenStdin: false,
    jevKeyStdin: false,
    check: false,
    reset: false,
    help: false,
    version: false
  };
  const take = (index, flag) => {
    const value2 = argv[index];
    if (value2 === void 0) throw new UsageError(`${flag} needs a value`);
    return value2;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    switch (arg) {
      case "--":
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
        const value2 = Number(take(i, "--port"));
        if (!Number.isInteger(value2) || value2 < 0 || value2 > 65535) {
          throw new UsageError("--port must be a port number");
        }
        parsed.port = value2;
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
      case "--agents": {
        i += 1;
        const names = take(i, "--agents").split(",").map((name) => name.trim()).filter((name) => name.length > 0);
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
        const value2 = Number(take(i, "--threshold"));
        if (!Number.isFinite(value2) || value2 < 0 || value2 > 1) {
          throw new UsageError("--threshold must be a number between 0 and 1");
        }
        parsed.threshold = value2;
        break;
      }
      case "--max-calls": {
        i += 1;
        const value2 = Number(take(i, "--max-calls"));
        if (!Number.isInteger(value2) || value2 < 1) {
          throw new UsageError("--max-calls must be a whole number of 1 or more");
        }
        parsed.maxCalls = value2;
        break;
      }
      default:
        if (arg.startsWith("-")) throw new UsageError(`unknown flag ${arg}`);
        if (parsed.command.length === 0) parsed.command = arg;
        else if (parsed.operand === void 0) parsed.operand = arg;
        else throw new UsageError(`unexpected argument ${arg}`);
    }
  }
  return parsed;
}
async function readStdin() {
  if (process.stdin.isTTY === true) return "";
  const parts = [];
  for await (const part of process.stdin) parts.push(part);
  return Buffer.concat(parts).toString("utf8");
}
function runningFile() {
  if (!import.meta.url.startsWith("file:")) {
    throw new Error(
      `stop-rules is running from ${import.meta.url}, which is not a file on disk, so init has nothing to copy`
    );
  }
  return fileURLToPath(import.meta.url);
}
function emit(delivery) {
  if (delivery.stdout.length > 0) process.stdout.write(delivery.stdout);
  if (delivery.stderr.length > 0) process.stderr.write(delivery.stderr);
  return delivery.exitCode;
}
function deliverOutcome(adapter, outcome) {
  switch (outcome.kind) {
    case "cannot-run":
      return adapter.deliverError(`stop-rules: ${outcome.reason}`);
    case "handoff":
      return adapter.deliverError(outcome.text);
    case "clean":
    case "violations":
      return adapter.deliver(outcome.report, outcome.text);
  }
}
async function runHook(args) {
  const adapter = getAdapter(args.agent);
  if (adapter === null) {
    process.stderr.write(
      `stop-rules: unknown agent ${args.agent}. Known agents: ${agentNames().join(", ")}
`
    );
    return 1;
  }
  let input;
  try {
    const payload = adapter.stdin === "none" ? "" : await readStdin();
    input = adapter.parseInput(payload);
  } catch (error) {
    process.stderr.write(`stop-rules: ${error instanceof Error ? error.message : String(error)}
`);
    return 1;
  }
  const outcome = await run({
    // An adapter leaves cwd undefined only when its agent documents no directory field at
    // all, and those agents run the hook in the project root. See HookContext.
    cwd: input.cwd === void 0 ? process.cwd() : input.cwd,
    mode: "hook",
    threshold: args.threshold,
    maxCalls: args.maxCalls,
    sessionId: input.sessionId,
    stopHookActive: input.stopHookActive === true,
    ...input.loopCount !== void 0 ? { loopCount: input.loopCount } : {},
    ...args.rules !== void 0 ? { rulesPath: args.rules } : {}
  });
  return emit(deliverOutcome(adapter, outcome));
}
async function runCheckCommand(args) {
  const outcome = await run({
    cwd: process.cwd(),
    mode: "check",
    threshold: args.threshold,
    maxCalls: args.maxCalls,
    ...args.rules !== void 0 ? { rulesPath: args.rules } : {},
    ...args.base !== void 0 ? { base: args.base } : {}
  });
  if (outcome.kind === "cannot-run") {
    process.stderr.write(`stop-rules: ${outcome.reason}
`);
    return 1;
  }
  if (args.json) process.stdout.write(`${JSON.stringify(outcome.report, null, 2)}
`);
  else process.stdout.write(`${outcome.text}
`);
  return outcome.kind === "violations" ? 2 : 0;
}
async function runInitCommand(args) {
  const report = await init({
    dir: args.dir ?? process.cwd(),
    selfPath: runningFile(),
    env: process.env,
    ...args.agents !== void 0 ? { agents: args.agents } : {},
    ...args.team !== void 0 ? { team: args.team } : {}
  });
  if (args.json) {
    const stream2 = report.ok ? process.stdout : process.stderr;
    stream2.write(`${JSON.stringify(report, null, 2)}
`);
    return report.ok ? 0 : 1;
  }
  const lines = renderInit(report);
  const stream = report.ok ? process.stdout : process.stderr;
  stream.write(`${lines.join("\n")}
`);
  return report.ok ? 0 : 1;
}
function writeResult(result) {
  const stream = result.ok ? process.stdout : process.stderr;
  stream.write(`${result.lines.join("\n")}
`);
  return result.ok ? 0 : 1;
}
async function runBaselineCommand(args) {
  if (!args.reset) {
    process.stderr.write("stop-rules: baseline only takes --reset, as in stop-rules baseline --reset\n");
    return 1;
  }
  return writeResult(await resetBaseline(process.cwd()));
}
async function runTeamCommand(args) {
  if (args.operand === void 0) {
    process.stderr.write("stop-rules: team needs an endpoint, as in stop-rules team https://example.com\n");
    return 1;
  }
  const repo = await findRepo(process.cwd());
  if (repo === null) {
    process.stderr.write(`stop-rules: ${process.cwd()} is not inside a git repository.
`);
    return 1;
  }
  return writeResult(await writeTeamConfig(repo.root, args.operand));
}
async function runLoginCommand(args) {
  if (args.check) {
    const repo = await findRepo(process.cwd());
    const root = repo === null ? process.cwd() : repo.root;
    return writeResult(await loginCheck(root, process.env));
  }
  if (args.tokenStdin === args.jevKeyStdin) {
    process.stderr.write(
      [
        "stop-rules: login needs one of --token-stdin, --jev-key-stdin or --check.",
        '  printf %s "$TOKEN" | stop-rules login --token-stdin',
        '  printf %s "$JEV_KEY" | stop-rules login --jev-key-stdin',
        "  stop-rules login --check"
      ].join("\n") + "\n"
    );
    return 1;
  }
  const secret = await readStdin();
  return writeResult(await login(process.env, args.tokenStdin ? "token" : "jev-key", secret));
}
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`stop-rules: ${error instanceof Error ? error.message : String(error)}
`);
    process.stderr.write(USAGE);
    return 1;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}
`);
    return 0;
  }
  if (args.help || args.command.length === 0) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 1;
  }
  if (args.operand !== void 0 && args.command !== "team") {
    process.stderr.write(`stop-rules: unexpected argument ${args.operand}
`);
    return 1;
  }
  switch (args.command) {
    case "hook":
      return runHook(args);
    case "check":
      return runCheckCommand(args);
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
        process.stderr.write(
          `stop-rules: ${error instanceof Error ? error.message : String(error)}
`
        );
        return 1;
      }
    case "baseline":
      return runBaselineCommand(args);
    default:
      process.stderr.write(`stop-rules: unknown command ${args.command}
`);
      process.stderr.write(USAGE);
      return 1;
  }
}
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(
      `stop-rules: ${error instanceof Error ? error.stack ?? error.message : String(error)}
`
    );
    process.exitCode = 1;
  }
);
