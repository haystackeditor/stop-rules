#!/usr/bin/env node

// src/cli.ts
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/adapters/aider.ts
import * as fs3 from "node:fs";
import * as path2 from "node:path";

// src/adapters/shared.ts
import * as fs2 from "node:fs";
import * as path from "node:path";
function isRecord(value2) {
  return typeof value2 === "object" && value2 !== null && !Array.isArray(value2);
}
function hasViolations(result) {
  return result.pieces.length > 0;
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
function out2(exitCode, stdout = "", stderr = "") {
  return { stdout, stderr, exitCode };
}
function exitTwoOnStderr(result, report) {
  return hasViolations(result) ? out2(2, "", `${report}
`) : out2(0);
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
    raw = fs2.readFileSync(file, "utf8");
  } catch (error) {
    const err2 = error;
    if (err2.code === "ENOENT") return { ok: true, value: {}, existed: false };
    return { ok: false, reason: `could not read ${shown}: ${err2.message}` };
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
  fs2.mkdirSync(path.dirname(file), { recursive: true });
  fs2.writeFileSync(file, `${JSON.stringify(value2, null, 2)}
`, "utf8");
}
function writeExecutable(file, contents) {
  fs2.mkdirSync(path.dirname(file), { recursive: true });
  fs2.writeFileSync(file, contents, { encoding: "utf8", mode: 493 });
  fs2.chmodSync(file, 493);
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
  return names.some((name2) => fs2.existsSync(path.join(repoRoot, name2)));
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
    if (!hasViolations(result)) return out2(0);
    return out2(2, `${report}
`);
  },
  deliverError(message) {
    return out2(0, "", `${message}
`);
  },
  install(repoRoot, command) {
    const file = path2.join(repoRoot, CONFIG);
    const shown = relative2(repoRoot, file);
    const line = `- ${JSON.stringify(command)}`;
    let existing = "";
    try {
      existing = fs3.readFileSync(file, "utf8");
    } catch (error) {
      const err2 = error;
      if (err2.code !== "ENOENT") {
        return {
          ok: false,
          files: [shown],
          changed: false,
          notes: [`could not read ${shown}: ${err2.message}`]
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
    const body2 = existing.length === 0 ? addition.replace(/^\n/, "") : `${existing.replace(/\n*$/, "\n")}${addition}`;
    fs3.writeFileSync(file, body2, "utf8");
    const notes = [
      existing.length === 0 ? `created ${shown} with a lint-cmd` : `added a lint-cmd to ${shown}`
    ];
    if (hasAutoLint) notes.push(`${shown} already sets auto-lint: check that it is true.`);
    return { ok: true, files: [shown], changed: true, notes };
  }
};

// src/adapters/amp.ts
import * as fs4 from "node:fs";
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
    if (!hasViolations(result)) return out2(0);
    return out2(2, `${report}
`, `${report}
`);
  },
  deliverError(message) {
    return out2(1, "", `${message}
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
      existing = fs4.readFileSync(file, "utf8");
    } catch (error) {
      const err2 = error;
      if (err2.code !== "ENOENT") {
        return {
          ok: false,
          files: [shown],
          changed: false,
          notes: [`could not read ${shown}: ${err2.message}`]
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
    fs4.mkdirSync(path3.dirname(file), { recursive: true });
    fs4.writeFileSync(file, wanted, "utf8");
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
    return out2(1, "", `${message}
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
import * as fs5 from "node:fs";
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
    if (!hasViolations(result)) return out2(0, jsonLine({ cancel: false }));
    return out2(0, jsonLine({ cancel: false, contextModification: report }));
  },
  deliverError(message) {
    return out2(0, jsonLine({ cancel: false }), `${message}
`);
  },
  install(repoRoot, _command) {
    const bundle = ".stop-rules/stop-rules.mjs";
    const file = path5.join(repoRoot, ".clinerules", "hooks", "TaskComplete");
    const shown = relative2(repoRoot, file);
    const wanted = clineHookScript(bundle);
    let existing = null;
    try {
      existing = fs5.readFileSync(file, "utf8");
    } catch (error) {
      const err2 = error;
      if (err2.code !== "ENOENT") {
        return { ok: false, files: [shown], changed: false, notes: [`could not read ${shown}: ${err2.message}`] };
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
    return out2(1, "", `${message}
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
    if (!hasViolations(result)) return out2(0);
    return out2(0, jsonLine({ decision: "block", reason: report }));
  },
  deliverError(message) {
    return out2(1, "", `${message}
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
    if (!hasViolations(result)) return out2(0, jsonLine({}));
    return out2(0, jsonLine({ followup_message: report }));
  },
  deliverError(message) {
    return out2(1, "", `${message}
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
    const stop2 = arrayAt(hooks, "stop");
    if (stop2 === null) return failed(shown, wrongShape(shown, "stop", "a list"));
    if (stop2.some(mentionsStopRules)) {
      return {
        ok: true,
        files: [shown],
        changed: false,
        notes: [`left ${shown} alone: it already has a stop-rules stop hook`]
      };
    }
    stop2.push({ command });
    hooks["stop"] = stop2;
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
    return out2(1, "", `${message}
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
    if (!hasViolations(result)) return out2(0, jsonLine({}));
    return out2(2, "", `${report}
`);
  },
  deliverError(message) {
    return out2(1, "", `${message}
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
    if (!hasViolations(result)) return out2(0);
    return out2(0, jsonLine({ decision: "block", reason: report }));
  },
  deliverError(message) {
    return out2(1, "", `${message}
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
import * as fs6 from "node:fs";
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
      existing = fs6.readFileSync(file, "utf8");
    } catch (error) {
      const err2 = error;
      if (err2.code !== "ENOENT") {
        return {
          ok: false,
          files: [shown],
          changed: false,
          notes: [`could not read ${shown}: ${err2.message}`]
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
    fs6.mkdirSync(path12.dirname(file), { recursive: true });
    fs6.writeFileSync(file, wanted, "utf8");
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
    return out2(1, "", `${message}
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
function getAdapter(name2) {
  return ADAPTERS.find((adapter) => adapter.name === name2) ?? null;
}

// src/check.ts
import { promises as fs15 } from "node:fs";
import * as path20 from "node:path";

// src/credentials.ts
import { promises as fs9 } from "node:fs";
import { homedir } from "node:os";
import * as path15 from "node:path";

// src/jev.ts
var DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
var DEFAULT_MODEL = "jev-latest";
var AUTH_REJECTED = "Jev rejected the API key";
var BILLING_EXHAUSTED = "the Jev account is out of credits. Add credits at TypeSafe, then run again.";
function holdsBaseline(failure2) {
  return failure2 === "network" || failure2 === "server" || failure2 === "rate_limit" || failure2 === "auth" || failure2 === "billing" || failure2 === "budget" || failure2 === "busy";
}
var MAX_ATTEMPTS = 3;
var BACKOFF_START_MS = 1e3;
var BACKOFF_CAP_MS = 16e3;
var STEP_UP_AFTER = 4;
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
function readAnswers(body2) {
  if (typeof body2 !== "object" || body2 === null) return null;
  const answers = body2.answers;
  if (typeof answers !== "object" || answers === null) return null;
  const out3 = {};
  for (const [id, value2] of Object.entries(answers)) {
    if (typeof value2 !== "object" || value2 === null) continue;
    const noul = value2.noul;
    if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) continue;
    out3[id] = noul;
  }
  return out3;
}
function readUsage(body2) {
  if (typeof body2 !== "object" || body2 === null) return { inputTokens: 0, outputTokens: 0 };
  const usage = body2.usage;
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
    this.ceiling = options.concurrency ?? 4;
    this.limit = this.ceiling;
    this.sleep = options.sleep ?? defaultSleep;
  }
  callsUsed = 0;
  /** The in-flight ceiling for this run. Halved on a 429, one step back up after four wins. */
  limit;
  ceiling;
  successStreak = 0;
  sleep;
  usage = { inputTokens: 0, outputTokens: 0 };
  get calls() {
    return this.callsUsed;
  }
  /** The current in-flight ceiling, for the run log. */
  get inFlightLimit() {
    return this.limit;
  }
  /** A 429 means slow down: halve the ceiling, never below one. */
  slowDown() {
    this.limit = Math.max(1, Math.floor(this.limit / 2));
    this.successStreak = 0;
  }
  /** Four answers in a row without a 429 buy back one slot. */
  speedUp() {
    if (this.limit >= this.ceiling) return;
    this.successStreak += 1;
    if (this.successStreak < STEP_UP_AFTER) return;
    this.limit += 1;
    this.successStreak = 0;
  }
  /** Removes the key from any text that is about to be shown or logged. */
  redact(text) {
    if (this.options.apiKey.length === 0) return text;
    return text.split(this.options.apiKey).join("[redacted]");
  }
  /**
   * One HTTP attempt, with a machine wide slot held for its whole length, so all the
   * stop-rules processes on this machine together stay inside Jev's per account limit.
   */
  async fetchOnce(body2) {
    let free = null;
    if (this.options.slot !== void 0) {
      const gate = await this.options.slot();
      if (!gate.ok) return { kind: "busy", reason: gate.reason };
      free = gate.release;
    }
    try {
      let response;
      try {
        response = await this.options.fetchImpl(this.options.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            "Content-Type": "application/json"
          },
          body: body2,
          signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 9e4)
        });
      } catch (error) {
        const message = this.redact(error instanceof Error ? error.message : String(error));
        return { kind: "error", message: `network error: ${message}` };
      }
      let text;
      try {
        text = await response.text();
      } catch (error) {
        const message = this.redact(error instanceof Error ? error.message : String(error));
        return { kind: "error", message: `unreadable response: ${message}` };
      }
      return {
        kind: "response",
        status: response.status,
        text,
        retryAfter: response.headers.get("retry-after")
      };
    } finally {
      if (free !== null) await free();
    }
  }
  /** One logical request, including retries. Every attempt costs one unit of budget. */
  async send(state, questions) {
    const body2 = JSON.stringify({ state, model: this.options.model, questions });
    let attempt = 0;
    let backoff = BACKOFF_START_MS;
    for (; ; ) {
      if (this.callsUsed >= this.options.maxCalls) {
        return { ok: false, failure: "budget", message: "call budget exhausted" };
      }
      attempt += 1;
      this.callsUsed += 1;
      const sent = await this.fetchOnce(body2);
      if (sent.kind === "busy") {
        this.callsUsed -= 1;
        return { ok: false, failure: "busy", message: sent.reason };
      }
      if (sent.kind === "error") {
        if (attempt < MAX_ATTEMPTS) {
          this.options.note(`${sent.message}, retrying`);
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
          continue;
        }
        this.options.note(`${sent.message}, giving up`);
        return { ok: false, failure: "network", message: sent.message };
      }
      const status = sent.status;
      const text = sent.text;
      if (status === 200) {
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
        this.speedUp();
        return { ok: true, answers, usage };
      }
      if (status === 402 || text.includes('"billing_error"')) {
        return { ok: false, failure: "billing", message: BILLING_EXHAUSTED };
      }
      if (status === 429) {
        this.slowDown();
        const wait = parseRetryAfter(sent.retryAfter) ?? backoff;
        if (attempt < MAX_ATTEMPTS) {
          const room = this.limit === 1 ? "1 call" : `${this.limit} calls`;
          this.options.note(`rate limited, waiting ${wait} ms, ${room} in flight from now on`);
          await this.sleep(wait);
          backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
          continue;
        }
        return { ok: false, failure: "rate_limit", message: "rate limited by Jev" };
      }
      if (status === 400 && text.includes("max_tokens_exceeded")) {
        return { ok: false, failure: "too_large", message: "max_tokens_exceeded" };
      }
      if (status === 401 || status === 403) {
        return { ok: false, failure: "auth", message: AUTH_REJECTED };
      }
      if (status >= 500) {
        if (attempt < MAX_ATTEMPTS) {
          this.options.note(`Jev returned ${status}, retrying`);
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
          continue;
        }
        return { ok: false, failure: "server", message: `Jev returned ${status}` };
      }
      const snippet = this.redact(text.slice(0, 200).replace(/\s+/g, " ").trim());
      return {
        ok: false,
        failure: "client",
        message: `Jev returned ${status}: ${snippet}`
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
    const stopsEverything = (failure2) => failure2 === "busy" || failure2 === "billing" || failure2 === "auth";
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
            if (!outcome.ok && stopsEverything(outcome.failure)) {
              while (queue.length > 0) {
                const waiting = queue.shift();
                if (waiting !== void 0) results.push({ node: waiting, outcome });
              }
            }
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
import { promises as fs7 } from "node:fs";
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
      const key = (await fs7.readFile(keyPath, "utf8")).trim();
      if (key.length === 0) {
        return { ok: false, reason: `${keyPath}, named by TYPESAFE_API_KEY_FILE, is empty` };
      }
      return { ok: true, key };
    } catch (error) {
      const err2 = error;
      return {
        ok: false,
        reason: `could not read ${keyPath}, named by TYPESAFE_API_KEY_FILE: ${err2.code ?? err2.message}`
      };
    }
  }
  return {
    ok: false,
    reason: "no Jev API key. Set TYPESAFE_API_KEY, or TYPESAFE_API_KEY_FILE to a file holding it."
  };
}

// src/settings.ts
import { promises as fs8 } from "node:fs";
import * as path14 from "node:path";
var SETTINGS_FILE = ".stop-rules.json";
var DEFAULT_CUT = "functions";
var KNOWN_KEYS = ["endpoint", "cut", "threshold", "maxCalls"];
function parseSettings(file, raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: `${file} does not hold a JSON object.` };
  }
  const record = raw;
  const settings = {};
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.includes(key)) {
      return {
        ok: false,
        reason: `${file} sets "${key}", which stop-rules does not know. The settings are ${KNOWN_KEYS.join(", ")}.`
      };
    }
  }
  const endpoint = record["endpoint"];
  if (endpoint !== void 0) {
    if (typeof endpoint !== "string") {
      return { ok: false, reason: `"endpoint" in ${file} must be a string.` };
    }
    if (endpoint.trim().length === 0) {
      return { ok: false, reason: `"endpoint" in ${file} is empty.` };
    }
    settings.endpoint = endpoint.trim();
  }
  const cut = record["cut"];
  if (cut !== void 0) {
    if (cut !== "functions" && cut !== "hunks" && cut !== "chunks") {
      return {
        ok: false,
        reason: `"cut" in ${file} must be "functions", "hunks" or "chunks", not ${JSON.stringify(cut)}.`
      };
    }
    settings.cut = cut;
  }
  const threshold = record["threshold"];
  if (threshold !== void 0) {
    if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
      return { ok: false, reason: `"threshold" in ${file} must be a number.` };
    }
    if (threshold < 0 || threshold > 1) {
      return { ok: false, reason: `"threshold" in ${file} must be between 0 and 1, not ${threshold}.` };
    }
    settings.threshold = threshold;
  }
  const maxCalls = record["maxCalls"];
  if (maxCalls !== void 0) {
    if (typeof maxCalls !== "number" || !Number.isInteger(maxCalls)) {
      return { ok: false, reason: `"maxCalls" in ${file} must be a whole number.` };
    }
    if (maxCalls < 1) {
      return { ok: false, reason: `"maxCalls" in ${file} must be 1 or more, not ${maxCalls}.` };
    }
    settings.maxCalls = maxCalls;
  }
  return { ok: true, loaded: { settings, file, exists: true } };
}
async function loadSettings(repoRoot) {
  const file = path14.join(repoRoot, SETTINGS_FILE);
  let text;
  try {
    text = await fs8.readFile(file, "utf8");
  } catch (error) {
    const err2 = error;
    if (err2.code === "ENOENT") {
      return { ok: true, loaded: { settings: {}, file, exists: false } };
    }
    return { ok: false, reason: `could not read ${file}: ${err2.code ?? err2.message}` };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      reason: `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`
    };
  }
  return parseSettings(file, raw);
}
async function writeSettings(repoRoot, patch) {
  const file = path14.join(repoRoot, SETTINGS_FILE);
  const load = await loadSettings(repoRoot);
  if (!load.ok) return { ok: false, wrote: [], file, existed: true, reason: load.reason };
  const merged = { ...load.loaded.settings, ...patch };
  await fs8.writeFile(file, `${JSON.stringify(merged, null, 2)}
`, "utf8");
  return { ok: true, wrote: Object.keys(patch), file, existed: load.loaded.exists };
}

// src/credentials.ts
var SYSTEMONE_PATH = "/v1/systemone";
var TOKEN_FILE = "token";
var JEV_KEY_FILE = "jev-key";
var TOKEN_REJECTED = "the team token is missing or wrong; run stop-rules login";
function envValue(env, name2) {
  const raw = env[name2];
  if (raw === void 0) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: `${name2} is set but empty. Unset it or give it a value.` };
  }
  return { ok: true, value: trimmed };
}
function configDir(env) {
  const xdg = envValue(env, "XDG_CONFIG_HOME");
  if (!xdg.ok) throw new Error(xdg.reason);
  const base = xdg.value === null ? path15.join(homedir(), ".config") : xdg.value;
  return path15.join(base, "stop-rules");
}
function tokenPath(env) {
  return path15.join(configDir(env), TOKEN_FILE);
}
function jevKeyPath(env) {
  return path15.join(configDir(env), JEV_KEY_FILE);
}
async function readTrimmed(file) {
  let text;
  try {
    text = (await fs9.readFile(file, "utf8")).trim();
  } catch (error) {
    const err2 = error;
    if (err2.code === "ENOENT") return { value: null };
    return { value: null, error: `could not read ${file}: ${err2.code ?? err2.message}` };
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
function readTeamEndpoint(loaded, env) {
  const fromEnv = envValue(env, "STOP_RULES_ENDPOINT");
  if (!fromEnv.ok) return { ok: false, reason: fromEnv.reason };
  if (fromEnv.value !== null) {
    return { ok: true, endpoint: fromEnv.value, source: "STOP_RULES_ENDPOINT" };
  }
  const endpoint = loaded.settings.endpoint;
  if (endpoint === void 0) return { ok: true, endpoint: null, source: "none" };
  return { ok: true, endpoint, source: loaded.file };
}
async function resolveCredentials(loaded, env) {
  const configHome = envValue(env, "XDG_CONFIG_HOME");
  if (!configHome.ok) return { ok: false, reason: configHome.reason };
  const model = envValue(env, "STOP_RULES_JEV_MODEL");
  if (!model.ok) return { ok: false, reason: model.reason };
  const chosenModel = model.value === null ? DEFAULT_MODEL : model.value;
  const team = readTeamEndpoint(loaded, env);
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
  const written = await writeSettings(repoRoot, { endpoint: parsed.base });
  if (!written.ok) {
    return {
      ok: false,
      lines: [
        `stop-rules: ${written.reason ?? `could not write ${written.file}`}`,
        "Nothing was changed."
      ]
    };
  }
  return {
    ok: true,
    lines: [
      written.existed ? `updated ${written.file}` : `wrote ${written.file}`,
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
  await fs9.mkdir(dir, { recursive: true, mode: 448 });
  await fs9.writeFile(file, `${value2}
`, { encoding: "utf8", mode: 384 });
  await fs9.chmod(file, 384);
  return {
    ok: true,
    lines: [
      `wrote ${file} with mode 0600`,
      target === "token" ? "That is the team token. The Jev key stays on your team's server." : "That is your own Jev key, used when this repo has no team endpoint.",
      "Check it with: stop-rules login --check"
    ]
  };
}
async function loginCheck(repoRoot, env, fetchImpl = (url, init3) => fetch(url, init3)) {
  const load = await loadSettings(repoRoot);
  if (!load.ok) return { ok: false, lines: [`stop-rules: ${load.reason}`] };
  const resolved = await resolveCredentials(load.loaded, env);
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
function gitOldStart(cursor, oldCount) {
  if (oldCount > 0) return cursor;
  return Math.max(cursor - 1, 0);
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
function shortenBodyLine(body2) {
  const marker = body2[0];
  if (marker === void 0) throw new Error("internal error: an empty diff body line");
  const text = body2.slice(1);
  if (text.length <= LONG_LINE_LIMIT) return body2;
  return `${marker}${longLineMarker(text.length)}`;
}
function addedLines(chunk) {
  const out3 = [];
  for (const hunk of chunk.hunks) {
    let lineNo = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        out3.push({ line: lineNo, text: line.slice(1) });
        lineNo += 1;
      } else if (line.startsWith(" ")) {
        lineNo += 1;
      }
    }
  }
  return out3;
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
  const body2 = raw.slice(1, -1);
  const bytes = [];
  let plain = "";
  const flush = () => {
    if (plain.length === 0) return;
    for (const byte of encoder.encode(plain)) bytes.push(byte);
    plain = "";
  };
  for (let i2 = 0; i2 < body2.length; i2 += 1) {
    const char = body2[i2];
    if (char === void 0) break;
    if (char !== "\\") {
      plain += char;
      continue;
    }
    i2 += 1;
    const escape = body2[i2];
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
      const digits = body2.slice(i2, i2 + 3);
      if (!/^[0-7]{3}$/.test(digits)) {
        return { ok: false, reason: `git quoted this path with an octal escape stop-rules cannot read: \\${digits}` };
      }
      flush();
      bytes.push(Number.parseInt(digits, 8));
      i2 += 2;
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
  let i2 = 0;
  while (i2 < lines.length) {
    const line = lines[i2] ?? "";
    if (!line.startsWith("diff --git ")) {
      i2 += 1;
      continue;
    }
    const header = [line];
    let binary2 = false;
    let newPath = null;
    let deleted = false;
    let unreadablePath = null;
    i2 += 1;
    while (i2 < lines.length) {
      const current = lines[i2] ?? "";
      if (current.startsWith("diff --git ") || current.startsWith("@@ ")) break;
      header.push(current);
      i2 += 1;
      if (current.startsWith("Binary files ") || current.startsWith("GIT binary patch")) {
        binary2 = true;
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
    while (i2 < lines.length) {
      const current = lines[i2] ?? "";
      if (current.startsWith("diff --git ")) break;
      const match = HUNK_RE.exec(current);
      if (!match) {
        i2 += 1;
        continue;
      }
      const hunk = {
        oldStart: Number(match[1]),
        newStart: Number(match[3]),
        context: match[5] ?? "",
        lines: []
      };
      i2 += 1;
      while (i2 < lines.length) {
        const body2 = lines[i2] ?? "";
        if (body2.startsWith("diff --git ") || HUNK_RE.test(body2)) break;
        if (body2.startsWith(" ") || body2.startsWith("+") || body2.startsWith("-") || body2.startsWith("\\")) {
          hunk.lines.push(shortenBodyLine(body2));
          i2 += 1;
          continue;
        }
        if (body2.length === 0) {
          if (i2 === lines.length - 1) {
            i2 += 1;
            break;
          }
          hunk.lines.push(" ");
          i2 += 1;
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
    if (binary2) {
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
  const out3 = [];
  let oldCursor = hunk.oldStart;
  let newCursor = hunk.newStart;
  for (let start3 = 0; start3 < hunk.lines.length; start3 += per) {
    const slice = hunk.lines.slice(start3, start3 + per);
    out3.push({ oldStart: oldCursor, newStart: newCursor, context: hunk.context, lines: slice });
    oldCursor += countOld(slice);
    newCursor += countNew(slice);
  }
  return out3;
}
function splitHunkToFit(hunk, headerBytes) {
  const budget = Math.max(CHUNK_MAX_BYTES - headerBytes, 1);
  if (utf8Bytes(hunkText(hunk)) <= budget) return [hunk];
  if (hunk.lines.length < 2) return [hunk];
  let pieces = 2;
  for (; ; ) {
    const parts2 = splitHunk(hunk, pieces);
    const tooBig = parts2.some((part) => utf8Bytes(hunkText(part)) > budget);
    if (!tooBig || pieces >= hunk.lines.length) return parts2;
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
function halvePiece(piece) {
  const halves = halveChunk(piece);
  if (halves === null) return null;
  return [asPiece(piece, halves[0]), asPiece(piece, halves[1])];
}
function asPiece(original, part) {
  const range = chunkRange(part);
  return {
    file: part.file,
    header: part.header,
    hunks: part.hunks,
    unitName: original.unitName,
    fromLine: range.from,
    toLine: range.to,
    cut: original.cut
  };
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
  const parts2 = splitHunk(only, 2);
  const first = parts2[0];
  const second = parts2[1];
  if (first === void 0 || second === void 0) return null;
  return [
    { file: chunk.file, header: chunk.header, hunks: [first] },
    { file: chunk.file, header: chunk.header, hunks: [second] }
  ];
}

// src/languages.ts
var MAX_ADDED_PER_PIECE = 40;
var EXTENSIONS = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".jsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift"
};
var GRAMMAR_TITLE = {
  typescript: "TypeScript",
  tsx: "TSX",
  javascript: "JavaScript",
  python: "Python",
  go: "Go",
  rust: "Rust",
  ruby: "Ruby",
  java: "Java",
  kotlin: "Kotlin",
  swift: "Swift"
};
function grammarWasmName(key) {
  return `${key}.wasm`;
}
function extensionOf(filePath) {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}
function grammarForPath(filePath) {
  return EXTENSIONS[extensionOf(filePath)] ?? null;
}
var TS_FN = [
  "function_declaration",
  "generator_function_declaration",
  "method_definition",
  "function_signature",
  "abstract_method_signature",
  "method_signature",
  "construct_signature"
];
var TS_MEMBER = [
  "public_field_definition",
  "property_signature",
  "index_signature",
  "enum_assignment"
];
var TS_LAMBDA = ["arrow_function", "function_expression", "generator_function"];
var TS_BODIES = ["class_body", "interface_body", "object_type", "enum_body"];
var TS_WRAPPERS = [
  "export_statement",
  "ambient_declaration",
  "lexical_declaration",
  "variable_declaration",
  "expression_statement"
];
var TS_TABLE = {
  fn: TS_FN,
  member: TS_MEMBER,
  memberOnlyInBody: false,
  lambda: TS_LAMBDA,
  bodies: TS_BODIES,
  bodiesParent: {},
  wrappers: TS_WRAPPERS,
  attachPrefix: ["comment", "decorator"],
  stmtContainers: ["statement_block", "class_body", "program", "switch_body"]
};
var JS_TABLE = {
  fn: ["function_declaration", "generator_function_declaration", "method_definition"],
  member: ["field_definition"],
  memberOnlyInBody: false,
  lambda: TS_LAMBDA,
  bodies: ["class_body"],
  bodiesParent: {},
  wrappers: [
    "export_statement",
    "lexical_declaration",
    "variable_declaration",
    "expression_statement"
  ],
  attachPrefix: ["comment", "decorator"],
  stmtContainers: ["statement_block", "class_body", "program", "switch_body"]
};
var TABLES = {
  typescript: TS_TABLE,
  tsx: TS_TABLE,
  javascript: JS_TABLE,
  python: {
    fn: ["function_definition"],
    member: [],
    memberOnlyInBody: false,
    lambda: ["lambda"],
    bodies: ["block"],
    bodiesParent: { block: ["class_definition"] },
    wrappers: ["decorated_definition"],
    attachPrefix: ["comment"],
    stmtContainers: ["block", "module"]
  },
  go: {
    fn: ["function_declaration", "method_declaration"],
    member: [],
    memberOnlyInBody: false,
    lambda: ["func_literal"],
    bodies: [],
    bodiesParent: {},
    wrappers: [],
    attachPrefix: ["comment"],
    stmtContainers: ["block", "source_file"]
  },
  rust: {
    fn: ["function_item", "function_signature_item"],
    member: ["const_item", "static_item", "type_item", "associated_type"],
    memberOnlyInBody: true,
    lambda: ["closure_expression"],
    bodies: ["declaration_list"],
    bodiesParent: {},
    wrappers: [],
    attachPrefix: ["attribute_item", "inner_attribute_item", "line_comment", "block_comment"],
    stmtContainers: [
      "block",
      "declaration_list",
      "source_file",
      "field_declaration_list",
      "enum_variant_list"
    ]
  },
  ruby: {
    fn: ["method", "singleton_method"],
    member: [],
    memberOnlyInBody: false,
    lambda: ["lambda"],
    bodies: ["body_statement"],
    bodiesParent: { body_statement: ["class", "module", "singleton_class"] },
    wrappers: [],
    attachPrefix: ["comment"],
    stmtContainers: ["body_statement", "do_block", "block", "program", "then", "else"]
  },
  java: {
    fn: [
      "method_declaration",
      "constructor_declaration",
      "compact_constructor_declaration",
      "static_initializer",
      "annotation_type_element_declaration"
    ],
    member: ["field_declaration", "enum_constant", "constant_declaration"],
    memberOnlyInBody: false,
    lambda: ["lambda_expression"],
    bodies: [
      "class_body",
      "interface_body",
      "enum_body",
      "enum_body_declarations",
      "annotation_type_body"
    ],
    bodiesParent: {},
    wrappers: [],
    attachPrefix: ["line_comment", "block_comment"],
    stmtContainers: ["block", "class_body", "interface_body", "enum_body", "program"]
  },
  kotlin: {
    fn: [
      "function_declaration",
      "secondary_constructor",
      "primary_constructor",
      "anonymous_initializer",
      "getter",
      "setter"
    ],
    member: ["property_declaration", "enum_entry"],
    memberOnlyInBody: false,
    lambda: ["lambda_literal", "anonymous_function"],
    bodies: ["class_body", "enum_class_body"],
    bodiesParent: {},
    wrappers: [],
    attachPrefix: ["line_comment", "block_comment"],
    stmtContainers: ["block", "class_body", "enum_class_body", "source_file", "function_body"]
  },
  swift: {
    fn: [
      "function_declaration",
      "init_declaration",
      "deinit_declaration",
      "subscript_declaration",
      "protocol_function_declaration",
      "computed_property"
    ],
    member: ["property_declaration", "protocol_property_declaration", "enum_entry"],
    memberOnlyInBody: false,
    lambda: ["lambda_literal"],
    bodies: ["class_body", "enum_class_body", "protocol_body"],
    bodiesParent: {},
    wrappers: [],
    attachPrefix: ["comment", "multiline_comment"],
    stmtContainers: ["statements", "class_body", "enum_class_body", "source_file"]
  }
};

// src/pieces.ts
function flatten(file) {
  const out3 = [];
  file.hunks.forEach((hunk, hunkIndex) => {
    let newLine = hunk.newStart;
    let oldLine = hunk.oldStart;
    for (const raw of hunk.lines) {
      const marker = raw[0];
      if (marker === "+") {
        out3.push({ raw, kind: "+", newPos: newLine, anchor: newLine, oldCursor: oldLine, hunk: hunkIndex });
        newLine += 1;
      } else if (marker === "-") {
        out3.push({ raw, kind: "-", newPos: null, anchor: newLine, oldCursor: oldLine, hunk: hunkIndex });
        oldLine += 1;
      } else if (marker === "\\") {
        out3.push({ raw, kind: "\\", newPos: null, anchor: newLine, oldCursor: oldLine, hunk: hunkIndex });
      } else {
        out3.push({ raw, kind: " ", newPos: newLine, anchor: newLine, oldCursor: oldLine, hunk: hunkIndex });
        newLine += 1;
        oldLine += 1;
      }
    }
  });
  return out3;
}
function isBody(node, table) {
  if (node === null || !table.bodies.includes(node.type)) return false;
  const required = table.bodiesParent[node.type];
  if (required === void 0) return true;
  const parent = node.parent;
  return parent === null ? false : required.includes(parent.type);
}
function isTopLevelAssignedLambda(node, table, root) {
  let parent = node.parent;
  for (let hops = 0; parent !== null && hops < 6; hops += 1) {
    if (table.wrappers.includes(parent.type) || table.member.includes(parent.type) || parent.type === "variable_declarator" || parent.type === "assignment") {
      const grand = parent.parent;
      if (grand !== null && (grand.id === root.id || isBody(grand, table))) return true;
      parent = parent.parent;
      continue;
    }
    return false;
  }
  return false;
}
function isFunctionUnit(node, table, depth = 0) {
  if (table.fn.includes(node.type)) return true;
  if (table.lambda.includes(node.type)) return true;
  if (depth > 4) return false;
  const carrier = table.wrappers.includes(node.type) || table.member.includes(node.type) || node.type === "variable_declarator" || node.type === "assignment";
  if (!carrier) return false;
  for (let i2 = 0; i2 < node.namedChildCount; i2 += 1) {
    const child = node.namedChild(i2);
    if (child !== null && isFunctionUnit(child, table, depth + 1)) return true;
  }
  return false;
}
function qualifies(node, table, root) {
  if (table.fn.includes(node.type)) return "fn";
  if (table.member.includes(node.type)) {
    if (!table.memberOnlyInBody) return "member";
    return isBody(node.parent, table) ? "member" : null;
  }
  if (table.lambda.includes(node.type) && isTopLevelAssignedLambda(node, table, root)) {
    return "lambda";
  }
  return null;
}
function promote(node, table) {
  let current = node;
  for (; ; ) {
    const parent = current.parent;
    if (parent === null || !table.wrappers.includes(parent.type)) return current;
    if (parent.startPosition.row > current.startPosition.row) return current;
    current = parent;
  }
}
function nearestChild(parent, row) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let after = null;
  for (let i2 = 0; i2 < parent.namedChildCount; i2 += 1) {
    const child = parent.namedChild(i2);
    if (child === null) continue;
    if (child.startPosition.row > row && after === null) after = child;
    const distance = child.startPosition.row > row ? child.startPosition.row - row : row - child.endPosition.row;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = child;
    }
  }
  return after ?? best;
}
function findUnit(root, table, row, column) {
  let node = root.descendantForPosition({ row, column }) ?? root;
  const prefix = table.attachPrefix.includes(node.type) ? node : node.parent !== null && table.attachPrefix.includes(node.parent.type) ? node.parent : null;
  if (prefix !== null) {
    let sibling = prefix.nextNamedSibling;
    while (sibling !== null && table.attachPrefix.includes(sibling.type)) {
      sibling = sibling.nextNamedSibling;
    }
    if (sibling !== null) node = sibling;
  }
  for (let candidate = node; candidate !== null; candidate = candidate.parent) {
    if (qualifies(candidate, table, root) !== null) {
      const unit2 = promote(candidate, table);
      return { node: unit2, fn: isFunctionUnit(unit2, table) };
    }
  }
  let current = node;
  if (current.id === root.id) {
    const child = nearestChild(root, row);
    if (child === null) return null;
    current = child;
  } else {
    for (; ; ) {
      const parent = current.parent;
      if (parent === null) break;
      if (parent.id === root.id || isBody(parent, table)) break;
      current = parent;
    }
  }
  const unit = promote(current, table);
  return { node: unit, fn: isFunctionUnit(unit, table) };
}
var NAME_FIELDS = ["name", "declarator", "pattern", "property"];
var NAME_DEPTH = 2;
function namedField(node) {
  for (const field of NAME_FIELDS) {
    const child = node.childForFieldName(field);
    if (child === null) continue;
    const text = (child.text.split("\n")[0] ?? "").trim();
    if (text.length > 0) return text.slice(0, 120);
  }
  return null;
}
function unitName(node) {
  let level = [node];
  for (let depth = 0; depth <= NAME_DEPTH && level.length > 0; depth += 1) {
    for (const current of level) {
      const name2 = namedField(current);
      if (name2 !== null) return name2;
    }
    const next = [];
    for (const current of level) {
      for (let i2 = 0; i2 < current.namedChildCount; i2 += 1) {
        const child = current.namedChild(i2);
        if (child !== null) next.push(child);
      }
    }
    level = next;
  }
  const firstLine = (node.text.split("\n")[0] ?? "").trim();
  return firstLine.replace(/\s*\{$/, "").slice(0, 120);
}
function extendedStartRow(node, table) {
  let row = node.startPosition.row;
  let sibling = node.previousNamedSibling;
  while (sibling !== null && table.attachPrefix.includes(sibling.type) && sibling.endPosition.row === row - 1) {
    row = sibling.startPosition.row;
    sibling = sibling.previousNamedSibling;
  }
  return row;
}
function stmtContainer(node, table) {
  const queue = [node];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === void 0) break;
    if (current.id !== node.id && table.stmtContainers.includes(current.type)) return current;
    for (let i2 = 0; i2 < current.childCount; i2 += 1) {
      const child = current.child(i2);
      if (child !== null) queue.push(child);
    }
  }
  return table.stmtContainers.includes(node.type) ? node : null;
}
function countIn(numbers, from, to) {
  let n = 0;
  for (const value2 of numbers) if (value2 >= from && value2 <= to) n += 1;
  return n;
}
var SUBSTANTIVE = /[A-Za-z0-9_]/;
var TOP_LEVEL_NAME = "top-level code";
function errorRows(root) {
  const rows = [];
  const walk = (node) => {
    if (node.type === "ERROR" || node.isMissing) {
      for (let row = node.startPosition.row; row <= node.endPosition.row; row += 1) {
        rows.push(row + 1);
      }
    }
    for (let i2 = 0; i2 < node.childCount; i2 += 1) {
      const child = node.child(i2);
      if (child !== null) walk(child);
    }
  };
  walk(root);
  return rows;
}
function makeHunk(lines, context) {
  const first = lines[0];
  if (first === void 0) throw new Error("internal error: a piece hunk with no lines");
  const raws = lines.map((line) => line.raw);
  const oldCount = countOld(raws);
  let newStart = first.anchor;
  for (const line of lines) {
    if (line.newPos !== null) {
      newStart = line.newPos;
      break;
    }
  }
  return {
    oldStart: gitOldStart(first.oldCursor, oldCount),
    newStart,
    context: ` ${context}`,
    lines: raws
  };
}
function buildPieces(file, source, table, root) {
  const diff = flatten(file);
  const sourceLines = source.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  const addedNumbers = [];
  const substantive = /* @__PURE__ */ new Set();
  for (const line of diff) {
    if (line.kind !== "+" || line.newPos === null) continue;
    addedNumbers.push(line.newPos);
    if (SUBSTANTIVE.test(line.raw.slice(1))) substantive.add(line.newPos);
  }
  if (addedNumbers.length === 0) return [];
  const units = /* @__PURE__ */ new Map();
  for (const line of diff) {
    if (line.kind !== "+" || line.newPos === null) continue;
    const text = line.raw.slice(1);
    if (text.trim().length === 0) continue;
    const column = text.length - text.trimStart().length;
    const found = findUnit(root, table, line.newPos - 1, column);
    if (found === null) continue;
    const key = `${found.node.startIndex}:${found.node.endPosition.row}:${found.node.type}`;
    if (!units.has(key)) units.set(key, found);
  }
  if (units.size === 0) units.set("whole", { node: root, fn: false });
  const base = [...units.values()].map((unit) => ({
    fn: unit.fn,
    node: unit.node,
    name: unitName(unit.node),
    start: extendedStartRow(unit.node, table) + 1,
    end: unit.node.endPosition.row + 1
  }));
  let spans = [];
  for (const unit of base) {
    const inside = base.filter(
      (other) => other !== unit && other.start >= unit.start && other.end <= unit.end && !(other.start === unit.start && other.end === unit.end)
    ).filter(
      (other) => !base.some(
        (middle) => middle !== unit && middle !== other && middle.start >= unit.start && middle.end <= unit.end && other.start >= middle.start && other.end <= middle.end && !(middle.start === other.start && middle.end === other.end)
      )
    ).sort((a, b) => a.start - b.start);
    if (inside.length === 0) {
      spans.push({ ...unit, unitStart: unit.start });
      continue;
    }
    let at = unit.start;
    for (const other of inside) {
      if (other.start > at) spans.push({ ...unit, start: at, end: other.start - 1, unitStart: unit.start });
      at = Math.max(at, other.end + 1);
    }
    if (at <= unit.end) spans.push({ ...unit, start: at, end: unit.end, unitStart: unit.start });
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i2 = 1; i2 < spans.length; i2 += 1) {
    const previous = spans[i2 - 1];
    const current = spans[i2];
    if (previous === void 0 || current === void 0) continue;
    if (current.start <= previous.end) current.start = previous.end + 1;
  }
  spans = spans.filter((span) => span.start <= span.end);
  for (const number of addedNumbers) {
    if (spans.some((span) => number >= span.start && number <= span.end)) continue;
    let after = null;
    let before = null;
    for (const span of spans) {
      if (span.start > number && after === null) after = span;
      if (span.end < number) before = span;
    }
    const toAfter = after === null ? Number.POSITIVE_INFINITY : after.start - number;
    const toBefore = before === null ? Number.POSITIVE_INFINITY : number - before.end;
    if (after !== null && toAfter <= toBefore) after.start = number;
    else if (before !== null) before.end = number;
    else {
      const only = spans[0];
      if (only === void 0) throw new Error(`internal error: no span to hold line ${number} of ${file.file}`);
      only.start = Math.min(only.start, number);
      only.end = Math.max(only.end, number);
    }
  }
  for (; ; ) {
    if (spans.length <= 1) break;
    const index = spans.findIndex(
      (span2) => !addedNumbers.some(
        (number) => number >= span2.start && number <= span2.end && substantive.has(number)
      )
    );
    if (index < 0) break;
    const span = spans[index];
    const next = spans[index + 1];
    const previous = spans[index - 1];
    if (span === void 0) break;
    if (next !== void 0) next.start = Math.min(next.start, span.start);
    else if (previous !== void 0) previous.end = Math.max(previous.end, span.end);
    else break;
    spans.splice(index, 1);
  }
  const unitSpans = [];
  for (const span of spans) {
    if (countIn(addedNumbers, span.start, span.end) <= MAX_ADDED_PER_PIECE) {
      unitSpans.push(span);
      continue;
    }
    const container = stmtContainer(span.node, table);
    const cuts = [];
    if (container !== null) {
      for (let i2 = 0; i2 < container.namedChildCount; i2 += 1) {
        const child = container.namedChild(i2);
        if (child === null) continue;
        const row = extendedStartRow(child, table) + 1;
        if (row > span.start && row <= span.end && !cuts.includes(row)) cuts.push(row);
      }
    }
    cuts.sort((a, b) => a - b);
    if (cuts.length === 0) {
      unitSpans.push(span);
      continue;
    }
    const bounds = [span.start, ...cuts, span.end + 1];
    let current = null;
    for (let i2 = 0; i2 + 1 < bounds.length; i2 += 1) {
      const start3 = bounds[i2];
      const next = bounds[i2 + 1];
      if (start3 === void 0 || next === void 0) continue;
      const segment = { start: start3, end: next - 1 };
      const segmentAdded = countIn(addedNumbers, segment.start, segment.end);
      if (current === null) {
        current = { ...span, ...segment };
        continue;
      }
      const currentAdded = countIn(addedNumbers, current.start, current.end);
      if (currentAdded > 0 && currentAdded + segmentAdded > MAX_ADDED_PER_PIECE) {
        unitSpans.push(current);
        current = { ...span, ...segment };
      } else {
        current.end = segment.end;
      }
    }
    if (current !== null) unitSpans.push(current);
  }
  unitSpans.sort((a, b) => a.start - b.start);
  const usedRemoved = /* @__PURE__ */ new Set();
  const atoms = [];
  for (const span of unitSpans) {
    const indexes = [];
    const added = [];
    diff.forEach((line, index) => {
      if (line.newPos !== null) {
        if (line.newPos >= span.start && line.newPos <= span.end) {
          indexes.push(index);
          if (line.kind === "+") added.push(line.newPos);
        }
        return;
      }
      if (usedRemoved.has(index)) return;
      const anchor = line.anchor;
      if (anchor - 1 >= span.start && anchor - 1 <= span.end || anchor >= span.start && anchor <= span.end) {
        indexes.push(index);
        usedRemoved.add(index);
      }
    });
    if (added.length === 0) continue;
    atoms.push({
      span,
      indexes,
      added,
      firstLine: (sourceLines[span.unitStart - 1] ?? "").trim()
    });
  }
  const groups = [];
  for (const atom of atoms) {
    const last = groups[groups.length - 1];
    const fn = atom.span.fn;
    const merge = last !== void 0 && !fn && !last.fn && last.added.length + atom.added.length <= MAX_ADDED_PER_PIECE;
    if (merge && last !== void 0) {
      last.atoms.push(atom);
      last.added.push(...atom.added);
      last.indexes.push(...atom.indexes);
    } else {
      groups.push({ atoms: [atom], added: [...atom.added], indexes: [...atom.indexes], fn });
    }
  }
  const pieces = [];
  for (const group of groups) {
    const indexes = [...new Set(group.indexes)].sort((a, b) => a - b);
    const runs = [];
    for (const index of indexes) {
      const last = runs[runs.length - 1];
      const previous = last === void 0 ? void 0 : last[last.length - 1];
      const line = diff[index];
      const previousLine = previous === void 0 ? void 0 : diff[previous];
      if (last !== void 0 && previous !== void 0 && index === previous + 1 && line !== void 0 && previousLine !== void 0 && line.hunk === previousLine.hunk) {
        last.push(index);
      } else {
        runs.push([index]);
      }
    }
    const hunks = [];
    for (const run3 of runs) {
      const lines = run3.map((index) => diff[index]).filter((line) => line !== void 0);
      const first = lines[0];
      if (first === void 0) continue;
      let at = first.anchor;
      for (const line of lines) {
        if (line.newPos !== null) {
          at = line.newPos;
          break;
        }
      }
      const owner = group.atoms.find((atom) => at >= atom.span.start && at <= atom.span.end) ?? group.atoms[0];
      if (owner === void 0) throw new Error("internal error: a piece with no unit");
      hunks.push(makeHunk(lines, owner.firstLine));
    }
    const firstAtom = group.atoms[0];
    if (firstAtom === void 0) throw new Error("internal error: a piece group with no unit");
    pieces.push({
      file: file.file,
      header: file.header,
      hunks,
      // A run of statements is named by what it is, never by its first line: "import json"
      // tells the reader nothing about the piece.
      unitName: group.fn ? firstAtom.span.name : TOP_LEVEL_NAME,
      fromLine: Math.min(...group.atoms.map((atom) => atom.span.start)),
      toLine: Math.max(...group.atoms.map((atom) => atom.span.end)),
      cut: "unit"
    });
  }
  assertEveryAddedLineOnce(file.file, addedNumbers, pieces);
  return pieces;
}
function addedOf(piece) {
  const out3 = [];
  for (const hunk of piece.hunks) {
    let line = hunk.newStart;
    for (const raw of hunk.lines) {
      const marker = raw[0];
      if (marker === "+") {
        out3.push(line);
        line += 1;
      } else if (marker === " ") {
        line += 1;
      }
    }
  }
  return out3;
}
function assertEveryAddedLineOnce(file, addedNumbers, pieces) {
  const seen = /* @__PURE__ */ new Map();
  for (const piece of pieces) {
    for (const number of addedOf(piece)) seen.set(number, (seen.get(number) ?? 0) + 1);
  }
  const missing = addedNumbers.filter((number) => !seen.has(number));
  const twice = [...seen.entries()].filter(([, count]) => count > 1).map(([number]) => number);
  const extra = [...seen.keys()].filter((number) => !addedNumbers.includes(number));
  if (missing.length === 0 && twice.length === 0 && extra.length === 0) return;
  const parts2 = [];
  if (missing.length > 0) parts2.push(`${missing.length} in no piece (first ${missing[0]})`);
  if (twice.length > 0) parts2.push(`${twice.length} in two pieces (first ${twice[0]})`);
  if (extra.length > 0) parts2.push(`${extra.length} in a piece but not added (first ${extra[0]})`);
  throw new Error(
    `stop-rules cut ${file} wrongly: ${parts2.join(", ")}. This is a bug in stop-rules, please report it.`
  );
}
var HUNK_MAX_ADDED = 30;
var HUNK_TRAILING_CONTEXT = 3;
function piecesByHunk(file) {
  const pieces = [];
  const addedNumbers = [];
  for (const hunk of file.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    let segment = [];
    let added = 0;
    let segmentOldStart = oldLine;
    let segmentNewStart = newLine;
    let trailing = -1;
    const flush = () => {
      if (added > 0) {
        pieces.push({
          file: file.file,
          header: file.header,
          hunks: [
            {
              oldStart: gitOldStart(segmentOldStart, countOld(segment)),
              newStart: segmentNewStart,
              context: hunk.context,
              lines: segment
            }
          ],
          unitName: null,
          fromLine: segmentNewStart,
          toLine: segmentNewStart + Math.max(countNew(segment), 1) - 1,
          cut: "hunk"
        });
      }
      segment = [];
      added = 0;
      segmentOldStart = oldLine;
      segmentNewStart = newLine;
      trailing = -1;
    };
    for (const raw of hunk.lines) {
      const marker = raw[0];
      const kind = marker === "+" ? "add" : marker === "-" ? "del" : marker === "\\" ? "nonl" : "ctx";
      if (trailing >= 0) {
        if (kind === "ctx" && trailing < HUNK_TRAILING_CONTEXT) {
          segment.push(raw);
          oldLine += 1;
          newLine += 1;
          trailing += 1;
          continue;
        }
        if (kind === "nonl") {
          segment.push(raw);
          continue;
        }
        flush();
      }
      if (kind === "add") {
        segment.push(raw);
        addedNumbers.push(newLine);
        added += 1;
        newLine += 1;
        if (added >= HUNK_MAX_ADDED) trailing = 0;
      } else if (kind === "del") {
        segment.push(raw);
        oldLine += 1;
      } else if (kind === "nonl") {
        segment.push(raw);
      } else {
        segment.push(raw);
        oldLine += 1;
        newLine += 1;
      }
    }
    flush();
  }
  assertEveryAddedLineOnce(file.file, addedNumbers, pieces);
  return pieces;
}
function chunkPieces(file) {
  const pieces = chunkFile(file).map((chunk) => {
    const range = chunkRange(chunk);
    return {
      file: chunk.file,
      header: chunk.header,
      hunks: chunk.hunks,
      unitName: null,
      fromLine: range.from,
      toLine: range.to,
      cut: "chunk"
    };
  });
  const added = [];
  for (const hunk of file.hunks) {
    let line = hunk.newStart;
    for (const raw of hunk.lines) {
      const marker = raw[0];
      if (marker === "+") {
        added.push(line);
        line += 1;
      } else if (marker === " ") {
        line += 1;
      }
    }
  }
  assertEveryAddedLineOnce(file.file, added, pieces);
  return pieces;
}

// src/treesitter.ts
import { promises as fs10 } from "node:fs";
import * as path16 from "node:path";
import { fileURLToPath } from "node:url";

// node_modules/web-tree-sitter/tree-sitter.js
var __defProp = Object.defineProperty;
var __name = (target, value2) => __defProp(target, "name", { value: value2, configurable: true });
var SIZE_OF_SHORT = 2;
var SIZE_OF_INT = 4;
var SIZE_OF_CURSOR = 4 * SIZE_OF_INT;
var SIZE_OF_NODE = 5 * SIZE_OF_INT;
var SIZE_OF_POINT = 2 * SIZE_OF_INT;
var SIZE_OF_RANGE = 2 * SIZE_OF_INT + 2 * SIZE_OF_POINT;
var ZERO_POINT = { row: 0, column: 0 };
var INTERNAL = Symbol("INTERNAL");
function assertInternal(x) {
  if (x !== INTERNAL) throw new Error("Illegal constructor");
}
__name(assertInternal, "assertInternal");
function isPoint(point) {
  return !!point && typeof point.row === "number" && typeof point.column === "number";
}
__name(isPoint, "isPoint");
function setModule(module2) {
  C = module2;
}
__name(setModule, "setModule");
var C;
var LookaheadIterator = class {
  static {
    __name(this, "LookaheadIterator");
  }
  /** @internal */
  [0] = 0;
  // Internal handle for WASM
  /** @internal */
  language;
  /** @internal */
  constructor(internal, address, language) {
    assertInternal(internal);
    this[0] = address;
    this.language = language;
  }
  /** Get the current symbol of the lookahead iterator. */
  get currentTypeId() {
    return C._ts_lookahead_iterator_current_symbol(this[0]);
  }
  /** Get the current symbol name of the lookahead iterator. */
  get currentType() {
    return this.language.types[this.currentTypeId] || "ERROR";
  }
  /** Delete the lookahead iterator, freeing its resources. */
  delete() {
    C._ts_lookahead_iterator_delete(this[0]);
    this[0] = 0;
  }
  /**
   * Reset the lookahead iterator.
   *
   * This returns `true` if the language was set successfully and `false`
   * otherwise.
   */
  reset(language, stateId) {
    if (C._ts_lookahead_iterator_reset(this[0], language[0], stateId)) {
      this.language = language;
      return true;
    }
    return false;
  }
  /**
   * Reset the lookahead iterator to another state.
   *
   * This returns `true` if the iterator was reset to the given state and
   * `false` otherwise.
   */
  resetState(stateId) {
    return Boolean(C._ts_lookahead_iterator_reset_state(this[0], stateId));
  }
  /**
   * Returns an iterator that iterates over the symbols of the lookahead iterator.
   *
   * The iterator will yield the current symbol name as a string for each step
   * until there are no more symbols to iterate over.
   */
  [Symbol.iterator]() {
    return {
      next: /* @__PURE__ */ __name(() => {
        if (C._ts_lookahead_iterator_next(this[0])) {
          return { done: false, value: this.currentType };
        }
        return { done: true, value: "" };
      }, "next")
    };
  }
};
function getText(tree, startIndex, endIndex, startPosition) {
  const length = endIndex - startIndex;
  let result = tree.textCallback(startIndex, startPosition);
  if (result) {
    startIndex += result.length;
    while (startIndex < endIndex) {
      const string = tree.textCallback(startIndex, startPosition);
      if (string && string.length > 0) {
        startIndex += string.length;
        result += string;
      } else {
        break;
      }
    }
    if (startIndex > endIndex) {
      result = result.slice(0, length);
    }
  }
  return result ?? "";
}
__name(getText, "getText");
var Tree = class _Tree {
  static {
    __name(this, "Tree");
  }
  /** @internal */
  [0] = 0;
  // Internal handle for WASM
  /** @internal */
  textCallback;
  /** The language that was used to parse the syntax tree. */
  language;
  /** @internal */
  constructor(internal, address, language, textCallback) {
    assertInternal(internal);
    this[0] = address;
    this.language = language;
    this.textCallback = textCallback;
  }
  /** Create a shallow copy of the syntax tree. This is very fast. */
  copy() {
    const address = C._ts_tree_copy(this[0]);
    return new _Tree(INTERNAL, address, this.language, this.textCallback);
  }
  /** Delete the syntax tree, freeing its resources. */
  delete() {
    C._ts_tree_delete(this[0]);
    this[0] = 0;
  }
  /** Get the root node of the syntax tree. */
  get rootNode() {
    C._ts_tree_root_node_wasm(this[0]);
    return unmarshalNode(this);
  }
  /**
   * Get the root node of the syntax tree, but with its position shifted
   * forward by the given offset.
   */
  rootNodeWithOffset(offsetBytes, offsetExtent) {
    const address = TRANSFER_BUFFER + SIZE_OF_NODE;
    C.setValue(address, offsetBytes, "i32");
    marshalPoint(address + SIZE_OF_INT, offsetExtent);
    C._ts_tree_root_node_with_offset_wasm(this[0]);
    return unmarshalNode(this);
  }
  /**
   * Edit the syntax tree to keep it in sync with source code that has been
   * edited.
   *
   * You must describe the edit both in terms of byte offsets and in terms of
   * row/column coordinates.
   */
  edit(edit) {
    marshalEdit(edit);
    C._ts_tree_edit_wasm(this[0]);
  }
  /** Create a new {@link TreeCursor} starting from the root of the tree. */
  walk() {
    return this.rootNode.walk();
  }
  /**
   * Compare this old edited syntax tree to a new syntax tree representing
   * the same document, returning a sequence of ranges whose syntactic
   * structure has changed.
   *
   * For this to work correctly, this syntax tree must have been edited such
   * that its ranges match up to the new tree. Generally, you'll want to
   * call this method right after calling one of the [`Parser::parse`]
   * functions. Call it on the old tree that was passed to parse, and
   * pass the new tree that was returned from `parse`.
   */
  getChangedRanges(other) {
    if (!(other instanceof _Tree)) {
      throw new TypeError("Argument must be a Tree");
    }
    C._ts_tree_get_changed_ranges_wasm(this[0], other[0]);
    const count = C.getValue(TRANSFER_BUFFER, "i32");
    const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    const result = new Array(count);
    if (count > 0) {
      let address = buffer;
      for (let i2 = 0; i2 < count; i2++) {
        result[i2] = unmarshalRange(address);
        address += SIZE_OF_RANGE;
      }
      C._free(buffer);
    }
    return result;
  }
  /** Get the included ranges that were used to parse the syntax tree. */
  getIncludedRanges() {
    C._ts_tree_included_ranges_wasm(this[0]);
    const count = C.getValue(TRANSFER_BUFFER, "i32");
    const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    const result = new Array(count);
    if (count > 0) {
      let address = buffer;
      for (let i2 = 0; i2 < count; i2++) {
        result[i2] = unmarshalRange(address);
        address += SIZE_OF_RANGE;
      }
      C._free(buffer);
    }
    return result;
  }
};
var TreeCursor = class _TreeCursor {
  static {
    __name(this, "TreeCursor");
  }
  /** @internal */
  // @ts-expect-error: never read
  [0] = 0;
  // Internal handle for Wasm
  /** @internal */
  // @ts-expect-error: never read
  [1] = 0;
  // Internal handle for Wasm
  /** @internal */
  // @ts-expect-error: never read
  [2] = 0;
  // Internal handle for Wasm
  /** @internal */
  // @ts-expect-error: never read
  [3] = 0;
  // Internal handle for Wasm
  /** @internal */
  tree;
  /** @internal */
  constructor(internal, tree) {
    assertInternal(internal);
    this.tree = tree;
    unmarshalTreeCursor(this);
  }
  /** Creates a deep copy of the tree cursor. This allocates new memory. */
  copy() {
    const copy = new _TreeCursor(INTERNAL, this.tree);
    C._ts_tree_cursor_copy_wasm(this.tree[0]);
    unmarshalTreeCursor(copy);
    return copy;
  }
  /** Delete the tree cursor, freeing its resources. */
  delete() {
    marshalTreeCursor(this);
    C._ts_tree_cursor_delete_wasm(this.tree[0]);
    this[0] = this[1] = this[2] = 0;
  }
  /** Get the tree cursor's current {@link Node}. */
  get currentNode() {
    marshalTreeCursor(this);
    C._ts_tree_cursor_current_node_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /**
   * Get the numerical field id of this tree cursor's current node.
   *
   * See also {@link TreeCursor#currentFieldName}.
   */
  get currentFieldId() {
    marshalTreeCursor(this);
    return C._ts_tree_cursor_current_field_id_wasm(this.tree[0]);
  }
  /** Get the field name of this tree cursor's current node. */
  get currentFieldName() {
    return this.tree.language.fields[this.currentFieldId];
  }
  /**
   * Get the depth of the cursor's current node relative to the original
   * node that the cursor was constructed with.
   */
  get currentDepth() {
    marshalTreeCursor(this);
    return C._ts_tree_cursor_current_depth_wasm(this.tree[0]);
  }
  /**
   * Get the index of the cursor's current node out of all of the
   * descendants of the original node that the cursor was constructed with.
   */
  get currentDescendantIndex() {
    marshalTreeCursor(this);
    return C._ts_tree_cursor_current_descendant_index_wasm(this.tree[0]);
  }
  /** Get the type of the cursor's current node. */
  get nodeType() {
    return this.tree.language.types[this.nodeTypeId] || "ERROR";
  }
  /** Get the type id of the cursor's current node. */
  get nodeTypeId() {
    marshalTreeCursor(this);
    return C._ts_tree_cursor_current_node_type_id_wasm(this.tree[0]);
  }
  /** Get the state id of the cursor's current node. */
  get nodeStateId() {
    marshalTreeCursor(this);
    return C._ts_tree_cursor_current_node_state_id_wasm(this.tree[0]);
  }
  /** Get the id of the cursor's current node. */
  get nodeId() {
    marshalTreeCursor(this);
    return C._ts_tree_cursor_current_node_id_wasm(this.tree[0]);
  }
  /**
   * Check if the cursor's current node is *named*.
   *
   * Named nodes correspond to named rules in the grammar, whereas
   * *anonymous* nodes correspond to string literals in the grammar.
   */
  get nodeIsNamed() {
    marshalTreeCursor(this);
    return C._ts_tree_cursor_current_node_is_named_wasm(this.tree[0]) === 1;
  }
  /**
   * Check if the cursor's current node is *missing*.
   *
   * Missing nodes are inserted by the parser in order to recover from
   * certain kinds of syntax errors.
   */
  get nodeIsMissing() {
    marshalTreeCursor(this);
    return C._ts_tree_cursor_current_node_is_missing_wasm(this.tree[0]) === 1;
  }
  /** Get the string content of the cursor's current node. */
  get nodeText() {
    marshalTreeCursor(this);
    const startIndex = C._ts_tree_cursor_start_index_wasm(this.tree[0]);
    const endIndex = C._ts_tree_cursor_end_index_wasm(this.tree[0]);
    C._ts_tree_cursor_start_position_wasm(this.tree[0]);
    const startPosition = unmarshalPoint(TRANSFER_BUFFER);
    return getText(this.tree, startIndex, endIndex, startPosition);
  }
  /** Get the start position of the cursor's current node. */
  get startPosition() {
    marshalTreeCursor(this);
    C._ts_tree_cursor_start_position_wasm(this.tree[0]);
    return unmarshalPoint(TRANSFER_BUFFER);
  }
  /** Get the end position of the cursor's current node. */
  get endPosition() {
    marshalTreeCursor(this);
    C._ts_tree_cursor_end_position_wasm(this.tree[0]);
    return unmarshalPoint(TRANSFER_BUFFER);
  }
  /** Get the start index of the cursor's current node. */
  get startIndex() {
    marshalTreeCursor(this);
    return C._ts_tree_cursor_start_index_wasm(this.tree[0]);
  }
  /** Get the end index of the cursor's current node. */
  get endIndex() {
    marshalTreeCursor(this);
    return C._ts_tree_cursor_end_index_wasm(this.tree[0]);
  }
  /**
   * Move this cursor to the first child of its current node.
   *
   * This returns `true` if the cursor successfully moved, and returns
   * `false` if there were no children.
   */
  gotoFirstChild() {
    marshalTreeCursor(this);
    const result = C._ts_tree_cursor_goto_first_child_wasm(this.tree[0]);
    unmarshalTreeCursor(this);
    return result === 1;
  }
  /**
   * Move this cursor to the last child of its current node.
   *
   * This returns `true` if the cursor successfully moved, and returns
   * `false` if there were no children.
   *
   * Note that this function may be slower than
   * {@link TreeCursor#gotoFirstChild} because it needs to
   * iterate through all the children to compute the child's position.
   */
  gotoLastChild() {
    marshalTreeCursor(this);
    const result = C._ts_tree_cursor_goto_last_child_wasm(this.tree[0]);
    unmarshalTreeCursor(this);
    return result === 1;
  }
  /**
   * Move this cursor to the parent of its current node.
   *
   * This returns `true` if the cursor successfully moved, and returns
   * `false` if there was no parent node (the cursor was already on the
   * root node).
   *
   * Note that the node the cursor was constructed with is considered the root
   * of the cursor, and the cursor cannot walk outside this node.
   */
  gotoParent() {
    marshalTreeCursor(this);
    const result = C._ts_tree_cursor_goto_parent_wasm(this.tree[0]);
    unmarshalTreeCursor(this);
    return result === 1;
  }
  /**
   * Move this cursor to the next sibling of its current node.
   *
   * This returns `true` if the cursor successfully moved, and returns
   * `false` if there was no next sibling node.
   *
   * Note that the node the cursor was constructed with is considered the root
   * of the cursor, and the cursor cannot walk outside this node.
   */
  gotoNextSibling() {
    marshalTreeCursor(this);
    const result = C._ts_tree_cursor_goto_next_sibling_wasm(this.tree[0]);
    unmarshalTreeCursor(this);
    return result === 1;
  }
  /**
   * Move this cursor to the previous sibling of its current node.
   *
   * This returns `true` if the cursor successfully moved, and returns
   * `false` if there was no previous sibling node.
   *
   * Note that this function may be slower than
   * {@link TreeCursor#gotoNextSibling} due to how node
   * positions are stored. In the worst case, this will need to iterate
   * through all the children up to the previous sibling node to recalculate
   * its position. Also note that the node the cursor was constructed with is
   * considered the root of the cursor, and the cursor cannot walk outside this node.
   */
  gotoPreviousSibling() {
    marshalTreeCursor(this);
    const result = C._ts_tree_cursor_goto_previous_sibling_wasm(this.tree[0]);
    unmarshalTreeCursor(this);
    return result === 1;
  }
  /**
   * Move the cursor to the node that is the nth descendant of
   * the original node that the cursor was constructed with, where
   * zero represents the original node itself.
   */
  gotoDescendant(goalDescendantIndex) {
    marshalTreeCursor(this);
    C._ts_tree_cursor_goto_descendant_wasm(this.tree[0], goalDescendantIndex);
    unmarshalTreeCursor(this);
  }
  /**
   * Move this cursor to the first child of its current node that contains or
   * starts after the given byte offset.
   *
   * This returns `true` if the cursor successfully moved to a child node, and returns
   * `false` if no such child was found.
   */
  gotoFirstChildForIndex(goalIndex) {
    marshalTreeCursor(this);
    C.setValue(TRANSFER_BUFFER + SIZE_OF_CURSOR, goalIndex, "i32");
    const result = C._ts_tree_cursor_goto_first_child_for_index_wasm(this.tree[0]);
    unmarshalTreeCursor(this);
    return result === 1;
  }
  /**
   * Move this cursor to the first child of its current node that contains or
   * starts after the given byte offset.
   *
   * This returns the index of the child node if one was found, and returns
   * `null` if no such child was found.
   */
  gotoFirstChildForPosition(goalPosition) {
    marshalTreeCursor(this);
    marshalPoint(TRANSFER_BUFFER + SIZE_OF_CURSOR, goalPosition);
    const result = C._ts_tree_cursor_goto_first_child_for_position_wasm(this.tree[0]);
    unmarshalTreeCursor(this);
    return result === 1;
  }
  /**
   * Re-initialize this tree cursor to start at the original node that the
   * cursor was constructed with.
   */
  reset(node) {
    marshalNode(node);
    marshalTreeCursor(this, TRANSFER_BUFFER + SIZE_OF_NODE);
    C._ts_tree_cursor_reset_wasm(this.tree[0]);
    unmarshalTreeCursor(this);
  }
  /**
   * Re-initialize a tree cursor to the same position as another cursor.
   *
   * Unlike {@link TreeCursor#reset}, this will not lose parent
   * information and allows reusing already created cursors.
   */
  resetTo(cursor) {
    marshalTreeCursor(this, TRANSFER_BUFFER);
    marshalTreeCursor(cursor, TRANSFER_BUFFER + SIZE_OF_CURSOR);
    C._ts_tree_cursor_reset_to_wasm(this.tree[0], cursor.tree[0]);
    unmarshalTreeCursor(this);
  }
};
var Node = class {
  static {
    __name(this, "Node");
  }
  /** @internal */
  // @ts-expect-error: never read
  [0] = 0;
  // Internal handle for Wasm
  /** @internal */
  _children;
  /** @internal */
  _namedChildren;
  /** @internal */
  constructor(internal, {
    id,
    tree,
    startIndex,
    startPosition,
    other
  }) {
    assertInternal(internal);
    this[0] = other;
    this.id = id;
    this.tree = tree;
    this.startIndex = startIndex;
    this.startPosition = startPosition;
  }
  /**
   * The numeric id for this node that is unique.
   *
   * Within a given syntax tree, no two nodes have the same id. However:
   *
   * * If a new tree is created based on an older tree, and a node from the old tree is reused in
   *   the process, then that node will have the same id in both trees.
   *
   * * A node not marked as having changes does not guarantee it was reused.
   *
   * * If a node is marked as having changed in the old tree, it will not be reused.
   */
  id;
  /** The byte index where this node starts. */
  startIndex;
  /** The position where this node starts. */
  startPosition;
  /** The tree that this node belongs to. */
  tree;
  /** Get this node's type as a numerical id. */
  get typeId() {
    marshalNode(this);
    return C._ts_node_symbol_wasm(this.tree[0]);
  }
  /**
   * Get the node's type as a numerical id as it appears in the grammar,
   * ignoring aliases.
   */
  get grammarId() {
    marshalNode(this);
    return C._ts_node_grammar_symbol_wasm(this.tree[0]);
  }
  /** Get this node's type as a string. */
  get type() {
    return this.tree.language.types[this.typeId] || "ERROR";
  }
  /**
   * Get this node's symbol name as it appears in the grammar, ignoring
   * aliases as a string.
   */
  get grammarType() {
    return this.tree.language.types[this.grammarId] || "ERROR";
  }
  /**
   * Check if this node is *named*.
   *
   * Named nodes correspond to named rules in the grammar, whereas
   * *anonymous* nodes correspond to string literals in the grammar.
   */
  get isNamed() {
    marshalNode(this);
    return C._ts_node_is_named_wasm(this.tree[0]) === 1;
  }
  /**
   * Check if this node is *extra*.
   *
   * Extra nodes represent things like comments, which are not required
   * by the grammar, but can appear anywhere.
   */
  get isExtra() {
    marshalNode(this);
    return C._ts_node_is_extra_wasm(this.tree[0]) === 1;
  }
  /**
   * Check if this node represents a syntax error.
   *
   * Syntax errors represent parts of the code that could not be incorporated
   * into a valid syntax tree.
   */
  get isError() {
    marshalNode(this);
    return C._ts_node_is_error_wasm(this.tree[0]) === 1;
  }
  /**
   * Check if this node is *missing*.
   *
   * Missing nodes are inserted by the parser in order to recover from
   * certain kinds of syntax errors.
   */
  get isMissing() {
    marshalNode(this);
    return C._ts_node_is_missing_wasm(this.tree[0]) === 1;
  }
  /** Check if this node has been edited. */
  get hasChanges() {
    marshalNode(this);
    return C._ts_node_has_changes_wasm(this.tree[0]) === 1;
  }
  /**
   * Check if this node represents a syntax error or contains any syntax
   * errors anywhere within it.
   */
  get hasError() {
    marshalNode(this);
    return C._ts_node_has_error_wasm(this.tree[0]) === 1;
  }
  /** Get the byte index where this node ends. */
  get endIndex() {
    marshalNode(this);
    return C._ts_node_end_index_wasm(this.tree[0]);
  }
  /** Get the position where this node ends. */
  get endPosition() {
    marshalNode(this);
    C._ts_node_end_point_wasm(this.tree[0]);
    return unmarshalPoint(TRANSFER_BUFFER);
  }
  /** Get the string content of this node. */
  get text() {
    return getText(this.tree, this.startIndex, this.endIndex, this.startPosition);
  }
  /** Get this node's parse state. */
  get parseState() {
    marshalNode(this);
    return C._ts_node_parse_state_wasm(this.tree[0]);
  }
  /** Get the parse state after this node. */
  get nextParseState() {
    marshalNode(this);
    return C._ts_node_next_parse_state_wasm(this.tree[0]);
  }
  /** Check if this node is equal to another node. */
  equals(other) {
    return this.tree === other.tree && this.id === other.id;
  }
  /**
   * Get the node's child at the given index, where zero represents the first child.
   *
   * This method is fairly fast, but its cost is technically log(n), so if
   * you might be iterating over a long list of children, you should use
   * {@link Node#children} instead.
   */
  child(index) {
    marshalNode(this);
    C._ts_node_child_wasm(this.tree[0], index);
    return unmarshalNode(this.tree);
  }
  /**
   * Get this node's *named* child at the given index.
   *
   * See also {@link Node#isNamed}.
   * This method is fairly fast, but its cost is technically log(n), so if
   * you might be iterating over a long list of children, you should use
   * {@link Node#namedChildren} instead.
   */
  namedChild(index) {
    marshalNode(this);
    C._ts_node_named_child_wasm(this.tree[0], index);
    return unmarshalNode(this.tree);
  }
  /**
   * Get this node's child with the given numerical field id.
   *
   * See also {@link Node#childForFieldName}. You can
   * convert a field name to an id using {@link Language#fieldIdForName}.
   */
  childForFieldId(fieldId) {
    marshalNode(this);
    C._ts_node_child_by_field_id_wasm(this.tree[0], fieldId);
    return unmarshalNode(this.tree);
  }
  /**
   * Get the first child with the given field name.
   *
   * If multiple children may have the same field name, access them using
   * {@link Node#childrenForFieldName}.
   */
  childForFieldName(fieldName) {
    const fieldId = this.tree.language.fields.indexOf(fieldName);
    if (fieldId !== -1) return this.childForFieldId(fieldId);
    return null;
  }
  /** Get the field name of this node's child at the given index. */
  fieldNameForChild(index) {
    marshalNode(this);
    const address = C._ts_node_field_name_for_child_wasm(this.tree[0], index);
    if (!address) return null;
    return C.AsciiToString(address);
  }
  /** Get the field name of this node's named child at the given index. */
  fieldNameForNamedChild(index) {
    marshalNode(this);
    const address = C._ts_node_field_name_for_named_child_wasm(this.tree[0], index);
    if (!address) return null;
    return C.AsciiToString(address);
  }
  /**
   * Get an array of this node's children with a given field name.
   *
   * See also {@link Node#children}.
   */
  childrenForFieldName(fieldName) {
    const fieldId = this.tree.language.fields.indexOf(fieldName);
    if (fieldId !== -1 && fieldId !== 0) return this.childrenForFieldId(fieldId);
    return [];
  }
  /**
    * Get an array of this node's children with a given field id.
    *
    * See also {@link Node#childrenForFieldName}.
    */
  childrenForFieldId(fieldId) {
    marshalNode(this);
    C._ts_node_children_by_field_id_wasm(this.tree[0], fieldId);
    const count = C.getValue(TRANSFER_BUFFER, "i32");
    const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    const result = new Array(count);
    if (count > 0) {
      let address = buffer;
      for (let i2 = 0; i2 < count; i2++) {
        result[i2] = unmarshalNode(this.tree, address);
        address += SIZE_OF_NODE;
      }
      C._free(buffer);
    }
    return result;
  }
  /** Get the node's first child that contains or starts after the given byte offset. */
  firstChildForIndex(index) {
    marshalNode(this);
    const address = TRANSFER_BUFFER + SIZE_OF_NODE;
    C.setValue(address, index, "i32");
    C._ts_node_first_child_for_byte_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /** Get the node's first named child that contains or starts after the given byte offset. */
  firstNamedChildForIndex(index) {
    marshalNode(this);
    const address = TRANSFER_BUFFER + SIZE_OF_NODE;
    C.setValue(address, index, "i32");
    C._ts_node_first_named_child_for_byte_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /** Get this node's number of children. */
  get childCount() {
    marshalNode(this);
    return C._ts_node_child_count_wasm(this.tree[0]);
  }
  /**
   * Get this node's number of *named* children.
   *
   * See also {@link Node#isNamed}.
   */
  get namedChildCount() {
    marshalNode(this);
    return C._ts_node_named_child_count_wasm(this.tree[0]);
  }
  /** Get this node's first child. */
  get firstChild() {
    return this.child(0);
  }
  /**
   * Get this node's first named child.
   *
   * See also {@link Node#isNamed}.
   */
  get firstNamedChild() {
    return this.namedChild(0);
  }
  /** Get this node's last child. */
  get lastChild() {
    return this.child(this.childCount - 1);
  }
  /**
   * Get this node's last named child.
   *
   * See also {@link Node#isNamed}.
   */
  get lastNamedChild() {
    return this.namedChild(this.namedChildCount - 1);
  }
  /**
   * Iterate over this node's children.
   *
   * If you're walking the tree recursively, you may want to use the
   * {@link TreeCursor} APIs directly instead.
   */
  get children() {
    if (!this._children) {
      marshalNode(this);
      C._ts_node_children_wasm(this.tree[0]);
      const count = C.getValue(TRANSFER_BUFFER, "i32");
      const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
      this._children = new Array(count);
      if (count > 0) {
        let address = buffer;
        for (let i2 = 0; i2 < count; i2++) {
          this._children[i2] = unmarshalNode(this.tree, address);
          address += SIZE_OF_NODE;
        }
        C._free(buffer);
      }
    }
    return this._children;
  }
  /**
   * Iterate over this node's named children.
   *
   * See also {@link Node#children}.
   */
  get namedChildren() {
    if (!this._namedChildren) {
      marshalNode(this);
      C._ts_node_named_children_wasm(this.tree[0]);
      const count = C.getValue(TRANSFER_BUFFER, "i32");
      const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
      this._namedChildren = new Array(count);
      if (count > 0) {
        let address = buffer;
        for (let i2 = 0; i2 < count; i2++) {
          this._namedChildren[i2] = unmarshalNode(this.tree, address);
          address += SIZE_OF_NODE;
        }
        C._free(buffer);
      }
    }
    return this._namedChildren;
  }
  /**
   * Get the descendants of this node that are the given type, or in the given types array.
   *
   * The types array should contain node type strings, which can be retrieved from {@link Language#types}.
   *
   * Additionally, a `startPosition` and `endPosition` can be passed in to restrict the search to a byte range.
   */
  descendantsOfType(types, startPosition = ZERO_POINT, endPosition = ZERO_POINT) {
    if (!Array.isArray(types)) types = [types];
    const symbols = [];
    const typesBySymbol = this.tree.language.types;
    for (const node_type of types) {
      if (node_type == "ERROR") {
        symbols.push(65535);
      }
    }
    for (let i2 = 0, n = typesBySymbol.length; i2 < n; i2++) {
      if (types.includes(typesBySymbol[i2])) {
        symbols.push(i2);
      }
    }
    const symbolsAddress = C._malloc(SIZE_OF_INT * symbols.length);
    for (let i2 = 0, n = symbols.length; i2 < n; i2++) {
      C.setValue(symbolsAddress + i2 * SIZE_OF_INT, symbols[i2], "i32");
    }
    marshalNode(this);
    C._ts_node_descendants_of_type_wasm(
      this.tree[0],
      symbolsAddress,
      symbols.length,
      startPosition.row,
      startPosition.column,
      endPosition.row,
      endPosition.column
    );
    const descendantCount = C.getValue(TRANSFER_BUFFER, "i32");
    const descendantAddress = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    const result = new Array(descendantCount);
    if (descendantCount > 0) {
      let address = descendantAddress;
      for (let i2 = 0; i2 < descendantCount; i2++) {
        result[i2] = unmarshalNode(this.tree, address);
        address += SIZE_OF_NODE;
      }
    }
    C._free(descendantAddress);
    C._free(symbolsAddress);
    return result;
  }
  /** Get this node's next sibling. */
  get nextSibling() {
    marshalNode(this);
    C._ts_node_next_sibling_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /** Get this node's previous sibling. */
  get previousSibling() {
    marshalNode(this);
    C._ts_node_prev_sibling_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /**
   * Get this node's next *named* sibling.
   *
   * See also {@link Node#isNamed}.
   */
  get nextNamedSibling() {
    marshalNode(this);
    C._ts_node_next_named_sibling_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /**
   * Get this node's previous *named* sibling.
   *
   * See also {@link Node#isNamed}.
   */
  get previousNamedSibling() {
    marshalNode(this);
    C._ts_node_prev_named_sibling_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /** Get the node's number of descendants, including one for the node itself. */
  get descendantCount() {
    marshalNode(this);
    return C._ts_node_descendant_count_wasm(this.tree[0]);
  }
  /**
   * Get this node's immediate parent.
   * Prefer {@link Node#childWithDescendant} for iterating over this node's ancestors.
   */
  get parent() {
    marshalNode(this);
    C._ts_node_parent_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /**
   * Get the node that contains `descendant`.
   *
   * Note that this can return `descendant` itself.
   */
  childWithDescendant(descendant) {
    marshalNode(this);
    marshalNode(descendant, 1);
    C._ts_node_child_with_descendant_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /** Get the smallest node within this node that spans the given byte range. */
  descendantForIndex(start22, end = start22) {
    if (typeof start22 !== "number" || typeof end !== "number") {
      throw new Error("Arguments must be numbers");
    }
    marshalNode(this);
    const address = TRANSFER_BUFFER + SIZE_OF_NODE;
    C.setValue(address, start22, "i32");
    C.setValue(address + SIZE_OF_INT, end, "i32");
    C._ts_node_descendant_for_index_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /** Get the smallest named node within this node that spans the given byte range. */
  namedDescendantForIndex(start22, end = start22) {
    if (typeof start22 !== "number" || typeof end !== "number") {
      throw new Error("Arguments must be numbers");
    }
    marshalNode(this);
    const address = TRANSFER_BUFFER + SIZE_OF_NODE;
    C.setValue(address, start22, "i32");
    C.setValue(address + SIZE_OF_INT, end, "i32");
    C._ts_node_named_descendant_for_index_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /** Get the smallest node within this node that spans the given point range. */
  descendantForPosition(start22, end = start22) {
    if (!isPoint(start22) || !isPoint(end)) {
      throw new Error("Arguments must be {row, column} objects");
    }
    marshalNode(this);
    const address = TRANSFER_BUFFER + SIZE_OF_NODE;
    marshalPoint(address, start22);
    marshalPoint(address + SIZE_OF_POINT, end);
    C._ts_node_descendant_for_position_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /** Get the smallest named node within this node that spans the given point range. */
  namedDescendantForPosition(start22, end = start22) {
    if (!isPoint(start22) || !isPoint(end)) {
      throw new Error("Arguments must be {row, column} objects");
    }
    marshalNode(this);
    const address = TRANSFER_BUFFER + SIZE_OF_NODE;
    marshalPoint(address, start22);
    marshalPoint(address + SIZE_OF_POINT, end);
    C._ts_node_named_descendant_for_position_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /**
   * Create a new {@link TreeCursor} starting from this node.
   *
   * Note that the given node is considered the root of the cursor,
   * and the cursor cannot walk outside this node.
   */
  walk() {
    marshalNode(this);
    C._ts_tree_cursor_new_wasm(this.tree[0]);
    return new TreeCursor(INTERNAL, this.tree);
  }
  /**
   * Edit this node to keep it in-sync with source code that has been edited.
   *
   * This function is only rarely needed. When you edit a syntax tree with
   * the {@link Tree#edit} method, all of the nodes that you retrieve from
   * the tree afterward will already reflect the edit. You only need to
   * use {@link Node#edit} when you have a specific {@link Node} instance that
   * you want to keep and continue to use after an edit.
   */
  edit(edit) {
    if (this.startIndex >= edit.oldEndIndex) {
      this.startIndex = edit.newEndIndex + (this.startIndex - edit.oldEndIndex);
      let subbedPointRow;
      let subbedPointColumn;
      if (this.startPosition.row > edit.oldEndPosition.row) {
        subbedPointRow = this.startPosition.row - edit.oldEndPosition.row;
        subbedPointColumn = this.startPosition.column;
      } else {
        subbedPointRow = 0;
        subbedPointColumn = this.startPosition.column;
        if (this.startPosition.column >= edit.oldEndPosition.column) {
          subbedPointColumn = this.startPosition.column - edit.oldEndPosition.column;
        }
      }
      if (subbedPointRow > 0) {
        this.startPosition.row += subbedPointRow;
        this.startPosition.column = subbedPointColumn;
      } else {
        this.startPosition.column += subbedPointColumn;
      }
    } else if (this.startIndex > edit.startIndex) {
      this.startIndex = edit.newEndIndex;
      this.startPosition.row = edit.newEndPosition.row;
      this.startPosition.column = edit.newEndPosition.column;
    }
  }
  /** Get the S-expression representation of this node. */
  toString() {
    marshalNode(this);
    const address = C._ts_node_to_string_wasm(this.tree[0]);
    const result = C.AsciiToString(address);
    C._free(address);
    return result;
  }
};
function unmarshalCaptures(query, tree, address, patternIndex, result) {
  for (let i2 = 0, n = result.length; i2 < n; i2++) {
    const captureIndex = C.getValue(address, "i32");
    address += SIZE_OF_INT;
    const node = unmarshalNode(tree, address);
    address += SIZE_OF_NODE;
    result[i2] = { patternIndex, name: query.captureNames[captureIndex], node };
  }
  return address;
}
__name(unmarshalCaptures, "unmarshalCaptures");
function marshalNode(node, index = 0) {
  let address = TRANSFER_BUFFER + index * SIZE_OF_NODE;
  C.setValue(address, node.id, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, node.startIndex, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, node.startPosition.row, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, node.startPosition.column, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, node[0], "i32");
}
__name(marshalNode, "marshalNode");
function unmarshalNode(tree, address = TRANSFER_BUFFER) {
  const id = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  if (id === 0) return null;
  const index = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  const row = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  const column = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  const other = C.getValue(address, "i32");
  const result = new Node(INTERNAL, {
    id,
    tree,
    startIndex: index,
    startPosition: { row, column },
    other
  });
  return result;
}
__name(unmarshalNode, "unmarshalNode");
function marshalTreeCursor(cursor, address = TRANSFER_BUFFER) {
  C.setValue(address + 0 * SIZE_OF_INT, cursor[0], "i32");
  C.setValue(address + 1 * SIZE_OF_INT, cursor[1], "i32");
  C.setValue(address + 2 * SIZE_OF_INT, cursor[2], "i32");
  C.setValue(address + 3 * SIZE_OF_INT, cursor[3], "i32");
}
__name(marshalTreeCursor, "marshalTreeCursor");
function unmarshalTreeCursor(cursor) {
  cursor[0] = C.getValue(TRANSFER_BUFFER + 0 * SIZE_OF_INT, "i32");
  cursor[1] = C.getValue(TRANSFER_BUFFER + 1 * SIZE_OF_INT, "i32");
  cursor[2] = C.getValue(TRANSFER_BUFFER + 2 * SIZE_OF_INT, "i32");
  cursor[3] = C.getValue(TRANSFER_BUFFER + 3 * SIZE_OF_INT, "i32");
}
__name(unmarshalTreeCursor, "unmarshalTreeCursor");
function marshalPoint(address, point) {
  C.setValue(address, point.row, "i32");
  C.setValue(address + SIZE_OF_INT, point.column, "i32");
}
__name(marshalPoint, "marshalPoint");
function unmarshalPoint(address) {
  const result = {
    row: C.getValue(address, "i32") >>> 0,
    column: C.getValue(address + SIZE_OF_INT, "i32") >>> 0
  };
  return result;
}
__name(unmarshalPoint, "unmarshalPoint");
function marshalRange(address, range) {
  marshalPoint(address, range.startPosition);
  address += SIZE_OF_POINT;
  marshalPoint(address, range.endPosition);
  address += SIZE_OF_POINT;
  C.setValue(address, range.startIndex, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, range.endIndex, "i32");
  address += SIZE_OF_INT;
}
__name(marshalRange, "marshalRange");
function unmarshalRange(address) {
  const result = {};
  result.startPosition = unmarshalPoint(address);
  address += SIZE_OF_POINT;
  result.endPosition = unmarshalPoint(address);
  address += SIZE_OF_POINT;
  result.startIndex = C.getValue(address, "i32") >>> 0;
  address += SIZE_OF_INT;
  result.endIndex = C.getValue(address, "i32") >>> 0;
  return result;
}
__name(unmarshalRange, "unmarshalRange");
function marshalEdit(edit, address = TRANSFER_BUFFER) {
  marshalPoint(address, edit.startPosition);
  address += SIZE_OF_POINT;
  marshalPoint(address, edit.oldEndPosition);
  address += SIZE_OF_POINT;
  marshalPoint(address, edit.newEndPosition);
  address += SIZE_OF_POINT;
  C.setValue(address, edit.startIndex, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, edit.oldEndIndex, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, edit.newEndIndex, "i32");
  address += SIZE_OF_INT;
}
__name(marshalEdit, "marshalEdit");
function unmarshalLanguageMetadata(address) {
  const major_version = C.getValue(address, "i32");
  const minor_version = C.getValue(address += SIZE_OF_INT, "i32");
  const patch_version = C.getValue(address += SIZE_OF_INT, "i32");
  return { major_version, minor_version, patch_version };
}
__name(unmarshalLanguageMetadata, "unmarshalLanguageMetadata");
var PREDICATE_STEP_TYPE_CAPTURE = 1;
var PREDICATE_STEP_TYPE_STRING = 2;
var QUERY_WORD_REGEX = /[\w-]+/g;
var CaptureQuantifier = {
  Zero: 0,
  ZeroOrOne: 1,
  ZeroOrMore: 2,
  One: 3,
  OneOrMore: 4
};
var isCaptureStep = /* @__PURE__ */ __name((step) => step.type === "capture", "isCaptureStep");
var isStringStep = /* @__PURE__ */ __name((step) => step.type === "string", "isStringStep");
var QueryErrorKind = {
  Syntax: 1,
  NodeName: 2,
  FieldName: 3,
  CaptureName: 4,
  PatternStructure: 5
};
var QueryError = class _QueryError extends Error {
  constructor(kind, info2, index, length) {
    super(_QueryError.formatMessage(kind, info2));
    this.kind = kind;
    this.info = info2;
    this.index = index;
    this.length = length;
    this.name = "QueryError";
  }
  static {
    __name(this, "QueryError");
  }
  /** Formats an error message based on the error kind and info */
  static formatMessage(kind, info2) {
    switch (kind) {
      case QueryErrorKind.NodeName:
        return `Bad node name '${info2.word}'`;
      case QueryErrorKind.FieldName:
        return `Bad field name '${info2.word}'`;
      case QueryErrorKind.CaptureName:
        return `Bad capture name @${info2.word}`;
      case QueryErrorKind.PatternStructure:
        return `Bad pattern structure at offset ${info2.suffix}`;
      case QueryErrorKind.Syntax:
        return `Bad syntax at offset ${info2.suffix}`;
    }
  }
};
function parseAnyPredicate(steps, index, operator, textPredicates) {
  if (steps.length !== 3) {
    throw new Error(
      `Wrong number of arguments to \`#${operator}\` predicate. Expected 2, got ${steps.length - 1}`
    );
  }
  if (!isCaptureStep(steps[1])) {
    throw new Error(
      `First argument of \`#${operator}\` predicate must be a capture. Got "${steps[1].value}"`
    );
  }
  const isPositive = operator === "eq?" || operator === "any-eq?";
  const matchAll = !operator.startsWith("any-");
  if (isCaptureStep(steps[2])) {
    const captureName1 = steps[1].name;
    const captureName2 = steps[2].name;
    textPredicates[index].push((captures) => {
      const nodes1 = [];
      const nodes2 = [];
      for (const c of captures) {
        if (c.name === captureName1) nodes1.push(c.node);
        if (c.name === captureName2) nodes2.push(c.node);
      }
      const compare = /* @__PURE__ */ __name((n1, n2, positive) => {
        return positive ? n1.text === n2.text : n1.text !== n2.text;
      }, "compare");
      return matchAll ? nodes1.every((n1) => nodes2.some((n2) => compare(n1, n2, isPositive))) : nodes1.some((n1) => nodes2.some((n2) => compare(n1, n2, isPositive)));
    });
  } else {
    const captureName = steps[1].name;
    const stringValue = steps[2].value;
    const matches = /* @__PURE__ */ __name((n) => n.text === stringValue, "matches");
    const doesNotMatch = /* @__PURE__ */ __name((n) => n.text !== stringValue, "doesNotMatch");
    textPredicates[index].push((captures) => {
      const nodes = [];
      for (const c of captures) {
        if (c.name === captureName) nodes.push(c.node);
      }
      const test = isPositive ? matches : doesNotMatch;
      return matchAll ? nodes.every(test) : nodes.some(test);
    });
  }
}
__name(parseAnyPredicate, "parseAnyPredicate");
function parseMatchPredicate(steps, index, operator, textPredicates) {
  if (steps.length !== 3) {
    throw new Error(
      `Wrong number of arguments to \`#${operator}\` predicate. Expected 2, got ${steps.length - 1}.`
    );
  }
  if (steps[1].type !== "capture") {
    throw new Error(
      `First argument of \`#${operator}\` predicate must be a capture. Got "${steps[1].value}".`
    );
  }
  if (steps[2].type !== "string") {
    throw new Error(
      `Second argument of \`#${operator}\` predicate must be a string. Got @${steps[2].name}.`
    );
  }
  const isPositive = operator === "match?" || operator === "any-match?";
  const matchAll = !operator.startsWith("any-");
  const captureName = steps[1].name;
  const regex = new RegExp(steps[2].value);
  textPredicates[index].push((captures) => {
    const nodes = [];
    for (const c of captures) {
      if (c.name === captureName) nodes.push(c.node.text);
    }
    const test = /* @__PURE__ */ __name((text, positive) => {
      return positive ? regex.test(text) : !regex.test(text);
    }, "test");
    if (nodes.length === 0) return !isPositive;
    return matchAll ? nodes.every((text) => test(text, isPositive)) : nodes.some((text) => test(text, isPositive));
  });
}
__name(parseMatchPredicate, "parseMatchPredicate");
function parseAnyOfPredicate(steps, index, operator, textPredicates) {
  if (steps.length < 2) {
    throw new Error(
      `Wrong number of arguments to \`#${operator}\` predicate. Expected at least 1. Got ${steps.length - 1}.`
    );
  }
  if (steps[1].type !== "capture") {
    throw new Error(
      `First argument of \`#${operator}\` predicate must be a capture. Got "${steps[1].value}".`
    );
  }
  const isPositive = operator === "any-of?";
  const captureName = steps[1].name;
  const stringSteps = steps.slice(2);
  if (!stringSteps.every(isStringStep)) {
    throw new Error(
      `Arguments to \`#${operator}\` predicate must be strings.".`
    );
  }
  const values = stringSteps.map((s) => s.value);
  textPredicates[index].push((captures) => {
    const nodes = [];
    for (const c of captures) {
      if (c.name === captureName) nodes.push(c.node.text);
    }
    if (nodes.length === 0) return !isPositive;
    return nodes.every((text) => values.includes(text)) === isPositive;
  });
}
__name(parseAnyOfPredicate, "parseAnyOfPredicate");
function parseIsPredicate(steps, index, operator, assertedProperties, refutedProperties) {
  if (steps.length < 2 || steps.length > 3) {
    throw new Error(
      `Wrong number of arguments to \`#${operator}\` predicate. Expected 1 or 2. Got ${steps.length - 1}.`
    );
  }
  if (!steps.every(isStringStep)) {
    throw new Error(
      `Arguments to \`#${operator}\` predicate must be strings.".`
    );
  }
  const properties = operator === "is?" ? assertedProperties : refutedProperties;
  if (!properties[index]) properties[index] = {};
  properties[index][steps[1].value] = steps[2]?.value ?? null;
}
__name(parseIsPredicate, "parseIsPredicate");
function parseSetDirective(steps, index, setProperties) {
  if (steps.length < 2 || steps.length > 3) {
    throw new Error(`Wrong number of arguments to \`#set!\` predicate. Expected 1 or 2. Got ${steps.length - 1}.`);
  }
  if (!steps.every(isStringStep)) {
    throw new Error(`Arguments to \`#set!\` predicate must be strings.".`);
  }
  if (!setProperties[index]) setProperties[index] = {};
  setProperties[index][steps[1].value] = steps[2]?.value ?? null;
}
__name(parseSetDirective, "parseSetDirective");
function parsePattern(index, stepType, stepValueId, captureNames, stringValues, steps, textPredicates, predicates, setProperties, assertedProperties, refutedProperties) {
  if (stepType === PREDICATE_STEP_TYPE_CAPTURE) {
    const name2 = captureNames[stepValueId];
    steps.push({ type: "capture", name: name2 });
  } else if (stepType === PREDICATE_STEP_TYPE_STRING) {
    steps.push({ type: "string", value: stringValues[stepValueId] });
  } else if (steps.length > 0) {
    if (steps[0].type !== "string") {
      throw new Error("Predicates must begin with a literal value");
    }
    const operator = steps[0].value;
    switch (operator) {
      case "any-not-eq?":
      case "not-eq?":
      case "any-eq?":
      case "eq?":
        parseAnyPredicate(steps, index, operator, textPredicates);
        break;
      case "any-not-match?":
      case "not-match?":
      case "any-match?":
      case "match?":
        parseMatchPredicate(steps, index, operator, textPredicates);
        break;
      case "not-any-of?":
      case "any-of?":
        parseAnyOfPredicate(steps, index, operator, textPredicates);
        break;
      case "is?":
      case "is-not?":
        parseIsPredicate(steps, index, operator, assertedProperties, refutedProperties);
        break;
      case "set!":
        parseSetDirective(steps, index, setProperties);
        break;
      default:
        predicates[index].push({ operator, operands: steps.slice(1) });
    }
    steps.length = 0;
  }
}
__name(parsePattern, "parsePattern");
var Query = class {
  static {
    __name(this, "Query");
  }
  /** @internal */
  [0] = 0;
  // Internal handle for WASM
  /** @internal */
  exceededMatchLimit;
  /** @internal */
  textPredicates;
  /** The names of the captures used in the query. */
  captureNames;
  /** The quantifiers of the captures used in the query. */
  captureQuantifiers;
  /**
   * The other user-defined predicates associated with the given index.
   *
   * This includes predicates with operators other than:
   * - `match?`
   * - `eq?` and `not-eq?`
   * - `any-of?` and `not-any-of?`
   * - `is?` and `is-not?`
   * - `set!`
   */
  predicates;
  /** The properties for predicates with the operator `set!`. */
  setProperties;
  /** The properties for predicates with the operator `is?`. */
  assertedProperties;
  /** The properties for predicates with the operator `is-not?`. */
  refutedProperties;
  /** The maximum number of in-progress matches for this cursor. */
  matchLimit;
  /**
   * Create a new query from a string containing one or more S-expression
   * patterns.
   *
   * The query is associated with a particular language, and can only be run
   * on syntax nodes parsed with that language. References to Queries can be
   * shared between multiple threads.
   *
   * @link {@see https://tree-sitter.github.io/tree-sitter/using-parsers/queries}
   */
  constructor(language, source) {
    const sourceLength = C.lengthBytesUTF8(source);
    const sourceAddress = C._malloc(sourceLength + 1);
    C.stringToUTF8(source, sourceAddress, sourceLength + 1);
    const address = C._ts_query_new(
      language[0],
      sourceAddress,
      sourceLength,
      TRANSFER_BUFFER,
      TRANSFER_BUFFER + SIZE_OF_INT
    );
    if (!address) {
      const errorId = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
      const errorByte = C.getValue(TRANSFER_BUFFER, "i32");
      const errorIndex = C.UTF8ToString(sourceAddress, errorByte).length;
      const suffix = source.slice(errorIndex, errorIndex + 100).split("\n")[0];
      const word = suffix.match(QUERY_WORD_REGEX)?.[0] ?? "";
      C._free(sourceAddress);
      switch (errorId) {
        case QueryErrorKind.Syntax:
          throw new QueryError(QueryErrorKind.Syntax, { suffix: `${errorIndex}: '${suffix}'...` }, errorIndex, 0);
        case QueryErrorKind.NodeName:
          throw new QueryError(errorId, { word }, errorIndex, word.length);
        case QueryErrorKind.FieldName:
          throw new QueryError(errorId, { word }, errorIndex, word.length);
        case QueryErrorKind.CaptureName:
          throw new QueryError(errorId, { word }, errorIndex, word.length);
        case QueryErrorKind.PatternStructure:
          throw new QueryError(errorId, { suffix: `${errorIndex}: '${suffix}'...` }, errorIndex, 0);
      }
    }
    const stringCount = C._ts_query_string_count(address);
    const captureCount = C._ts_query_capture_count(address);
    const patternCount = C._ts_query_pattern_count(address);
    const captureNames = new Array(captureCount);
    const captureQuantifiers = new Array(patternCount);
    const stringValues = new Array(stringCount);
    for (let i2 = 0; i2 < captureCount; i2++) {
      const nameAddress = C._ts_query_capture_name_for_id(
        address,
        i2,
        TRANSFER_BUFFER
      );
      const nameLength = C.getValue(TRANSFER_BUFFER, "i32");
      captureNames[i2] = C.UTF8ToString(nameAddress, nameLength);
    }
    for (let i2 = 0; i2 < patternCount; i2++) {
      const captureQuantifiersArray = new Array(captureCount);
      for (let j = 0; j < captureCount; j++) {
        const quantifier = C._ts_query_capture_quantifier_for_id(address, i2, j);
        captureQuantifiersArray[j] = quantifier;
      }
      captureQuantifiers[i2] = captureQuantifiersArray;
    }
    for (let i2 = 0; i2 < stringCount; i2++) {
      const valueAddress = C._ts_query_string_value_for_id(
        address,
        i2,
        TRANSFER_BUFFER
      );
      const nameLength = C.getValue(TRANSFER_BUFFER, "i32");
      stringValues[i2] = C.UTF8ToString(valueAddress, nameLength);
    }
    const setProperties = new Array(patternCount);
    const assertedProperties = new Array(patternCount);
    const refutedProperties = new Array(patternCount);
    const predicates = new Array(patternCount);
    const textPredicates = new Array(patternCount);
    for (let i2 = 0; i2 < patternCount; i2++) {
      const predicatesAddress = C._ts_query_predicates_for_pattern(address, i2, TRANSFER_BUFFER);
      const stepCount = C.getValue(TRANSFER_BUFFER, "i32");
      predicates[i2] = [];
      textPredicates[i2] = [];
      const steps = new Array();
      let stepAddress = predicatesAddress;
      for (let j = 0; j < stepCount; j++) {
        const stepType = C.getValue(stepAddress, "i32");
        stepAddress += SIZE_OF_INT;
        const stepValueId = C.getValue(stepAddress, "i32");
        stepAddress += SIZE_OF_INT;
        parsePattern(
          i2,
          stepType,
          stepValueId,
          captureNames,
          stringValues,
          steps,
          textPredicates,
          predicates,
          setProperties,
          assertedProperties,
          refutedProperties
        );
      }
      Object.freeze(textPredicates[i2]);
      Object.freeze(predicates[i2]);
      Object.freeze(setProperties[i2]);
      Object.freeze(assertedProperties[i2]);
      Object.freeze(refutedProperties[i2]);
    }
    C._free(sourceAddress);
    this[0] = address;
    this.captureNames = captureNames;
    this.captureQuantifiers = captureQuantifiers;
    this.textPredicates = textPredicates;
    this.predicates = predicates;
    this.setProperties = setProperties;
    this.assertedProperties = assertedProperties;
    this.refutedProperties = refutedProperties;
    this.exceededMatchLimit = false;
  }
  /** Delete the query, freeing its resources. */
  delete() {
    C._ts_query_delete(this[0]);
    this[0] = 0;
  }
  /**
   * Iterate over all of the matches in the order that they were found.
   *
   * Each match contains the index of the pattern that matched, and a list of
   * captures. Because multiple patterns can match the same set of nodes,
   * one match may contain captures that appear *before* some of the
   * captures from a previous match.
   *
   * @param {Node} node - The node to execute the query on.
   *
   * @param {QueryOptions} options - Options for query execution.
   */
  matches(node, options = {}) {
    const startPosition = options.startPosition ?? ZERO_POINT;
    const endPosition = options.endPosition ?? ZERO_POINT;
    const startIndex = options.startIndex ?? 0;
    const endIndex = options.endIndex ?? 0;
    const matchLimit = options.matchLimit ?? 4294967295;
    const maxStartDepth = options.maxStartDepth ?? 4294967295;
    const timeoutMicros = options.timeoutMicros ?? 0;
    const progressCallback = options.progressCallback;
    if (typeof matchLimit !== "number") {
      throw new Error("Arguments must be numbers");
    }
    this.matchLimit = matchLimit;
    if (endIndex !== 0 && startIndex > endIndex) {
      throw new Error("`startIndex` cannot be greater than `endIndex`");
    }
    if (endPosition !== ZERO_POINT && (startPosition.row > endPosition.row || startPosition.row === endPosition.row && startPosition.column > endPosition.column)) {
      throw new Error("`startPosition` cannot be greater than `endPosition`");
    }
    if (progressCallback) {
      C.currentQueryProgressCallback = progressCallback;
    }
    marshalNode(node);
    C._ts_query_matches_wasm(
      this[0],
      node.tree[0],
      startPosition.row,
      startPosition.column,
      endPosition.row,
      endPosition.column,
      startIndex,
      endIndex,
      matchLimit,
      maxStartDepth,
      timeoutMicros
    );
    const rawCount = C.getValue(TRANSFER_BUFFER, "i32");
    const startAddress = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    const didExceedMatchLimit = C.getValue(TRANSFER_BUFFER + 2 * SIZE_OF_INT, "i32");
    const result = new Array(rawCount);
    this.exceededMatchLimit = Boolean(didExceedMatchLimit);
    let filteredCount = 0;
    let address = startAddress;
    for (let i2 = 0; i2 < rawCount; i2++) {
      const patternIndex = C.getValue(address, "i32");
      address += SIZE_OF_INT;
      const captureCount = C.getValue(address, "i32");
      address += SIZE_OF_INT;
      const captures = new Array(captureCount);
      address = unmarshalCaptures(this, node.tree, address, patternIndex, captures);
      if (this.textPredicates[patternIndex].every((p) => p(captures))) {
        result[filteredCount] = { pattern: patternIndex, patternIndex, captures };
        const setProperties = this.setProperties[patternIndex];
        result[filteredCount].setProperties = setProperties;
        const assertedProperties = this.assertedProperties[patternIndex];
        result[filteredCount].assertedProperties = assertedProperties;
        const refutedProperties = this.refutedProperties[patternIndex];
        result[filteredCount].refutedProperties = refutedProperties;
        filteredCount++;
      }
    }
    result.length = filteredCount;
    C._free(startAddress);
    C.currentQueryProgressCallback = null;
    return result;
  }
  /**
   * Iterate over all of the individual captures in the order that they
   * appear.
   *
   * This is useful if you don't care about which pattern matched, and just
   * want a single, ordered sequence of captures.
   *
   * @param {Node} node - The node to execute the query on.
   *
   * @param {QueryOptions} options - Options for query execution.
   */
  captures(node, options = {}) {
    const startPosition = options.startPosition ?? ZERO_POINT;
    const endPosition = options.endPosition ?? ZERO_POINT;
    const startIndex = options.startIndex ?? 0;
    const endIndex = options.endIndex ?? 0;
    const matchLimit = options.matchLimit ?? 4294967295;
    const maxStartDepth = options.maxStartDepth ?? 4294967295;
    const timeoutMicros = options.timeoutMicros ?? 0;
    const progressCallback = options.progressCallback;
    if (typeof matchLimit !== "number") {
      throw new Error("Arguments must be numbers");
    }
    this.matchLimit = matchLimit;
    if (endIndex !== 0 && startIndex > endIndex) {
      throw new Error("`startIndex` cannot be greater than `endIndex`");
    }
    if (endPosition !== ZERO_POINT && (startPosition.row > endPosition.row || startPosition.row === endPosition.row && startPosition.column > endPosition.column)) {
      throw new Error("`startPosition` cannot be greater than `endPosition`");
    }
    if (progressCallback) {
      C.currentQueryProgressCallback = progressCallback;
    }
    marshalNode(node);
    C._ts_query_captures_wasm(
      this[0],
      node.tree[0],
      startPosition.row,
      startPosition.column,
      endPosition.row,
      endPosition.column,
      startIndex,
      endIndex,
      matchLimit,
      maxStartDepth,
      timeoutMicros
    );
    const count = C.getValue(TRANSFER_BUFFER, "i32");
    const startAddress = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    const didExceedMatchLimit = C.getValue(TRANSFER_BUFFER + 2 * SIZE_OF_INT, "i32");
    const result = new Array();
    this.exceededMatchLimit = Boolean(didExceedMatchLimit);
    const captures = new Array();
    let address = startAddress;
    for (let i2 = 0; i2 < count; i2++) {
      const patternIndex = C.getValue(address, "i32");
      address += SIZE_OF_INT;
      const captureCount = C.getValue(address, "i32");
      address += SIZE_OF_INT;
      const captureIndex = C.getValue(address, "i32");
      address += SIZE_OF_INT;
      captures.length = captureCount;
      address = unmarshalCaptures(this, node.tree, address, patternIndex, captures);
      if (this.textPredicates[patternIndex].every((p) => p(captures))) {
        const capture = captures[captureIndex];
        const setProperties = this.setProperties[patternIndex];
        capture.setProperties = setProperties;
        const assertedProperties = this.assertedProperties[patternIndex];
        capture.assertedProperties = assertedProperties;
        const refutedProperties = this.refutedProperties[patternIndex];
        capture.refutedProperties = refutedProperties;
        result.push(capture);
      }
    }
    C._free(startAddress);
    C.currentQueryProgressCallback = null;
    return result;
  }
  /** Get the predicates for a given pattern. */
  predicatesForPattern(patternIndex) {
    return this.predicates[patternIndex];
  }
  /**
   * Disable a certain capture within a query.
   *
   * This prevents the capture from being returned in matches, and also
   * avoids any resource usage associated with recording the capture.
   */
  disableCapture(captureName) {
    const captureNameLength = C.lengthBytesUTF8(captureName);
    const captureNameAddress = C._malloc(captureNameLength + 1);
    C.stringToUTF8(captureName, captureNameAddress, captureNameLength + 1);
    C._ts_query_disable_capture(this[0], captureNameAddress, captureNameLength);
    C._free(captureNameAddress);
  }
  /**
   * Disable a certain pattern within a query.
   *
   * This prevents the pattern from matching, and also avoids any resource
   * usage associated with the pattern. This throws an error if the pattern
   * index is out of bounds.
   */
  disablePattern(patternIndex) {
    if (patternIndex >= this.predicates.length) {
      throw new Error(
        `Pattern index is ${patternIndex} but the pattern count is ${this.predicates.length}`
      );
    }
    C._ts_query_disable_pattern(this[0], patternIndex);
  }
  /**
   * Check if, on its last execution, this cursor exceeded its maximum number
   * of in-progress matches.
   */
  didExceedMatchLimit() {
    return this.exceededMatchLimit;
  }
  /** Get the byte offset where the given pattern starts in the query's source. */
  startIndexForPattern(patternIndex) {
    if (patternIndex >= this.predicates.length) {
      throw new Error(
        `Pattern index is ${patternIndex} but the pattern count is ${this.predicates.length}`
      );
    }
    return C._ts_query_start_byte_for_pattern(this[0], patternIndex);
  }
  /** Get the byte offset where the given pattern ends in the query's source. */
  endIndexForPattern(patternIndex) {
    if (patternIndex >= this.predicates.length) {
      throw new Error(
        `Pattern index is ${patternIndex} but the pattern count is ${this.predicates.length}`
      );
    }
    return C._ts_query_end_byte_for_pattern(this[0], patternIndex);
  }
  /** Get the number of patterns in the query. */
  patternCount() {
    return C._ts_query_pattern_count(this[0]);
  }
  /** Get the index for a given capture name. */
  captureIndexForName(captureName) {
    return this.captureNames.indexOf(captureName);
  }
  /** Check if a given pattern within a query has a single root node. */
  isPatternRooted(patternIndex) {
    return C._ts_query_is_pattern_rooted(this[0], patternIndex) === 1;
  }
  /** Check if a given pattern within a query has a single root node. */
  isPatternNonLocal(patternIndex) {
    return C._ts_query_is_pattern_non_local(this[0], patternIndex) === 1;
  }
  /**
   * Check if a given step in a query is 'definite'.
   *
   * A query step is 'definite' if its parent pattern will be guaranteed to
   * match successfully once it reaches the step.
   */
  isPatternGuaranteedAtStep(byteIndex) {
    return C._ts_query_is_pattern_guaranteed_at_step(this[0], byteIndex) === 1;
  }
};
var LANGUAGE_FUNCTION_REGEX = /^tree_sitter_\w+$/;
var Language = class _Language {
  static {
    __name(this, "Language");
  }
  /** @internal */
  [0] = 0;
  // Internal handle for WASM
  /**
   * A list of all node types in the language. The index of each type in this
   * array is its node type id.
   */
  types;
  /**
   * A list of all field names in the language. The index of each field name in
   * this array is its field id.
   */
  fields;
  /** @internal */
  constructor(internal, address) {
    assertInternal(internal);
    this[0] = address;
    this.types = new Array(C._ts_language_symbol_count(this[0]));
    for (let i2 = 0, n = this.types.length; i2 < n; i2++) {
      if (C._ts_language_symbol_type(this[0], i2) < 2) {
        this.types[i2] = C.UTF8ToString(C._ts_language_symbol_name(this[0], i2));
      }
    }
    this.fields = new Array(C._ts_language_field_count(this[0]) + 1);
    for (let i2 = 0, n = this.fields.length; i2 < n; i2++) {
      const fieldName = C._ts_language_field_name_for_id(this[0], i2);
      if (fieldName !== 0) {
        this.fields[i2] = C.UTF8ToString(fieldName);
      } else {
        this.fields[i2] = null;
      }
    }
  }
  /**
   * Gets the name of the language.
   */
  get name() {
    const ptr = C._ts_language_name(this[0]);
    if (ptr === 0) return null;
    return C.UTF8ToString(ptr);
  }
  /**
   * @deprecated since version 0.25.0, use {@link Language#abiVersion} instead
   * Gets the version of the language.
   */
  get version() {
    return C._ts_language_version(this[0]);
  }
  /**
   * Gets the ABI version of the language.
   */
  get abiVersion() {
    return C._ts_language_abi_version(this[0]);
  }
  /**
  * Get the metadata for this language. This information is generated by the
  * CLI, and relies on the language author providing the correct metadata in
  * the language's `tree-sitter.json` file.
  */
  get metadata() {
    C._ts_language_metadata(this[0]);
    const length = C.getValue(TRANSFER_BUFFER, "i32");
    const address = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    if (length === 0) return null;
    return unmarshalLanguageMetadata(address);
  }
  /**
   * Gets the number of fields in the language.
   */
  get fieldCount() {
    return this.fields.length - 1;
  }
  /**
   * Gets the number of states in the language.
   */
  get stateCount() {
    return C._ts_language_state_count(this[0]);
  }
  /**
   * Get the field id for a field name.
   */
  fieldIdForName(fieldName) {
    const result = this.fields.indexOf(fieldName);
    return result !== -1 ? result : null;
  }
  /**
   * Get the field name for a field id.
   */
  fieldNameForId(fieldId) {
    return this.fields[fieldId] ?? null;
  }
  /**
   * Get the node type id for a node type name.
   */
  idForNodeType(type, named) {
    const typeLength = C.lengthBytesUTF8(type);
    const typeAddress = C._malloc(typeLength + 1);
    C.stringToUTF8(type, typeAddress, typeLength + 1);
    const result = C._ts_language_symbol_for_name(this[0], typeAddress, typeLength, named ? 1 : 0);
    C._free(typeAddress);
    return result || null;
  }
  /**
   * Gets the number of node types in the language.
   */
  get nodeTypeCount() {
    return C._ts_language_symbol_count(this[0]);
  }
  /**
   * Get the node type name for a node type id.
   */
  nodeTypeForId(typeId) {
    const name2 = C._ts_language_symbol_name(this[0], typeId);
    return name2 ? C.UTF8ToString(name2) : null;
  }
  /**
   * Check if a node type is named.
   *
   * @see {@link https://tree-sitter.github.io/tree-sitter/using-parsers/2-basic-parsing.html#named-vs-anonymous-nodes}
   */
  nodeTypeIsNamed(typeId) {
    return C._ts_language_type_is_named_wasm(this[0], typeId) ? true : false;
  }
  /**
   * Check if a node type is visible.
   */
  nodeTypeIsVisible(typeId) {
    return C._ts_language_type_is_visible_wasm(this[0], typeId) ? true : false;
  }
  /**
   * Get the supertypes ids of this language.
   *
   * @see {@link https://tree-sitter.github.io/tree-sitter/using-parsers/6-static-node-types.html?highlight=supertype#supertype-nodes}
   */
  get supertypes() {
    C._ts_language_supertypes_wasm(this[0]);
    const count = C.getValue(TRANSFER_BUFFER, "i32");
    const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    const result = new Array(count);
    if (count > 0) {
      let address = buffer;
      for (let i2 = 0; i2 < count; i2++) {
        result[i2] = C.getValue(address, "i16");
        address += SIZE_OF_SHORT;
      }
    }
    return result;
  }
  /**
   * Get the subtype ids for a given supertype node id.
   */
  subtypes(supertype) {
    C._ts_language_subtypes_wasm(this[0], supertype);
    const count = C.getValue(TRANSFER_BUFFER, "i32");
    const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    const result = new Array(count);
    if (count > 0) {
      let address = buffer;
      for (let i2 = 0; i2 < count; i2++) {
        result[i2] = C.getValue(address, "i16");
        address += SIZE_OF_SHORT;
      }
    }
    return result;
  }
  /**
   * Get the next state id for a given state id and node type id.
   */
  nextState(stateId, typeId) {
    return C._ts_language_next_state(this[0], stateId, typeId);
  }
  /**
   * Create a new lookahead iterator for this language and parse state.
   *
   * This returns `null` if state is invalid for this language.
   *
   * Iterating {@link LookaheadIterator} will yield valid symbols in the given
   * parse state. Newly created lookahead iterators will return the `ERROR`
   * symbol from {@link LookaheadIterator#currentType}.
   *
   * Lookahead iterators can be useful for generating suggestions and improving
   * syntax error diagnostics. To get symbols valid in an `ERROR` node, use the
   * lookahead iterator on its first leaf node state. For `MISSING` nodes, a
   * lookahead iterator created on the previous non-extra leaf node may be
   * appropriate.
   */
  lookaheadIterator(stateId) {
    const address = C._ts_lookahead_iterator_new(this[0], stateId);
    if (address) return new LookaheadIterator(INTERNAL, address, this);
    return null;
  }
  /**
   * @deprecated since version 0.25.0, call `new` on a {@link Query} instead
   *
   * Create a new query from a string containing one or more S-expression
   * patterns.
   *
   * The query is associated with a particular language, and can only be run
   * on syntax nodes parsed with that language. References to Queries can be
   * shared between multiple threads.
   *
   * @link {@see https://tree-sitter.github.io/tree-sitter/using-parsers/queries}
   */
  query(source) {
    console.warn("Language.query is deprecated. Use new Query(language, source) instead.");
    return new Query(this, source);
  }
  /**
   * Load a language from a WebAssembly module.
   * The module can be provided as a path to a file or as a buffer.
   */
  static async load(input) {
    let bytes;
    if (input instanceof Uint8Array) {
      bytes = Promise.resolve(input);
    } else {
      if (globalThis.process?.versions.node) {
        const fs22 = await import("fs/promises");
        bytes = fs22.readFile(input);
      } else {
        bytes = fetch(input).then((response) => response.arrayBuffer().then((buffer) => {
          if (response.ok) {
            return new Uint8Array(buffer);
          } else {
            const body2 = new TextDecoder("utf-8").decode(buffer);
            throw new Error(`Language.load failed with status ${response.status}.

${body2}`);
          }
        }));
      }
    }
    const mod = await C.loadWebAssemblyModule(await bytes, { loadAsync: true });
    const symbolNames = Object.keys(mod);
    const functionName = symbolNames.find((key) => LANGUAGE_FUNCTION_REGEX.test(key) && !key.includes("external_scanner_"));
    if (!functionName) {
      console.log(`Couldn't find language function in WASM file. Symbols:
${JSON.stringify(symbolNames, null, 2)}`);
      throw new Error("Language.load failed: no language function found in WASM file");
    }
    const languageAddress = mod[functionName]();
    return new _Language(INTERNAL, languageAddress);
  }
};
var Module2 = (() => {
  var _scriptName = import.meta.url;
  return async function(moduleArg = {}) {
    var moduleRtn;
    var Module = moduleArg;
    var readyPromiseResolve, readyPromiseReject;
    var readyPromise = new Promise((resolve3, reject) => {
      readyPromiseResolve = resolve3;
      readyPromiseReject = reject;
    });
    var ENVIRONMENT_IS_WEB = typeof window == "object";
    var ENVIRONMENT_IS_WORKER = typeof WorkerGlobalScope != "undefined";
    var ENVIRONMENT_IS_NODE = typeof process == "object" && typeof process.versions == "object" && typeof process.versions.node == "string" && process.type != "renderer";
    var ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;
    if (ENVIRONMENT_IS_NODE) {
      const { createRequire } = await import("module");
      var require = createRequire(import.meta.url);
    }
    Module.currentQueryProgressCallback = null;
    Module.currentProgressCallback = null;
    Module.currentLogCallback = null;
    Module.currentParseCallback = null;
    var moduleOverrides = Object.assign({}, Module);
    var arguments_ = [];
    var thisProgram = "./this.program";
    var quit_ = /* @__PURE__ */ __name((status, toThrow) => {
      throw toThrow;
    }, "quit_");
    var scriptDirectory = "";
    function locateFile(path22) {
      if (Module["locateFile"]) {
        return Module["locateFile"](path22, scriptDirectory);
      }
      return scriptDirectory + path22;
    }
    __name(locateFile, "locateFile");
    var readAsync, readBinary;
    if (ENVIRONMENT_IS_NODE) {
      var fs = require("fs");
      var nodePath = require("path");
      if (!import.meta.url.startsWith("data:")) {
        scriptDirectory = nodePath.dirname(require("url").fileURLToPath(import.meta.url)) + "/";
      }
      readBinary = /* @__PURE__ */ __name((filename) => {
        filename = isFileURI(filename) ? new URL(filename) : filename;
        var ret = fs.readFileSync(filename);
        return ret;
      }, "readBinary");
      readAsync = /* @__PURE__ */ __name(async (filename, binary2 = true) => {
        filename = isFileURI(filename) ? new URL(filename) : filename;
        var ret = fs.readFileSync(filename, binary2 ? void 0 : "utf8");
        return ret;
      }, "readAsync");
      if (!Module["thisProgram"] && process.argv.length > 1) {
        thisProgram = process.argv[1].replace(/\\/g, "/");
      }
      arguments_ = process.argv.slice(2);
      quit_ = /* @__PURE__ */ __name((status, toThrow) => {
        process.exitCode = status;
        throw toThrow;
      }, "quit_");
    } else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
      if (ENVIRONMENT_IS_WORKER) {
        scriptDirectory = self.location.href;
      } else if (typeof document != "undefined" && document.currentScript) {
        scriptDirectory = document.currentScript.src;
      }
      if (_scriptName) {
        scriptDirectory = _scriptName;
      }
      if (scriptDirectory.startsWith("blob:")) {
        scriptDirectory = "";
      } else {
        scriptDirectory = scriptDirectory.slice(0, scriptDirectory.replace(/[?#].*/, "").lastIndexOf("/") + 1);
      }
      {
        if (ENVIRONMENT_IS_WORKER) {
          readBinary = /* @__PURE__ */ __name((url) => {
            var xhr = new XMLHttpRequest();
            xhr.open("GET", url, false);
            xhr.responseType = "arraybuffer";
            xhr.send(null);
            return new Uint8Array(
              /** @type{!ArrayBuffer} */
              xhr.response
            );
          }, "readBinary");
        }
        readAsync = /* @__PURE__ */ __name(async (url) => {
          if (isFileURI(url)) {
            return new Promise((resolve3, reject) => {
              var xhr = new XMLHttpRequest();
              xhr.open("GET", url, true);
              xhr.responseType = "arraybuffer";
              xhr.onload = () => {
                if (xhr.status == 200 || xhr.status == 0 && xhr.response) {
                  resolve3(xhr.response);
                  return;
                }
                reject(xhr.status);
              };
              xhr.onerror = reject;
              xhr.send(null);
            });
          }
          var response = await fetch(url, {
            credentials: "same-origin"
          });
          if (response.ok) {
            return response.arrayBuffer();
          }
          throw new Error(response.status + " : " + response.url);
        }, "readAsync");
      }
    } else {
    }
    var out = Module["print"] || console.log.bind(console);
    var err = Module["printErr"] || console.error.bind(console);
    Object.assign(Module, moduleOverrides);
    moduleOverrides = null;
    if (Module["arguments"]) arguments_ = Module["arguments"];
    if (Module["thisProgram"]) thisProgram = Module["thisProgram"];
    var dynamicLibraries = Module["dynamicLibraries"] || [];
    var wasmBinary = Module["wasmBinary"];
    var wasmMemory;
    var ABORT = false;
    var EXITSTATUS;
    function assert(condition, text) {
      if (!condition) {
        abort(text);
      }
    }
    __name(assert, "assert");
    var HEAP, HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAP64, HEAPU64, HEAPF64;
    var HEAP_DATA_VIEW;
    var runtimeInitialized = false;
    var isFileURI = /* @__PURE__ */ __name((filename) => filename.startsWith("file://"), "isFileURI");
    function updateMemoryViews() {
      var b = wasmMemory.buffer;
      Module["HEAP_DATA_VIEW"] = HEAP_DATA_VIEW = new DataView(b);
      Module["HEAP8"] = HEAP8 = new Int8Array(b);
      Module["HEAP16"] = HEAP16 = new Int16Array(b);
      Module["HEAPU8"] = HEAPU8 = new Uint8Array(b);
      Module["HEAPU16"] = HEAPU16 = new Uint16Array(b);
      Module["HEAP32"] = HEAP32 = new Int32Array(b);
      Module["HEAPU32"] = HEAPU32 = new Uint32Array(b);
      Module["HEAPF32"] = HEAPF32 = new Float32Array(b);
      Module["HEAPF64"] = HEAPF64 = new Float64Array(b);
      Module["HEAP64"] = HEAP64 = new BigInt64Array(b);
      Module["HEAPU64"] = HEAPU64 = new BigUint64Array(b);
    }
    __name(updateMemoryViews, "updateMemoryViews");
    if (Module["wasmMemory"]) {
      wasmMemory = Module["wasmMemory"];
    } else {
      var INITIAL_MEMORY = Module["INITIAL_MEMORY"] || 33554432;
      wasmMemory = new WebAssembly.Memory({
        "initial": INITIAL_MEMORY / 65536,
        // In theory we should not need to emit the maximum if we want "unlimited"
        // or 4GB of memory, but VMs error on that atm, see
        // https://github.com/emscripten-core/emscripten/issues/14130
        // And in the pthreads case we definitely need to emit a maximum. So
        // always emit one.
        "maximum": 32768
      });
    }
    updateMemoryViews();
    var __RELOC_FUNCS__ = [];
    function preRun() {
      if (Module["preRun"]) {
        if (typeof Module["preRun"] == "function") Module["preRun"] = [Module["preRun"]];
        while (Module["preRun"].length) {
          addOnPreRun(Module["preRun"].shift());
        }
      }
      callRuntimeCallbacks(onPreRuns);
    }
    __name(preRun, "preRun");
    function initRuntime() {
      runtimeInitialized = true;
      callRuntimeCallbacks(__RELOC_FUNCS__);
      wasmExports["__wasm_call_ctors"]();
      callRuntimeCallbacks(onPostCtors);
    }
    __name(initRuntime, "initRuntime");
    function preMain() {
    }
    __name(preMain, "preMain");
    function postRun() {
      if (Module["postRun"]) {
        if (typeof Module["postRun"] == "function") Module["postRun"] = [Module["postRun"]];
        while (Module["postRun"].length) {
          addOnPostRun(Module["postRun"].shift());
        }
      }
      callRuntimeCallbacks(onPostRuns);
    }
    __name(postRun, "postRun");
    var runDependencies = 0;
    var dependenciesFulfilled = null;
    function getUniqueRunDependency(id) {
      return id;
    }
    __name(getUniqueRunDependency, "getUniqueRunDependency");
    function addRunDependency(id) {
      runDependencies++;
      Module["monitorRunDependencies"]?.(runDependencies);
    }
    __name(addRunDependency, "addRunDependency");
    function removeRunDependency(id) {
      runDependencies--;
      Module["monitorRunDependencies"]?.(runDependencies);
      if (runDependencies == 0) {
        if (dependenciesFulfilled) {
          var callback = dependenciesFulfilled;
          dependenciesFulfilled = null;
          callback();
        }
      }
    }
    __name(removeRunDependency, "removeRunDependency");
    function abort(what) {
      Module["onAbort"]?.(what);
      what = "Aborted(" + what + ")";
      err(what);
      ABORT = true;
      what += ". Build with -sASSERTIONS for more info.";
      var e = new WebAssembly.RuntimeError(what);
      readyPromiseReject(e);
      throw e;
    }
    __name(abort, "abort");
    var wasmBinaryFile;
    function findWasmBinary() {
      if (Module["locateFile"]) {
        return locateFile("tree-sitter.wasm");
      }
      return new URL("tree-sitter.wasm", import.meta.url).href;
    }
    __name(findWasmBinary, "findWasmBinary");
    function getBinarySync(file) {
      if (file == wasmBinaryFile && wasmBinary) {
        return new Uint8Array(wasmBinary);
      }
      if (readBinary) {
        return readBinary(file);
      }
      throw "both async and sync fetching of the wasm failed";
    }
    __name(getBinarySync, "getBinarySync");
    async function getWasmBinary(binaryFile) {
      if (!wasmBinary) {
        try {
          var response = await readAsync(binaryFile);
          return new Uint8Array(response);
        } catch {
        }
      }
      return getBinarySync(binaryFile);
    }
    __name(getWasmBinary, "getWasmBinary");
    async function instantiateArrayBuffer(binaryFile, imports) {
      try {
        var binary2 = await getWasmBinary(binaryFile);
        var instance2 = await WebAssembly.instantiate(binary2, imports);
        return instance2;
      } catch (reason) {
        err(`failed to asynchronously prepare wasm: ${reason}`);
        abort(reason);
      }
    }
    __name(instantiateArrayBuffer, "instantiateArrayBuffer");
    async function instantiateAsync(binary2, binaryFile, imports) {
      if (!binary2 && typeof WebAssembly.instantiateStreaming == "function" && !isFileURI(binaryFile) && !ENVIRONMENT_IS_NODE) {
        try {
          var response = fetch(binaryFile, {
            credentials: "same-origin"
          });
          var instantiationResult = await WebAssembly.instantiateStreaming(response, imports);
          return instantiationResult;
        } catch (reason) {
          err(`wasm streaming compile failed: ${reason}`);
          err("falling back to ArrayBuffer instantiation");
        }
      }
      return instantiateArrayBuffer(binaryFile, imports);
    }
    __name(instantiateAsync, "instantiateAsync");
    function getWasmImports() {
      return {
        "env": wasmImports,
        "wasi_snapshot_preview1": wasmImports,
        "GOT.mem": new Proxy(wasmImports, GOTHandler),
        "GOT.func": new Proxy(wasmImports, GOTHandler)
      };
    }
    __name(getWasmImports, "getWasmImports");
    async function createWasm() {
      function receiveInstance(instance2, module2) {
        wasmExports = instance2.exports;
        wasmExports = relocateExports(wasmExports, 1024);
        var metadata2 = getDylinkMetadata(module2);
        if (metadata2.neededDynlibs) {
          dynamicLibraries = metadata2.neededDynlibs.concat(dynamicLibraries);
        }
        mergeLibSymbols(wasmExports, "main");
        LDSO.init();
        loadDylibs();
        __RELOC_FUNCS__.push(wasmExports["__wasm_apply_data_relocs"]);
        removeRunDependency("wasm-instantiate");
        return wasmExports;
      }
      __name(receiveInstance, "receiveInstance");
      addRunDependency("wasm-instantiate");
      function receiveInstantiationResult(result2) {
        return receiveInstance(result2["instance"], result2["module"]);
      }
      __name(receiveInstantiationResult, "receiveInstantiationResult");
      var info2 = getWasmImports();
      if (Module["instantiateWasm"]) {
        return new Promise((resolve3, reject) => {
          Module["instantiateWasm"](info2, (mod, inst) => {
            receiveInstance(mod, inst);
            resolve3(mod.exports);
          });
        });
      }
      wasmBinaryFile ??= findWasmBinary();
      try {
        var result = await instantiateAsync(wasmBinary, wasmBinaryFile, info2);
        var exports = receiveInstantiationResult(result);
        return exports;
      } catch (e) {
        readyPromiseReject(e);
        return Promise.reject(e);
      }
    }
    __name(createWasm, "createWasm");
    var ASM_CONSTS = {};
    class ExitStatus {
      static {
        __name(this, "ExitStatus");
      }
      name = "ExitStatus";
      constructor(status) {
        this.message = `Program terminated with exit(${status})`;
        this.status = status;
      }
    }
    var GOT = {};
    var currentModuleWeakSymbols = /* @__PURE__ */ new Set([]);
    var GOTHandler = {
      get(obj, symName) {
        var rtn = GOT[symName];
        if (!rtn) {
          rtn = GOT[symName] = new WebAssembly.Global({
            "value": "i32",
            "mutable": true
          });
        }
        if (!currentModuleWeakSymbols.has(symName)) {
          rtn.required = true;
        }
        return rtn;
      }
    };
    var LE_HEAP_LOAD_F32 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getFloat32(byteOffset, true), "LE_HEAP_LOAD_F32");
    var LE_HEAP_LOAD_F64 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getFloat64(byteOffset, true), "LE_HEAP_LOAD_F64");
    var LE_HEAP_LOAD_I16 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getInt16(byteOffset, true), "LE_HEAP_LOAD_I16");
    var LE_HEAP_LOAD_I32 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getInt32(byteOffset, true), "LE_HEAP_LOAD_I32");
    var LE_HEAP_LOAD_U16 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getUint16(byteOffset, true), "LE_HEAP_LOAD_U16");
    var LE_HEAP_LOAD_U32 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getUint32(byteOffset, true), "LE_HEAP_LOAD_U32");
    var LE_HEAP_STORE_F32 = /* @__PURE__ */ __name((byteOffset, value2) => HEAP_DATA_VIEW.setFloat32(byteOffset, value2, true), "LE_HEAP_STORE_F32");
    var LE_HEAP_STORE_F64 = /* @__PURE__ */ __name((byteOffset, value2) => HEAP_DATA_VIEW.setFloat64(byteOffset, value2, true), "LE_HEAP_STORE_F64");
    var LE_HEAP_STORE_I16 = /* @__PURE__ */ __name((byteOffset, value2) => HEAP_DATA_VIEW.setInt16(byteOffset, value2, true), "LE_HEAP_STORE_I16");
    var LE_HEAP_STORE_I32 = /* @__PURE__ */ __name((byteOffset, value2) => HEAP_DATA_VIEW.setInt32(byteOffset, value2, true), "LE_HEAP_STORE_I32");
    var LE_HEAP_STORE_U16 = /* @__PURE__ */ __name((byteOffset, value2) => HEAP_DATA_VIEW.setUint16(byteOffset, value2, true), "LE_HEAP_STORE_U16");
    var LE_HEAP_STORE_U32 = /* @__PURE__ */ __name((byteOffset, value2) => HEAP_DATA_VIEW.setUint32(byteOffset, value2, true), "LE_HEAP_STORE_U32");
    var callRuntimeCallbacks = /* @__PURE__ */ __name((callbacks) => {
      while (callbacks.length > 0) {
        callbacks.shift()(Module);
      }
    }, "callRuntimeCallbacks");
    var onPostRuns = [];
    var addOnPostRun = /* @__PURE__ */ __name((cb) => onPostRuns.unshift(cb), "addOnPostRun");
    var onPreRuns = [];
    var addOnPreRun = /* @__PURE__ */ __name((cb) => onPreRuns.unshift(cb), "addOnPreRun");
    var UTF8Decoder = typeof TextDecoder != "undefined" ? new TextDecoder() : void 0;
    var UTF8ArrayToString = /* @__PURE__ */ __name((heapOrArray, idx = 0, maxBytesToRead = NaN) => {
      var endIdx = idx + maxBytesToRead;
      var endPtr = idx;
      while (heapOrArray[endPtr] && !(endPtr >= endIdx)) ++endPtr;
      if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
        return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
      }
      var str = "";
      while (idx < endPtr) {
        var u0 = heapOrArray[idx++];
        if (!(u0 & 128)) {
          str += String.fromCharCode(u0);
          continue;
        }
        var u1 = heapOrArray[idx++] & 63;
        if ((u0 & 224) == 192) {
          str += String.fromCharCode((u0 & 31) << 6 | u1);
          continue;
        }
        var u2 = heapOrArray[idx++] & 63;
        if ((u0 & 240) == 224) {
          u0 = (u0 & 15) << 12 | u1 << 6 | u2;
        } else {
          u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | heapOrArray[idx++] & 63;
        }
        if (u0 < 65536) {
          str += String.fromCharCode(u0);
        } else {
          var ch = u0 - 65536;
          str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023);
        }
      }
      return str;
    }, "UTF8ArrayToString");
    var getDylinkMetadata = /* @__PURE__ */ __name((binary2) => {
      var offset = 0;
      var end = 0;
      function getU8() {
        return binary2[offset++];
      }
      __name(getU8, "getU8");
      function getLEB() {
        var ret = 0;
        var mul = 1;
        while (1) {
          var byte = binary2[offset++];
          ret += (byte & 127) * mul;
          mul *= 128;
          if (!(byte & 128)) break;
        }
        return ret;
      }
      __name(getLEB, "getLEB");
      function getString() {
        var len = getLEB();
        offset += len;
        return UTF8ArrayToString(binary2, offset - len, len);
      }
      __name(getString, "getString");
      function failIf(condition, message) {
        if (condition) throw new Error(message);
      }
      __name(failIf, "failIf");
      var name2 = "dylink.0";
      if (binary2 instanceof WebAssembly.Module) {
        var dylinkSection = WebAssembly.Module.customSections(binary2, name2);
        if (dylinkSection.length === 0) {
          name2 = "dylink";
          dylinkSection = WebAssembly.Module.customSections(binary2, name2);
        }
        failIf(dylinkSection.length === 0, "need dylink section");
        binary2 = new Uint8Array(dylinkSection[0]);
        end = binary2.length;
      } else {
        var int32View = new Uint32Array(new Uint8Array(binary2.subarray(0, 24)).buffer);
        var magicNumberFound = int32View[0] == 1836278016 || int32View[0] == 6386541;
        failIf(!magicNumberFound, "need to see wasm magic number");
        failIf(binary2[8] !== 0, "need the dylink section to be first");
        offset = 9;
        var section_size = getLEB();
        end = offset + section_size;
        name2 = getString();
      }
      var customSection = {
        neededDynlibs: [],
        tlsExports: /* @__PURE__ */ new Set(),
        weakImports: /* @__PURE__ */ new Set()
      };
      if (name2 == "dylink") {
        customSection.memorySize = getLEB();
        customSection.memoryAlign = getLEB();
        customSection.tableSize = getLEB();
        customSection.tableAlign = getLEB();
        var neededDynlibsCount = getLEB();
        for (var i2 = 0; i2 < neededDynlibsCount; ++i2) {
          var libname = getString();
          customSection.neededDynlibs.push(libname);
        }
      } else {
        failIf(name2 !== "dylink.0");
        var WASM_DYLINK_MEM_INFO = 1;
        var WASM_DYLINK_NEEDED = 2;
        var WASM_DYLINK_EXPORT_INFO = 3;
        var WASM_DYLINK_IMPORT_INFO = 4;
        var WASM_SYMBOL_TLS = 256;
        var WASM_SYMBOL_BINDING_MASK = 3;
        var WASM_SYMBOL_BINDING_WEAK = 1;
        while (offset < end) {
          var subsectionType = getU8();
          var subsectionSize = getLEB();
          if (subsectionType === WASM_DYLINK_MEM_INFO) {
            customSection.memorySize = getLEB();
            customSection.memoryAlign = getLEB();
            customSection.tableSize = getLEB();
            customSection.tableAlign = getLEB();
          } else if (subsectionType === WASM_DYLINK_NEEDED) {
            var neededDynlibsCount = getLEB();
            for (var i2 = 0; i2 < neededDynlibsCount; ++i2) {
              libname = getString();
              customSection.neededDynlibs.push(libname);
            }
          } else if (subsectionType === WASM_DYLINK_EXPORT_INFO) {
            var count = getLEB();
            while (count--) {
              var symname = getString();
              var flags2 = getLEB();
              if (flags2 & WASM_SYMBOL_TLS) {
                customSection.tlsExports.add(symname);
              }
            }
          } else if (subsectionType === WASM_DYLINK_IMPORT_INFO) {
            var count = getLEB();
            while (count--) {
              var modname = getString();
              var symname = getString();
              var flags2 = getLEB();
              if ((flags2 & WASM_SYMBOL_BINDING_MASK) == WASM_SYMBOL_BINDING_WEAK) {
                customSection.weakImports.add(symname);
              }
            }
          } else {
            offset += subsectionSize;
          }
        }
      }
      return customSection;
    }, "getDylinkMetadata");
    function getValue(ptr, type = "i8") {
      if (type.endsWith("*")) type = "*";
      switch (type) {
        case "i1":
          return HEAP8[ptr];
        case "i8":
          return HEAP8[ptr];
        case "i16":
          return LE_HEAP_LOAD_I16((ptr >> 1) * 2);
        case "i32":
          return LE_HEAP_LOAD_I32((ptr >> 2) * 4);
        case "i64":
          return HEAP64[ptr >> 3];
        case "float":
          return LE_HEAP_LOAD_F32((ptr >> 2) * 4);
        case "double":
          return LE_HEAP_LOAD_F64((ptr >> 3) * 8);
        case "*":
          return LE_HEAP_LOAD_U32((ptr >> 2) * 4);
        default:
          abort(`invalid type for getValue: ${type}`);
      }
    }
    __name(getValue, "getValue");
    var newDSO = /* @__PURE__ */ __name((name2, handle22, syms) => {
      var dso = {
        refcount: Infinity,
        name: name2,
        exports: syms,
        global: true
      };
      LDSO.loadedLibsByName[name2] = dso;
      if (handle22 != void 0) {
        LDSO.loadedLibsByHandle[handle22] = dso;
      }
      return dso;
    }, "newDSO");
    var LDSO = {
      loadedLibsByName: {},
      loadedLibsByHandle: {},
      init() {
        newDSO("__main__", 0, wasmImports);
      }
    };
    var ___heap_base = 78224;
    var alignMemory = /* @__PURE__ */ __name((size, alignment) => Math.ceil(size / alignment) * alignment, "alignMemory");
    var getMemory = /* @__PURE__ */ __name((size) => {
      if (runtimeInitialized) {
        return _calloc(size, 1);
      }
      var ret = ___heap_base;
      var end = ret + alignMemory(size, 16);
      ___heap_base = end;
      GOT["__heap_base"].value = end;
      return ret;
    }, "getMemory");
    var isInternalSym = /* @__PURE__ */ __name((symName) => ["__cpp_exception", "__c_longjmp", "__wasm_apply_data_relocs", "__dso_handle", "__tls_size", "__tls_align", "__set_stack_limits", "_emscripten_tls_init", "__wasm_init_tls", "__wasm_call_ctors", "__start_em_asm", "__stop_em_asm", "__start_em_js", "__stop_em_js"].includes(symName) || symName.startsWith("__em_js__"), "isInternalSym");
    var uleb128Encode = /* @__PURE__ */ __name((n, target) => {
      if (n < 128) {
        target.push(n);
      } else {
        target.push(n % 128 | 128, n >> 7);
      }
    }, "uleb128Encode");
    var sigToWasmTypes = /* @__PURE__ */ __name((sig) => {
      var typeNames = {
        "i": "i32",
        "j": "i64",
        "f": "f32",
        "d": "f64",
        "e": "externref",
        "p": "i32"
      };
      var type = {
        parameters: [],
        results: sig[0] == "v" ? [] : [typeNames[sig[0]]]
      };
      for (var i2 = 1; i2 < sig.length; ++i2) {
        type.parameters.push(typeNames[sig[i2]]);
      }
      return type;
    }, "sigToWasmTypes");
    var generateFuncType = /* @__PURE__ */ __name((sig, target) => {
      var sigRet = sig.slice(0, 1);
      var sigParam = sig.slice(1);
      var typeCodes = {
        "i": 127,
        // i32
        "p": 127,
        // i32
        "j": 126,
        // i64
        "f": 125,
        // f32
        "d": 124,
        // f64
        "e": 111
      };
      target.push(96);
      uleb128Encode(sigParam.length, target);
      for (var i2 = 0; i2 < sigParam.length; ++i2) {
        target.push(typeCodes[sigParam[i2]]);
      }
      if (sigRet == "v") {
        target.push(0);
      } else {
        target.push(1, typeCodes[sigRet]);
      }
    }, "generateFuncType");
    var convertJsFunctionToWasm = /* @__PURE__ */ __name((func2, sig) => {
      if (typeof WebAssembly.Function == "function") {
        return new WebAssembly.Function(sigToWasmTypes(sig), func2);
      }
      var typeSectionBody = [1];
      generateFuncType(sig, typeSectionBody);
      var bytes = [
        0,
        97,
        115,
        109,
        // magic ("\0asm")
        1,
        0,
        0,
        0,
        // version: 1
        1
      ];
      uleb128Encode(typeSectionBody.length, bytes);
      bytes.push(...typeSectionBody);
      bytes.push(
        2,
        7,
        // import section
        // (import "e" "f" (func 0 (type 0)))
        1,
        1,
        101,
        1,
        102,
        0,
        0,
        7,
        5,
        // export section
        // (export "f" (func 0 (type 0)))
        1,
        1,
        102,
        0,
        0
      );
      var module2 = new WebAssembly.Module(new Uint8Array(bytes));
      var instance2 = new WebAssembly.Instance(module2, {
        "e": {
          "f": func2
        }
      });
      var wrappedFunc = instance2.exports["f"];
      return wrappedFunc;
    }, "convertJsFunctionToWasm");
    var wasmTableMirror = [];
    var wasmTable = new WebAssembly.Table({
      "initial": 31,
      "element": "anyfunc"
    });
    var getWasmTableEntry = /* @__PURE__ */ __name((funcPtr) => {
      var func2 = wasmTableMirror[funcPtr];
      if (!func2) {
        if (funcPtr >= wasmTableMirror.length) wasmTableMirror.length = funcPtr + 1;
        wasmTableMirror[funcPtr] = func2 = wasmTable.get(funcPtr);
      }
      return func2;
    }, "getWasmTableEntry");
    var updateTableMap = /* @__PURE__ */ __name((offset, count) => {
      if (functionsInTableMap) {
        for (var i2 = offset; i2 < offset + count; i2++) {
          var item = getWasmTableEntry(i2);
          if (item) {
            functionsInTableMap.set(item, i2);
          }
        }
      }
    }, "updateTableMap");
    var functionsInTableMap;
    var getFunctionAddress = /* @__PURE__ */ __name((func2) => {
      if (!functionsInTableMap) {
        functionsInTableMap = /* @__PURE__ */ new WeakMap();
        updateTableMap(0, wasmTable.length);
      }
      return functionsInTableMap.get(func2) || 0;
    }, "getFunctionAddress");
    var freeTableIndexes = [];
    var getEmptyTableSlot = /* @__PURE__ */ __name(() => {
      if (freeTableIndexes.length) {
        return freeTableIndexes.pop();
      }
      try {
        wasmTable.grow(1);
      } catch (err2) {
        if (!(err2 instanceof RangeError)) {
          throw err2;
        }
        throw "Unable to grow wasm table. Set ALLOW_TABLE_GROWTH.";
      }
      return wasmTable.length - 1;
    }, "getEmptyTableSlot");
    var setWasmTableEntry = /* @__PURE__ */ __name((idx, func2) => {
      wasmTable.set(idx, func2);
      wasmTableMirror[idx] = wasmTable.get(idx);
    }, "setWasmTableEntry");
    var addFunction = /* @__PURE__ */ __name((func2, sig) => {
      var rtn = getFunctionAddress(func2);
      if (rtn) {
        return rtn;
      }
      var ret = getEmptyTableSlot();
      try {
        setWasmTableEntry(ret, func2);
      } catch (err2) {
        if (!(err2 instanceof TypeError)) {
          throw err2;
        }
        var wrapped = convertJsFunctionToWasm(func2, sig);
        setWasmTableEntry(ret, wrapped);
      }
      functionsInTableMap.set(func2, ret);
      return ret;
    }, "addFunction");
    var updateGOT = /* @__PURE__ */ __name((exports, replace) => {
      for (var symName in exports) {
        if (isInternalSym(symName)) {
          continue;
        }
        var value2 = exports[symName];
        GOT[symName] ||= new WebAssembly.Global({
          "value": "i32",
          "mutable": true
        });
        if (replace || GOT[symName].value == 0) {
          if (typeof value2 == "function") {
            GOT[symName].value = addFunction(value2);
          } else if (typeof value2 == "number") {
            GOT[symName].value = value2;
          } else {
            err(`unhandled export type for '${symName}': ${typeof value2}`);
          }
        }
      }
    }, "updateGOT");
    var relocateExports = /* @__PURE__ */ __name((exports, memoryBase2, replace) => {
      var relocated = {};
      for (var e in exports) {
        var value2 = exports[e];
        if (typeof value2 == "object") {
          value2 = value2.value;
        }
        if (typeof value2 == "number") {
          value2 += memoryBase2;
        }
        relocated[e] = value2;
      }
      updateGOT(relocated, replace);
      return relocated;
    }, "relocateExports");
    var isSymbolDefined = /* @__PURE__ */ __name((symName) => {
      var existing = wasmImports[symName];
      if (!existing || existing.stub) {
        return false;
      }
      return true;
    }, "isSymbolDefined");
    var dynCall = /* @__PURE__ */ __name((sig, ptr, args2 = []) => {
      var rtn = getWasmTableEntry(ptr)(...args2);
      return rtn;
    }, "dynCall");
    var stackSave = /* @__PURE__ */ __name(() => _emscripten_stack_get_current(), "stackSave");
    var stackRestore = /* @__PURE__ */ __name((val) => __emscripten_stack_restore(val), "stackRestore");
    var createInvokeFunction = /* @__PURE__ */ __name((sig) => (ptr, ...args2) => {
      var sp = stackSave();
      try {
        return dynCall(sig, ptr, args2);
      } catch (e) {
        stackRestore(sp);
        if (e !== e + 0) throw e;
        _setThrew(1, 0);
        if (sig[0] == "j") return 0n;
      }
    }, "createInvokeFunction");
    var resolveGlobalSymbol = /* @__PURE__ */ __name((symName, direct = false) => {
      var sym;
      if (isSymbolDefined(symName)) {
        sym = wasmImports[symName];
      } else if (symName.startsWith("invoke_")) {
        sym = wasmImports[symName] = createInvokeFunction(symName.split("_")[1]);
      }
      return {
        sym,
        name: symName
      };
    }, "resolveGlobalSymbol");
    var onPostCtors = [];
    var addOnPostCtor = /* @__PURE__ */ __name((cb) => onPostCtors.unshift(cb), "addOnPostCtor");
    var UTF8ToString = /* @__PURE__ */ __name((ptr, maxBytesToRead) => ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : "", "UTF8ToString");
    var loadWebAssemblyModule = /* @__PURE__ */ __name((binary, flags, libName, localScope, handle) => {
      var metadata = getDylinkMetadata(binary);
      currentModuleWeakSymbols = metadata.weakImports;
      function loadModule() {
        var memAlign = Math.pow(2, metadata.memoryAlign);
        var memoryBase = metadata.memorySize ? alignMemory(getMemory(metadata.memorySize + memAlign), memAlign) : 0;
        var tableBase = metadata.tableSize ? wasmTable.length : 0;
        if (handle) {
          HEAP8[handle + 8] = 1;
          LE_HEAP_STORE_U32((handle + 12 >> 2) * 4, memoryBase);
          LE_HEAP_STORE_I32((handle + 16 >> 2) * 4, metadata.memorySize);
          LE_HEAP_STORE_U32((handle + 20 >> 2) * 4, tableBase);
          LE_HEAP_STORE_I32((handle + 24 >> 2) * 4, metadata.tableSize);
        }
        if (metadata.tableSize) {
          wasmTable.grow(metadata.tableSize);
        }
        var moduleExports;
        function resolveSymbol(sym) {
          var resolved = resolveGlobalSymbol(sym).sym;
          if (!resolved && localScope) {
            resolved = localScope[sym];
          }
          if (!resolved) {
            resolved = moduleExports[sym];
          }
          return resolved;
        }
        __name(resolveSymbol, "resolveSymbol");
        var proxyHandler = {
          get(stubs, prop) {
            switch (prop) {
              case "__memory_base":
                return memoryBase;
              case "__table_base":
                return tableBase;
            }
            if (prop in wasmImports && !wasmImports[prop].stub) {
              var res = wasmImports[prop];
              return res;
            }
            if (!(prop in stubs)) {
              var resolved;
              stubs[prop] = (...args2) => {
                resolved ||= resolveSymbol(prop);
                return resolved(...args2);
              };
            }
            return stubs[prop];
          }
        };
        var proxy = new Proxy({}, proxyHandler);
        var info = {
          "GOT.mem": new Proxy({}, GOTHandler),
          "GOT.func": new Proxy({}, GOTHandler),
          "env": proxy,
          "wasi_snapshot_preview1": proxy
        };
        function postInstantiation(module, instance) {
          updateTableMap(tableBase, metadata.tableSize);
          moduleExports = relocateExports(instance.exports, memoryBase);
          if (!flags.allowUndefined) {
            reportUndefinedSymbols();
          }
          function addEmAsm(addr, body) {
            var args = [];
            var arity = 0;
            for (; arity < 16; arity++) {
              if (body.indexOf("$" + arity) != -1) {
                args.push("$" + arity);
              } else {
                break;
              }
            }
            args = args.join(",");
            var func = `(${args}) => { ${body} };`;
            ASM_CONSTS[start] = eval(func);
          }
          __name(addEmAsm, "addEmAsm");
          if ("__start_em_asm" in moduleExports) {
            var start = moduleExports["__start_em_asm"];
            var stop = moduleExports["__stop_em_asm"];
            while (start < stop) {
              var jsString = UTF8ToString(start);
              addEmAsm(start, jsString);
              start = HEAPU8.indexOf(0, start) + 1;
            }
          }
          function addEmJs(name, cSig, body) {
            var jsArgs = [];
            cSig = cSig.slice(1, -1);
            if (cSig != "void") {
              cSig = cSig.split(",");
              for (var i in cSig) {
                var jsArg = cSig[i].split(" ").pop();
                jsArgs.push(jsArg.replace("*", ""));
              }
            }
            var func = `(${jsArgs}) => ${body};`;
            moduleExports[name] = eval(func);
          }
          __name(addEmJs, "addEmJs");
          for (var name in moduleExports) {
            if (name.startsWith("__em_js__")) {
              var start = moduleExports[name];
              var jsString = UTF8ToString(start);
              var parts = jsString.split("<::>");
              addEmJs(name.replace("__em_js__", ""), parts[0], parts[1]);
              delete moduleExports[name];
            }
          }
          var applyRelocs = moduleExports["__wasm_apply_data_relocs"];
          if (applyRelocs) {
            if (runtimeInitialized) {
              applyRelocs();
            } else {
              __RELOC_FUNCS__.push(applyRelocs);
            }
          }
          var init = moduleExports["__wasm_call_ctors"];
          if (init) {
            if (runtimeInitialized) {
              init();
            } else {
              addOnPostCtor(init);
            }
          }
          return moduleExports;
        }
        __name(postInstantiation, "postInstantiation");
        if (flags.loadAsync) {
          if (binary instanceof WebAssembly.Module) {
            var instance = new WebAssembly.Instance(binary, info);
            return Promise.resolve(postInstantiation(binary, instance));
          }
          return WebAssembly.instantiate(binary, info).then((result) => postInstantiation(result.module, result.instance));
        }
        var module = binary instanceof WebAssembly.Module ? binary : new WebAssembly.Module(binary);
        var instance = new WebAssembly.Instance(module, info);
        return postInstantiation(module, instance);
      }
      __name(loadModule, "loadModule");
      if (flags.loadAsync) {
        return metadata.neededDynlibs.reduce((chain, dynNeeded) => chain.then(() => loadDynamicLibrary(dynNeeded, flags, localScope)), Promise.resolve()).then(loadModule);
      }
      metadata.neededDynlibs.forEach((needed) => loadDynamicLibrary(needed, flags, localScope));
      return loadModule();
    }, "loadWebAssemblyModule");
    var mergeLibSymbols = /* @__PURE__ */ __name((exports, libName2) => {
      for (var [sym, exp] of Object.entries(exports)) {
        const setImport = /* @__PURE__ */ __name((target) => {
          if (!isSymbolDefined(target)) {
            wasmImports[target] = exp;
          }
        }, "setImport");
        setImport(sym);
        const main_alias = "__main_argc_argv";
        if (sym == "main") {
          setImport(main_alias);
        }
        if (sym == main_alias) {
          setImport("main");
        }
      }
    }, "mergeLibSymbols");
    var asyncLoad = /* @__PURE__ */ __name(async (url) => {
      var arrayBuffer = await readAsync(url);
      return new Uint8Array(arrayBuffer);
    }, "asyncLoad");
    function loadDynamicLibrary(libName2, flags2 = {
      global: true,
      nodelete: true
    }, localScope2, handle22) {
      var dso = LDSO.loadedLibsByName[libName2];
      if (dso) {
        if (!flags2.global) {
          if (localScope2) {
            Object.assign(localScope2, dso.exports);
          }
        } else if (!dso.global) {
          dso.global = true;
          mergeLibSymbols(dso.exports, libName2);
        }
        if (flags2.nodelete && dso.refcount !== Infinity) {
          dso.refcount = Infinity;
        }
        dso.refcount++;
        if (handle22) {
          LDSO.loadedLibsByHandle[handle22] = dso;
        }
        return flags2.loadAsync ? Promise.resolve(true) : true;
      }
      dso = newDSO(libName2, handle22, "loading");
      dso.refcount = flags2.nodelete ? Infinity : 1;
      dso.global = flags2.global;
      function loadLibData() {
        if (handle22) {
          var data = LE_HEAP_LOAD_U32((handle22 + 28 >> 2) * 4);
          var dataSize = LE_HEAP_LOAD_U32((handle22 + 32 >> 2) * 4);
          if (data && dataSize) {
            var libData = HEAP8.slice(data, data + dataSize);
            return flags2.loadAsync ? Promise.resolve(libData) : libData;
          }
        }
        var libFile = locateFile(libName2);
        if (flags2.loadAsync) {
          return asyncLoad(libFile);
        }
        if (!readBinary) {
          throw new Error(`${libFile}: file not found, and synchronous loading of external files is not available`);
        }
        return readBinary(libFile);
      }
      __name(loadLibData, "loadLibData");
      function getExports() {
        if (flags2.loadAsync) {
          return loadLibData().then((libData) => loadWebAssemblyModule(libData, flags2, libName2, localScope2, handle22));
        }
        return loadWebAssemblyModule(loadLibData(), flags2, libName2, localScope2, handle22);
      }
      __name(getExports, "getExports");
      function moduleLoaded(exports) {
        if (dso.global) {
          mergeLibSymbols(exports, libName2);
        } else if (localScope2) {
          Object.assign(localScope2, exports);
        }
        dso.exports = exports;
      }
      __name(moduleLoaded, "moduleLoaded");
      if (flags2.loadAsync) {
        return getExports().then((exports) => {
          moduleLoaded(exports);
          return true;
        });
      }
      moduleLoaded(getExports());
      return true;
    }
    __name(loadDynamicLibrary, "loadDynamicLibrary");
    var reportUndefinedSymbols = /* @__PURE__ */ __name(() => {
      for (var [symName, entry] of Object.entries(GOT)) {
        if (entry.value == 0) {
          var value2 = resolveGlobalSymbol(symName, true).sym;
          if (!value2 && !entry.required) {
            continue;
          }
          if (typeof value2 == "function") {
            entry.value = addFunction(value2, value2.sig);
          } else if (typeof value2 == "number") {
            entry.value = value2;
          } else {
            throw new Error(`bad export type for '${symName}': ${typeof value2}`);
          }
        }
      }
    }, "reportUndefinedSymbols");
    var loadDylibs = /* @__PURE__ */ __name(() => {
      if (!dynamicLibraries.length) {
        reportUndefinedSymbols();
        return;
      }
      addRunDependency("loadDylibs");
      dynamicLibraries.reduce((chain, lib) => chain.then(() => loadDynamicLibrary(lib, {
        loadAsync: true,
        global: true,
        nodelete: true,
        allowUndefined: true
      })), Promise.resolve()).then(() => {
        reportUndefinedSymbols();
        removeRunDependency("loadDylibs");
      });
    }, "loadDylibs");
    var noExitRuntime = Module["noExitRuntime"] || true;
    function setValue(ptr, value2, type = "i8") {
      if (type.endsWith("*")) type = "*";
      switch (type) {
        case "i1":
          HEAP8[ptr] = value2;
          break;
        case "i8":
          HEAP8[ptr] = value2;
          break;
        case "i16":
          LE_HEAP_STORE_I16((ptr >> 1) * 2, value2);
          break;
        case "i32":
          LE_HEAP_STORE_I32((ptr >> 2) * 4, value2);
          break;
        case "i64":
          HEAP64[ptr >> 3] = BigInt(value2);
          break;
        case "float":
          LE_HEAP_STORE_F32((ptr >> 2) * 4, value2);
          break;
        case "double":
          LE_HEAP_STORE_F64((ptr >> 3) * 8, value2);
          break;
        case "*":
          LE_HEAP_STORE_U32((ptr >> 2) * 4, value2);
          break;
        default:
          abort(`invalid type for setValue: ${type}`);
      }
    }
    __name(setValue, "setValue");
    var ___memory_base = new WebAssembly.Global({
      "value": "i32",
      "mutable": false
    }, 1024);
    var ___stack_pointer = new WebAssembly.Global({
      "value": "i32",
      "mutable": true
    }, 78224);
    var ___table_base = new WebAssembly.Global({
      "value": "i32",
      "mutable": false
    }, 1);
    var __abort_js = /* @__PURE__ */ __name(() => abort(""), "__abort_js");
    __abort_js.sig = "v";
    var _emscripten_get_now = /* @__PURE__ */ __name(() => performance.now(), "_emscripten_get_now");
    _emscripten_get_now.sig = "d";
    var _emscripten_date_now = /* @__PURE__ */ __name(() => Date.now(), "_emscripten_date_now");
    _emscripten_date_now.sig = "d";
    var nowIsMonotonic = 1;
    var checkWasiClock = /* @__PURE__ */ __name((clock_id) => clock_id >= 0 && clock_id <= 3, "checkWasiClock");
    var INT53_MAX = 9007199254740992;
    var INT53_MIN = -9007199254740992;
    var bigintToI53Checked = /* @__PURE__ */ __name((num) => num < INT53_MIN || num > INT53_MAX ? NaN : Number(num), "bigintToI53Checked");
    function _clock_time_get(clk_id, ignored_precision, ptime) {
      ignored_precision = bigintToI53Checked(ignored_precision);
      if (!checkWasiClock(clk_id)) {
        return 28;
      }
      var now;
      if (clk_id === 0) {
        now = _emscripten_date_now();
      } else if (nowIsMonotonic) {
        now = _emscripten_get_now();
      } else {
        return 52;
      }
      var nsec = Math.round(now * 1e3 * 1e3);
      HEAP64[ptime >> 3] = BigInt(nsec);
      return 0;
    }
    __name(_clock_time_get, "_clock_time_get");
    _clock_time_get.sig = "iijp";
    var getHeapMax = /* @__PURE__ */ __name(() => (
      // Stay one Wasm page short of 4GB: while e.g. Chrome is able to allocate
      // full 4GB Wasm memories, the size will wrap back to 0 bytes in Wasm side
      // for any code that deals with heap sizes, which would require special
      // casing all heap size related code to treat 0 specially.
      2147483648
    ), "getHeapMax");
    var growMemory = /* @__PURE__ */ __name((size) => {
      var b = wasmMemory.buffer;
      var pages = (size - b.byteLength + 65535) / 65536 | 0;
      try {
        wasmMemory.grow(pages);
        updateMemoryViews();
        return 1;
      } catch (e) {
      }
    }, "growMemory");
    var _emscripten_resize_heap = /* @__PURE__ */ __name((requestedSize) => {
      var oldSize = HEAPU8.length;
      requestedSize >>>= 0;
      var maxHeapSize = getHeapMax();
      if (requestedSize > maxHeapSize) {
        return false;
      }
      for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
        var overGrownHeapSize = oldSize * (1 + 0.2 / cutDown);
        overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
        var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
        var replacement = growMemory(newSize);
        if (replacement) {
          return true;
        }
      }
      return false;
    }, "_emscripten_resize_heap");
    _emscripten_resize_heap.sig = "ip";
    var _fd_close = /* @__PURE__ */ __name((fd) => 52, "_fd_close");
    _fd_close.sig = "ii";
    function _fd_seek(fd, offset, whence, newOffset) {
      offset = bigintToI53Checked(offset);
      return 70;
    }
    __name(_fd_seek, "_fd_seek");
    _fd_seek.sig = "iijip";
    var printCharBuffers = [null, [], []];
    var printChar = /* @__PURE__ */ __name((stream, curr) => {
      var buffer = printCharBuffers[stream];
      if (curr === 0 || curr === 10) {
        (stream === 1 ? out : err)(UTF8ArrayToString(buffer));
        buffer.length = 0;
      } else {
        buffer.push(curr);
      }
    }, "printChar");
    var flush_NO_FILESYSTEM = /* @__PURE__ */ __name(() => {
      if (printCharBuffers[1].length) printChar(1, 10);
      if (printCharBuffers[2].length) printChar(2, 10);
    }, "flush_NO_FILESYSTEM");
    var SYSCALLS = {
      varargs: void 0,
      getStr(ptr) {
        var ret = UTF8ToString(ptr);
        return ret;
      }
    };
    var _fd_write = /* @__PURE__ */ __name((fd, iov, iovcnt, pnum) => {
      var num = 0;
      for (var i2 = 0; i2 < iovcnt; i2++) {
        var ptr = LE_HEAP_LOAD_U32((iov >> 2) * 4);
        var len = LE_HEAP_LOAD_U32((iov + 4 >> 2) * 4);
        iov += 8;
        for (var j = 0; j < len; j++) {
          printChar(fd, HEAPU8[ptr + j]);
        }
        num += len;
      }
      LE_HEAP_STORE_U32((pnum >> 2) * 4, num);
      return 0;
    }, "_fd_write");
    _fd_write.sig = "iippp";
    function _tree_sitter_log_callback(isLexMessage, messageAddress) {
      if (Module.currentLogCallback) {
        const message = UTF8ToString(messageAddress);
        Module.currentLogCallback(message, isLexMessage !== 0);
      }
    }
    __name(_tree_sitter_log_callback, "_tree_sitter_log_callback");
    function _tree_sitter_parse_callback(inputBufferAddress, index, row, column, lengthAddress) {
      const INPUT_BUFFER_SIZE = 10 * 1024;
      const string = Module.currentParseCallback(index, {
        row,
        column
      });
      if (typeof string === "string") {
        setValue(lengthAddress, string.length, "i32");
        stringToUTF16(string, inputBufferAddress, INPUT_BUFFER_SIZE);
      } else {
        setValue(lengthAddress, 0, "i32");
      }
    }
    __name(_tree_sitter_parse_callback, "_tree_sitter_parse_callback");
    function _tree_sitter_progress_callback(currentOffset, hasError) {
      if (Module.currentProgressCallback) {
        return Module.currentProgressCallback({
          currentOffset,
          hasError
        });
      }
      return false;
    }
    __name(_tree_sitter_progress_callback, "_tree_sitter_progress_callback");
    function _tree_sitter_query_progress_callback(currentOffset) {
      if (Module.currentQueryProgressCallback) {
        return Module.currentQueryProgressCallback({
          currentOffset
        });
      }
      return false;
    }
    __name(_tree_sitter_query_progress_callback, "_tree_sitter_query_progress_callback");
    var runtimeKeepaliveCounter = 0;
    var keepRuntimeAlive = /* @__PURE__ */ __name(() => noExitRuntime || runtimeKeepaliveCounter > 0, "keepRuntimeAlive");
    var _proc_exit = /* @__PURE__ */ __name((code) => {
      EXITSTATUS = code;
      if (!keepRuntimeAlive()) {
        Module["onExit"]?.(code);
        ABORT = true;
      }
      quit_(code, new ExitStatus(code));
    }, "_proc_exit");
    _proc_exit.sig = "vi";
    var exitJS = /* @__PURE__ */ __name((status, implicit) => {
      EXITSTATUS = status;
      _proc_exit(status);
    }, "exitJS");
    var handleException = /* @__PURE__ */ __name((e) => {
      if (e instanceof ExitStatus || e == "unwind") {
        return EXITSTATUS;
      }
      quit_(1, e);
    }, "handleException");
    var lengthBytesUTF8 = /* @__PURE__ */ __name((str) => {
      var len = 0;
      for (var i2 = 0; i2 < str.length; ++i2) {
        var c = str.charCodeAt(i2);
        if (c <= 127) {
          len++;
        } else if (c <= 2047) {
          len += 2;
        } else if (c >= 55296 && c <= 57343) {
          len += 4;
          ++i2;
        } else {
          len += 3;
        }
      }
      return len;
    }, "lengthBytesUTF8");
    var stringToUTF8Array = /* @__PURE__ */ __name((str, heap, outIdx, maxBytesToWrite) => {
      if (!(maxBytesToWrite > 0)) return 0;
      var startIdx = outIdx;
      var endIdx = outIdx + maxBytesToWrite - 1;
      for (var i2 = 0; i2 < str.length; ++i2) {
        var u = str.charCodeAt(i2);
        if (u >= 55296 && u <= 57343) {
          var u1 = str.charCodeAt(++i2);
          u = 65536 + ((u & 1023) << 10) | u1 & 1023;
        }
        if (u <= 127) {
          if (outIdx >= endIdx) break;
          heap[outIdx++] = u;
        } else if (u <= 2047) {
          if (outIdx + 1 >= endIdx) break;
          heap[outIdx++] = 192 | u >> 6;
          heap[outIdx++] = 128 | u & 63;
        } else if (u <= 65535) {
          if (outIdx + 2 >= endIdx) break;
          heap[outIdx++] = 224 | u >> 12;
          heap[outIdx++] = 128 | u >> 6 & 63;
          heap[outIdx++] = 128 | u & 63;
        } else {
          if (outIdx + 3 >= endIdx) break;
          heap[outIdx++] = 240 | u >> 18;
          heap[outIdx++] = 128 | u >> 12 & 63;
          heap[outIdx++] = 128 | u >> 6 & 63;
          heap[outIdx++] = 128 | u & 63;
        }
      }
      heap[outIdx] = 0;
      return outIdx - startIdx;
    }, "stringToUTF8Array");
    var stringToUTF8 = /* @__PURE__ */ __name((str, outPtr, maxBytesToWrite) => stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite), "stringToUTF8");
    var stackAlloc = /* @__PURE__ */ __name((sz) => __emscripten_stack_alloc(sz), "stackAlloc");
    var stringToUTF8OnStack = /* @__PURE__ */ __name((str) => {
      var size = lengthBytesUTF8(str) + 1;
      var ret = stackAlloc(size);
      stringToUTF8(str, ret, size);
      return ret;
    }, "stringToUTF8OnStack");
    var AsciiToString = /* @__PURE__ */ __name((ptr) => {
      var str = "";
      while (1) {
        var ch = HEAPU8[ptr++];
        if (!ch) return str;
        str += String.fromCharCode(ch);
      }
    }, "AsciiToString");
    var stringToUTF16 = /* @__PURE__ */ __name((str, outPtr, maxBytesToWrite) => {
      maxBytesToWrite ??= 2147483647;
      if (maxBytesToWrite < 2) return 0;
      maxBytesToWrite -= 2;
      var startPtr = outPtr;
      var numCharsToWrite = maxBytesToWrite < str.length * 2 ? maxBytesToWrite / 2 : str.length;
      for (var i2 = 0; i2 < numCharsToWrite; ++i2) {
        var codeUnit = str.charCodeAt(i2);
        LE_HEAP_STORE_I16((outPtr >> 1) * 2, codeUnit);
        outPtr += 2;
      }
      LE_HEAP_STORE_I16((outPtr >> 1) * 2, 0);
      return outPtr - startPtr;
    }, "stringToUTF16");
    var wasmImports = {
      /** @export */
      __heap_base: ___heap_base,
      /** @export */
      __indirect_function_table: wasmTable,
      /** @export */
      __memory_base: ___memory_base,
      /** @export */
      __stack_pointer: ___stack_pointer,
      /** @export */
      __table_base: ___table_base,
      /** @export */
      _abort_js: __abort_js,
      /** @export */
      clock_time_get: _clock_time_get,
      /** @export */
      emscripten_resize_heap: _emscripten_resize_heap,
      /** @export */
      fd_close: _fd_close,
      /** @export */
      fd_seek: _fd_seek,
      /** @export */
      fd_write: _fd_write,
      /** @export */
      memory: wasmMemory,
      /** @export */
      tree_sitter_log_callback: _tree_sitter_log_callback,
      /** @export */
      tree_sitter_parse_callback: _tree_sitter_parse_callback,
      /** @export */
      tree_sitter_progress_callback: _tree_sitter_progress_callback,
      /** @export */
      tree_sitter_query_progress_callback: _tree_sitter_query_progress_callback
    };
    var wasmExports = await createWasm();
    var ___wasm_call_ctors = wasmExports["__wasm_call_ctors"];
    var _malloc = Module["_malloc"] = wasmExports["malloc"];
    var _calloc = Module["_calloc"] = wasmExports["calloc"];
    var _realloc = Module["_realloc"] = wasmExports["realloc"];
    var _free = Module["_free"] = wasmExports["free"];
    var _memcmp = Module["_memcmp"] = wasmExports["memcmp"];
    var _ts_language_symbol_count = Module["_ts_language_symbol_count"] = wasmExports["ts_language_symbol_count"];
    var _ts_language_state_count = Module["_ts_language_state_count"] = wasmExports["ts_language_state_count"];
    var _ts_language_version = Module["_ts_language_version"] = wasmExports["ts_language_version"];
    var _ts_language_abi_version = Module["_ts_language_abi_version"] = wasmExports["ts_language_abi_version"];
    var _ts_language_metadata = Module["_ts_language_metadata"] = wasmExports["ts_language_metadata"];
    var _ts_language_name = Module["_ts_language_name"] = wasmExports["ts_language_name"];
    var _ts_language_field_count = Module["_ts_language_field_count"] = wasmExports["ts_language_field_count"];
    var _ts_language_next_state = Module["_ts_language_next_state"] = wasmExports["ts_language_next_state"];
    var _ts_language_symbol_name = Module["_ts_language_symbol_name"] = wasmExports["ts_language_symbol_name"];
    var _ts_language_symbol_for_name = Module["_ts_language_symbol_for_name"] = wasmExports["ts_language_symbol_for_name"];
    var _strncmp = Module["_strncmp"] = wasmExports["strncmp"];
    var _ts_language_symbol_type = Module["_ts_language_symbol_type"] = wasmExports["ts_language_symbol_type"];
    var _ts_language_field_name_for_id = Module["_ts_language_field_name_for_id"] = wasmExports["ts_language_field_name_for_id"];
    var _ts_lookahead_iterator_new = Module["_ts_lookahead_iterator_new"] = wasmExports["ts_lookahead_iterator_new"];
    var _ts_lookahead_iterator_delete = Module["_ts_lookahead_iterator_delete"] = wasmExports["ts_lookahead_iterator_delete"];
    var _ts_lookahead_iterator_reset_state = Module["_ts_lookahead_iterator_reset_state"] = wasmExports["ts_lookahead_iterator_reset_state"];
    var _ts_lookahead_iterator_reset = Module["_ts_lookahead_iterator_reset"] = wasmExports["ts_lookahead_iterator_reset"];
    var _ts_lookahead_iterator_next = Module["_ts_lookahead_iterator_next"] = wasmExports["ts_lookahead_iterator_next"];
    var _ts_lookahead_iterator_current_symbol = Module["_ts_lookahead_iterator_current_symbol"] = wasmExports["ts_lookahead_iterator_current_symbol"];
    var _ts_parser_delete = Module["_ts_parser_delete"] = wasmExports["ts_parser_delete"];
    var _ts_parser_reset = Module["_ts_parser_reset"] = wasmExports["ts_parser_reset"];
    var _ts_parser_set_language = Module["_ts_parser_set_language"] = wasmExports["ts_parser_set_language"];
    var _ts_parser_timeout_micros = Module["_ts_parser_timeout_micros"] = wasmExports["ts_parser_timeout_micros"];
    var _ts_parser_set_timeout_micros = Module["_ts_parser_set_timeout_micros"] = wasmExports["ts_parser_set_timeout_micros"];
    var _ts_parser_set_included_ranges = Module["_ts_parser_set_included_ranges"] = wasmExports["ts_parser_set_included_ranges"];
    var _ts_query_new = Module["_ts_query_new"] = wasmExports["ts_query_new"];
    var _ts_query_delete = Module["_ts_query_delete"] = wasmExports["ts_query_delete"];
    var _iswspace = Module["_iswspace"] = wasmExports["iswspace"];
    var _iswalnum = Module["_iswalnum"] = wasmExports["iswalnum"];
    var _ts_query_pattern_count = Module["_ts_query_pattern_count"] = wasmExports["ts_query_pattern_count"];
    var _ts_query_capture_count = Module["_ts_query_capture_count"] = wasmExports["ts_query_capture_count"];
    var _ts_query_string_count = Module["_ts_query_string_count"] = wasmExports["ts_query_string_count"];
    var _ts_query_capture_name_for_id = Module["_ts_query_capture_name_for_id"] = wasmExports["ts_query_capture_name_for_id"];
    var _ts_query_capture_quantifier_for_id = Module["_ts_query_capture_quantifier_for_id"] = wasmExports["ts_query_capture_quantifier_for_id"];
    var _ts_query_string_value_for_id = Module["_ts_query_string_value_for_id"] = wasmExports["ts_query_string_value_for_id"];
    var _ts_query_predicates_for_pattern = Module["_ts_query_predicates_for_pattern"] = wasmExports["ts_query_predicates_for_pattern"];
    var _ts_query_start_byte_for_pattern = Module["_ts_query_start_byte_for_pattern"] = wasmExports["ts_query_start_byte_for_pattern"];
    var _ts_query_end_byte_for_pattern = Module["_ts_query_end_byte_for_pattern"] = wasmExports["ts_query_end_byte_for_pattern"];
    var _ts_query_is_pattern_rooted = Module["_ts_query_is_pattern_rooted"] = wasmExports["ts_query_is_pattern_rooted"];
    var _ts_query_is_pattern_non_local = Module["_ts_query_is_pattern_non_local"] = wasmExports["ts_query_is_pattern_non_local"];
    var _ts_query_is_pattern_guaranteed_at_step = Module["_ts_query_is_pattern_guaranteed_at_step"] = wasmExports["ts_query_is_pattern_guaranteed_at_step"];
    var _ts_query_disable_capture = Module["_ts_query_disable_capture"] = wasmExports["ts_query_disable_capture"];
    var _ts_query_disable_pattern = Module["_ts_query_disable_pattern"] = wasmExports["ts_query_disable_pattern"];
    var _ts_tree_copy = Module["_ts_tree_copy"] = wasmExports["ts_tree_copy"];
    var _ts_tree_delete = Module["_ts_tree_delete"] = wasmExports["ts_tree_delete"];
    var _ts_init = Module["_ts_init"] = wasmExports["ts_init"];
    var _ts_parser_new_wasm = Module["_ts_parser_new_wasm"] = wasmExports["ts_parser_new_wasm"];
    var _ts_parser_enable_logger_wasm = Module["_ts_parser_enable_logger_wasm"] = wasmExports["ts_parser_enable_logger_wasm"];
    var _ts_parser_parse_wasm = Module["_ts_parser_parse_wasm"] = wasmExports["ts_parser_parse_wasm"];
    var _ts_parser_included_ranges_wasm = Module["_ts_parser_included_ranges_wasm"] = wasmExports["ts_parser_included_ranges_wasm"];
    var _ts_language_type_is_named_wasm = Module["_ts_language_type_is_named_wasm"] = wasmExports["ts_language_type_is_named_wasm"];
    var _ts_language_type_is_visible_wasm = Module["_ts_language_type_is_visible_wasm"] = wasmExports["ts_language_type_is_visible_wasm"];
    var _ts_language_supertypes_wasm = Module["_ts_language_supertypes_wasm"] = wasmExports["ts_language_supertypes_wasm"];
    var _ts_language_subtypes_wasm = Module["_ts_language_subtypes_wasm"] = wasmExports["ts_language_subtypes_wasm"];
    var _ts_tree_root_node_wasm = Module["_ts_tree_root_node_wasm"] = wasmExports["ts_tree_root_node_wasm"];
    var _ts_tree_root_node_with_offset_wasm = Module["_ts_tree_root_node_with_offset_wasm"] = wasmExports["ts_tree_root_node_with_offset_wasm"];
    var _ts_tree_edit_wasm = Module["_ts_tree_edit_wasm"] = wasmExports["ts_tree_edit_wasm"];
    var _ts_tree_included_ranges_wasm = Module["_ts_tree_included_ranges_wasm"] = wasmExports["ts_tree_included_ranges_wasm"];
    var _ts_tree_get_changed_ranges_wasm = Module["_ts_tree_get_changed_ranges_wasm"] = wasmExports["ts_tree_get_changed_ranges_wasm"];
    var _ts_tree_cursor_new_wasm = Module["_ts_tree_cursor_new_wasm"] = wasmExports["ts_tree_cursor_new_wasm"];
    var _ts_tree_cursor_copy_wasm = Module["_ts_tree_cursor_copy_wasm"] = wasmExports["ts_tree_cursor_copy_wasm"];
    var _ts_tree_cursor_delete_wasm = Module["_ts_tree_cursor_delete_wasm"] = wasmExports["ts_tree_cursor_delete_wasm"];
    var _ts_tree_cursor_reset_wasm = Module["_ts_tree_cursor_reset_wasm"] = wasmExports["ts_tree_cursor_reset_wasm"];
    var _ts_tree_cursor_reset_to_wasm = Module["_ts_tree_cursor_reset_to_wasm"] = wasmExports["ts_tree_cursor_reset_to_wasm"];
    var _ts_tree_cursor_goto_first_child_wasm = Module["_ts_tree_cursor_goto_first_child_wasm"] = wasmExports["ts_tree_cursor_goto_first_child_wasm"];
    var _ts_tree_cursor_goto_last_child_wasm = Module["_ts_tree_cursor_goto_last_child_wasm"] = wasmExports["ts_tree_cursor_goto_last_child_wasm"];
    var _ts_tree_cursor_goto_first_child_for_index_wasm = Module["_ts_tree_cursor_goto_first_child_for_index_wasm"] = wasmExports["ts_tree_cursor_goto_first_child_for_index_wasm"];
    var _ts_tree_cursor_goto_first_child_for_position_wasm = Module["_ts_tree_cursor_goto_first_child_for_position_wasm"] = wasmExports["ts_tree_cursor_goto_first_child_for_position_wasm"];
    var _ts_tree_cursor_goto_next_sibling_wasm = Module["_ts_tree_cursor_goto_next_sibling_wasm"] = wasmExports["ts_tree_cursor_goto_next_sibling_wasm"];
    var _ts_tree_cursor_goto_previous_sibling_wasm = Module["_ts_tree_cursor_goto_previous_sibling_wasm"] = wasmExports["ts_tree_cursor_goto_previous_sibling_wasm"];
    var _ts_tree_cursor_goto_descendant_wasm = Module["_ts_tree_cursor_goto_descendant_wasm"] = wasmExports["ts_tree_cursor_goto_descendant_wasm"];
    var _ts_tree_cursor_goto_parent_wasm = Module["_ts_tree_cursor_goto_parent_wasm"] = wasmExports["ts_tree_cursor_goto_parent_wasm"];
    var _ts_tree_cursor_current_node_type_id_wasm = Module["_ts_tree_cursor_current_node_type_id_wasm"] = wasmExports["ts_tree_cursor_current_node_type_id_wasm"];
    var _ts_tree_cursor_current_node_state_id_wasm = Module["_ts_tree_cursor_current_node_state_id_wasm"] = wasmExports["ts_tree_cursor_current_node_state_id_wasm"];
    var _ts_tree_cursor_current_node_is_named_wasm = Module["_ts_tree_cursor_current_node_is_named_wasm"] = wasmExports["ts_tree_cursor_current_node_is_named_wasm"];
    var _ts_tree_cursor_current_node_is_missing_wasm = Module["_ts_tree_cursor_current_node_is_missing_wasm"] = wasmExports["ts_tree_cursor_current_node_is_missing_wasm"];
    var _ts_tree_cursor_current_node_id_wasm = Module["_ts_tree_cursor_current_node_id_wasm"] = wasmExports["ts_tree_cursor_current_node_id_wasm"];
    var _ts_tree_cursor_start_position_wasm = Module["_ts_tree_cursor_start_position_wasm"] = wasmExports["ts_tree_cursor_start_position_wasm"];
    var _ts_tree_cursor_end_position_wasm = Module["_ts_tree_cursor_end_position_wasm"] = wasmExports["ts_tree_cursor_end_position_wasm"];
    var _ts_tree_cursor_start_index_wasm = Module["_ts_tree_cursor_start_index_wasm"] = wasmExports["ts_tree_cursor_start_index_wasm"];
    var _ts_tree_cursor_end_index_wasm = Module["_ts_tree_cursor_end_index_wasm"] = wasmExports["ts_tree_cursor_end_index_wasm"];
    var _ts_tree_cursor_current_field_id_wasm = Module["_ts_tree_cursor_current_field_id_wasm"] = wasmExports["ts_tree_cursor_current_field_id_wasm"];
    var _ts_tree_cursor_current_depth_wasm = Module["_ts_tree_cursor_current_depth_wasm"] = wasmExports["ts_tree_cursor_current_depth_wasm"];
    var _ts_tree_cursor_current_descendant_index_wasm = Module["_ts_tree_cursor_current_descendant_index_wasm"] = wasmExports["ts_tree_cursor_current_descendant_index_wasm"];
    var _ts_tree_cursor_current_node_wasm = Module["_ts_tree_cursor_current_node_wasm"] = wasmExports["ts_tree_cursor_current_node_wasm"];
    var _ts_node_symbol_wasm = Module["_ts_node_symbol_wasm"] = wasmExports["ts_node_symbol_wasm"];
    var _ts_node_field_name_for_child_wasm = Module["_ts_node_field_name_for_child_wasm"] = wasmExports["ts_node_field_name_for_child_wasm"];
    var _ts_node_field_name_for_named_child_wasm = Module["_ts_node_field_name_for_named_child_wasm"] = wasmExports["ts_node_field_name_for_named_child_wasm"];
    var _ts_node_children_by_field_id_wasm = Module["_ts_node_children_by_field_id_wasm"] = wasmExports["ts_node_children_by_field_id_wasm"];
    var _ts_node_first_child_for_byte_wasm = Module["_ts_node_first_child_for_byte_wasm"] = wasmExports["ts_node_first_child_for_byte_wasm"];
    var _ts_node_first_named_child_for_byte_wasm = Module["_ts_node_first_named_child_for_byte_wasm"] = wasmExports["ts_node_first_named_child_for_byte_wasm"];
    var _ts_node_grammar_symbol_wasm = Module["_ts_node_grammar_symbol_wasm"] = wasmExports["ts_node_grammar_symbol_wasm"];
    var _ts_node_child_count_wasm = Module["_ts_node_child_count_wasm"] = wasmExports["ts_node_child_count_wasm"];
    var _ts_node_named_child_count_wasm = Module["_ts_node_named_child_count_wasm"] = wasmExports["ts_node_named_child_count_wasm"];
    var _ts_node_child_wasm = Module["_ts_node_child_wasm"] = wasmExports["ts_node_child_wasm"];
    var _ts_node_named_child_wasm = Module["_ts_node_named_child_wasm"] = wasmExports["ts_node_named_child_wasm"];
    var _ts_node_child_by_field_id_wasm = Module["_ts_node_child_by_field_id_wasm"] = wasmExports["ts_node_child_by_field_id_wasm"];
    var _ts_node_next_sibling_wasm = Module["_ts_node_next_sibling_wasm"] = wasmExports["ts_node_next_sibling_wasm"];
    var _ts_node_prev_sibling_wasm = Module["_ts_node_prev_sibling_wasm"] = wasmExports["ts_node_prev_sibling_wasm"];
    var _ts_node_next_named_sibling_wasm = Module["_ts_node_next_named_sibling_wasm"] = wasmExports["ts_node_next_named_sibling_wasm"];
    var _ts_node_prev_named_sibling_wasm = Module["_ts_node_prev_named_sibling_wasm"] = wasmExports["ts_node_prev_named_sibling_wasm"];
    var _ts_node_descendant_count_wasm = Module["_ts_node_descendant_count_wasm"] = wasmExports["ts_node_descendant_count_wasm"];
    var _ts_node_parent_wasm = Module["_ts_node_parent_wasm"] = wasmExports["ts_node_parent_wasm"];
    var _ts_node_child_with_descendant_wasm = Module["_ts_node_child_with_descendant_wasm"] = wasmExports["ts_node_child_with_descendant_wasm"];
    var _ts_node_descendant_for_index_wasm = Module["_ts_node_descendant_for_index_wasm"] = wasmExports["ts_node_descendant_for_index_wasm"];
    var _ts_node_named_descendant_for_index_wasm = Module["_ts_node_named_descendant_for_index_wasm"] = wasmExports["ts_node_named_descendant_for_index_wasm"];
    var _ts_node_descendant_for_position_wasm = Module["_ts_node_descendant_for_position_wasm"] = wasmExports["ts_node_descendant_for_position_wasm"];
    var _ts_node_named_descendant_for_position_wasm = Module["_ts_node_named_descendant_for_position_wasm"] = wasmExports["ts_node_named_descendant_for_position_wasm"];
    var _ts_node_start_point_wasm = Module["_ts_node_start_point_wasm"] = wasmExports["ts_node_start_point_wasm"];
    var _ts_node_end_point_wasm = Module["_ts_node_end_point_wasm"] = wasmExports["ts_node_end_point_wasm"];
    var _ts_node_start_index_wasm = Module["_ts_node_start_index_wasm"] = wasmExports["ts_node_start_index_wasm"];
    var _ts_node_end_index_wasm = Module["_ts_node_end_index_wasm"] = wasmExports["ts_node_end_index_wasm"];
    var _ts_node_to_string_wasm = Module["_ts_node_to_string_wasm"] = wasmExports["ts_node_to_string_wasm"];
    var _ts_node_children_wasm = Module["_ts_node_children_wasm"] = wasmExports["ts_node_children_wasm"];
    var _ts_node_named_children_wasm = Module["_ts_node_named_children_wasm"] = wasmExports["ts_node_named_children_wasm"];
    var _ts_node_descendants_of_type_wasm = Module["_ts_node_descendants_of_type_wasm"] = wasmExports["ts_node_descendants_of_type_wasm"];
    var _ts_node_is_named_wasm = Module["_ts_node_is_named_wasm"] = wasmExports["ts_node_is_named_wasm"];
    var _ts_node_has_changes_wasm = Module["_ts_node_has_changes_wasm"] = wasmExports["ts_node_has_changes_wasm"];
    var _ts_node_has_error_wasm = Module["_ts_node_has_error_wasm"] = wasmExports["ts_node_has_error_wasm"];
    var _ts_node_is_error_wasm = Module["_ts_node_is_error_wasm"] = wasmExports["ts_node_is_error_wasm"];
    var _ts_node_is_missing_wasm = Module["_ts_node_is_missing_wasm"] = wasmExports["ts_node_is_missing_wasm"];
    var _ts_node_is_extra_wasm = Module["_ts_node_is_extra_wasm"] = wasmExports["ts_node_is_extra_wasm"];
    var _ts_node_parse_state_wasm = Module["_ts_node_parse_state_wasm"] = wasmExports["ts_node_parse_state_wasm"];
    var _ts_node_next_parse_state_wasm = Module["_ts_node_next_parse_state_wasm"] = wasmExports["ts_node_next_parse_state_wasm"];
    var _ts_query_matches_wasm = Module["_ts_query_matches_wasm"] = wasmExports["ts_query_matches_wasm"];
    var _ts_query_captures_wasm = Module["_ts_query_captures_wasm"] = wasmExports["ts_query_captures_wasm"];
    var _memset = Module["_memset"] = wasmExports["memset"];
    var _memcpy = Module["_memcpy"] = wasmExports["memcpy"];
    var _memmove = Module["_memmove"] = wasmExports["memmove"];
    var _iswalpha = Module["_iswalpha"] = wasmExports["iswalpha"];
    var _iswblank = Module["_iswblank"] = wasmExports["iswblank"];
    var _iswdigit = Module["_iswdigit"] = wasmExports["iswdigit"];
    var _iswlower = Module["_iswlower"] = wasmExports["iswlower"];
    var _iswupper = Module["_iswupper"] = wasmExports["iswupper"];
    var _iswxdigit = Module["_iswxdigit"] = wasmExports["iswxdigit"];
    var _memchr = Module["_memchr"] = wasmExports["memchr"];
    var _strlen = Module["_strlen"] = wasmExports["strlen"];
    var _strcmp = Module["_strcmp"] = wasmExports["strcmp"];
    var _strncat = Module["_strncat"] = wasmExports["strncat"];
    var _strncpy = Module["_strncpy"] = wasmExports["strncpy"];
    var _towlower = Module["_towlower"] = wasmExports["towlower"];
    var _towupper = Module["_towupper"] = wasmExports["towupper"];
    var _setThrew = wasmExports["setThrew"];
    var __emscripten_stack_restore = wasmExports["_emscripten_stack_restore"];
    var __emscripten_stack_alloc = wasmExports["_emscripten_stack_alloc"];
    var _emscripten_stack_get_current = wasmExports["emscripten_stack_get_current"];
    var ___wasm_apply_data_relocs = wasmExports["__wasm_apply_data_relocs"];
    Module["setValue"] = setValue;
    Module["getValue"] = getValue;
    Module["UTF8ToString"] = UTF8ToString;
    Module["stringToUTF8"] = stringToUTF8;
    Module["lengthBytesUTF8"] = lengthBytesUTF8;
    Module["AsciiToString"] = AsciiToString;
    Module["stringToUTF16"] = stringToUTF16;
    Module["loadWebAssemblyModule"] = loadWebAssemblyModule;
    function callMain(args2 = []) {
      var entryFunction = resolveGlobalSymbol("main").sym;
      if (!entryFunction) return;
      args2.unshift(thisProgram);
      var argc = args2.length;
      var argv = stackAlloc((argc + 1) * 4);
      var argv_ptr = argv;
      args2.forEach((arg) => {
        LE_HEAP_STORE_U32((argv_ptr >> 2) * 4, stringToUTF8OnStack(arg));
        argv_ptr += 4;
      });
      LE_HEAP_STORE_U32((argv_ptr >> 2) * 4, 0);
      try {
        var ret = entryFunction(argc, argv);
        exitJS(
          ret,
          /* implicit = */
          true
        );
        return ret;
      } catch (e) {
        return handleException(e);
      }
    }
    __name(callMain, "callMain");
    function run(args2 = arguments_) {
      if (runDependencies > 0) {
        dependenciesFulfilled = run;
        return;
      }
      preRun();
      if (runDependencies > 0) {
        dependenciesFulfilled = run;
        return;
      }
      function doRun() {
        Module["calledRun"] = true;
        if (ABORT) return;
        initRuntime();
        preMain();
        readyPromiseResolve(Module);
        Module["onRuntimeInitialized"]?.();
        var noInitialRun = Module["noInitialRun"];
        if (!noInitialRun) callMain(args2);
        postRun();
      }
      __name(doRun, "doRun");
      if (Module["setStatus"]) {
        Module["setStatus"]("Running...");
        setTimeout(() => {
          setTimeout(() => Module["setStatus"](""), 1);
          doRun();
        }, 1);
      } else {
        doRun();
      }
    }
    __name(run, "run");
    if (Module["preInit"]) {
      if (typeof Module["preInit"] == "function") Module["preInit"] = [Module["preInit"]];
      while (Module["preInit"].length > 0) {
        Module["preInit"].pop()();
      }
    }
    run();
    moduleRtn = readyPromise;
    return moduleRtn;
  };
})();
var tree_sitter_default = Module2;
var Module3 = null;
async function initializeBinding(moduleOptions) {
  if (!Module3) {
    Module3 = await tree_sitter_default(moduleOptions);
  }
  return Module3;
}
__name(initializeBinding, "initializeBinding");
function checkModule() {
  return !!Module3;
}
__name(checkModule, "checkModule");
var TRANSFER_BUFFER;
var LANGUAGE_VERSION;
var MIN_COMPATIBLE_VERSION;
var Parser = class {
  static {
    __name(this, "Parser");
  }
  /** @internal */
  [0] = 0;
  // Internal handle for WASM
  /** @internal */
  [1] = 0;
  // Internal handle for WASM
  /** @internal */
  logCallback = null;
  /** The parser's current language. */
  language = null;
  /**
   * This must always be called before creating a Parser.
   *
   * You can optionally pass in options to configure the WASM module, the most common
   * one being `locateFile` to help the module find the `.wasm` file.
   */
  static async init(moduleOptions) {
    setModule(await initializeBinding(moduleOptions));
    TRANSFER_BUFFER = C._ts_init();
    LANGUAGE_VERSION = C.getValue(TRANSFER_BUFFER, "i32");
    MIN_COMPATIBLE_VERSION = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
  }
  /**
   * Create a new parser.
   */
  constructor() {
    this.initialize();
  }
  /** @internal */
  initialize() {
    if (!checkModule()) {
      throw new Error("cannot construct a Parser before calling `init()`");
    }
    C._ts_parser_new_wasm();
    this[0] = C.getValue(TRANSFER_BUFFER, "i32");
    this[1] = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
  }
  /** Delete the parser, freeing its resources. */
  delete() {
    C._ts_parser_delete(this[0]);
    C._free(this[1]);
    this[0] = 0;
    this[1] = 0;
  }
  /**
   * Set the language that the parser should use for parsing.
   *
   * If the language was not successfully assigned, an error will be thrown.
   * This happens if the language was generated with an incompatible
   * version of the Tree-sitter CLI. Check the language's version using
   * {@link Language#version} and compare it to this library's
   * {@link LANGUAGE_VERSION} and {@link MIN_COMPATIBLE_VERSION} constants.
   */
  setLanguage(language) {
    let address;
    if (!language) {
      address = 0;
      this.language = null;
    } else if (language.constructor === Language) {
      address = language[0];
      const version = C._ts_language_version(address);
      if (version < MIN_COMPATIBLE_VERSION || LANGUAGE_VERSION < version) {
        throw new Error(
          `Incompatible language version ${version}. Compatibility range ${MIN_COMPATIBLE_VERSION} through ${LANGUAGE_VERSION}.`
        );
      }
      this.language = language;
    } else {
      throw new Error("Argument must be a Language");
    }
    C._ts_parser_set_language(this[0], address);
    return this;
  }
  /**
   * Parse a slice of UTF8 text.
   *
   * @param {string | ParseCallback} callback - The UTF8-encoded text to parse or a callback function.
   *
   * @param {Tree | null} [oldTree] - A previous syntax tree parsed from the same document. If the text of the
   *   document has changed since `oldTree` was created, then you must edit `oldTree` to match
   *   the new text using {@link Tree#edit}.
   *
   * @param {ParseOptions} [options] - Options for parsing the text.
   *  This can be used to set the included ranges, or a progress callback.
   *
   * @returns {Tree | null} A {@link Tree} if parsing succeeded, or `null` if:
   *  - The parser has not yet had a language assigned with {@link Parser#setLanguage}.
   *  - The progress callback returned true.
   */
  parse(callback, oldTree, options) {
    if (typeof callback === "string") {
      C.currentParseCallback = (index) => callback.slice(index);
    } else if (typeof callback === "function") {
      C.currentParseCallback = callback;
    } else {
      throw new Error("Argument must be a string or a function");
    }
    if (options?.progressCallback) {
      C.currentProgressCallback = options.progressCallback;
    } else {
      C.currentProgressCallback = null;
    }
    if (this.logCallback) {
      C.currentLogCallback = this.logCallback;
      C._ts_parser_enable_logger_wasm(this[0], 1);
    } else {
      C.currentLogCallback = null;
      C._ts_parser_enable_logger_wasm(this[0], 0);
    }
    let rangeCount = 0;
    let rangeAddress = 0;
    if (options?.includedRanges) {
      rangeCount = options.includedRanges.length;
      rangeAddress = C._calloc(rangeCount, SIZE_OF_RANGE);
      let address = rangeAddress;
      for (let i2 = 0; i2 < rangeCount; i2++) {
        marshalRange(address, options.includedRanges[i2]);
        address += SIZE_OF_RANGE;
      }
    }
    const treeAddress = C._ts_parser_parse_wasm(
      this[0],
      this[1],
      oldTree ? oldTree[0] : 0,
      rangeAddress,
      rangeCount
    );
    if (!treeAddress) {
      C.currentParseCallback = null;
      C.currentLogCallback = null;
      C.currentProgressCallback = null;
      return null;
    }
    if (!this.language) {
      throw new Error("Parser must have a language to parse");
    }
    const result = new Tree(INTERNAL, treeAddress, this.language, C.currentParseCallback);
    C.currentParseCallback = null;
    C.currentLogCallback = null;
    C.currentProgressCallback = null;
    return result;
  }
  /**
   * Instruct the parser to start the next parse from the beginning.
   *
   * If the parser previously failed because of a timeout, cancellation,
   * or callback, then by default, it will resume where it left off on the
   * next call to {@link Parser#parse} or other parsing functions.
   * If you don't want to resume, and instead intend to use this parser to
   * parse some other document, you must call `reset` first.
   */
  reset() {
    C._ts_parser_reset(this[0]);
  }
  /** Get the ranges of text that the parser will include when parsing. */
  getIncludedRanges() {
    C._ts_parser_included_ranges_wasm(this[0]);
    const count = C.getValue(TRANSFER_BUFFER, "i32");
    const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    const result = new Array(count);
    if (count > 0) {
      let address = buffer;
      for (let i2 = 0; i2 < count; i2++) {
        result[i2] = unmarshalRange(address);
        address += SIZE_OF_RANGE;
      }
      C._free(buffer);
    }
    return result;
  }
  /**
   * @deprecated since version 0.25.0, prefer passing a progress callback to {@link Parser#parse}
   *
   * Get the duration in microseconds that parsing is allowed to take.
   *
   * This is set via {@link Parser#setTimeoutMicros}.
   */
  getTimeoutMicros() {
    return C._ts_parser_timeout_micros(this[0]);
  }
  /**
   * @deprecated since version 0.25.0, prefer passing a progress callback to {@link Parser#parse}
   *
   * Set the maximum duration in microseconds that parsing should be allowed
   * to take before halting.
   *
   * If parsing takes longer than this, it will halt early, returning `null`.
   * See {@link Parser#parse} for more information.
   */
  setTimeoutMicros(timeout) {
    C._ts_parser_set_timeout_micros(this[0], 0, timeout);
  }
  /** Set the logging callback that a parser should use during parsing. */
  setLogger(callback) {
    if (!callback) {
      this.logCallback = null;
    } else if (typeof callback !== "function") {
      throw new Error("Logger callback must be a function");
    } else {
      this.logCallback = callback;
    }
    return this;
  }
  /** Get the parser's current logger. */
  getLogger() {
    return this.logCallback;
  }
};

// src/version.ts
var VERSION = "0.1.0";
function isBundled() {
  return true;
}

// src/treesitter.ts
var RUNTIME_WASM = "tree-sitter.wasm";
var GRAMMAR_DIR = "grammars";
function vendorDir() {
  const here = path16.dirname(fileURLToPath(import.meta.url));
  return isBundled() ? here : path16.join(here, "..", "bin");
}
function runtimeWasmPath(dir = vendorDir()) {
  return path16.join(dir, RUNTIME_WASM);
}
function grammarWasmPath(key, dir = vendorDir()) {
  return path16.join(dir, GRAMMAR_DIR, grammarWasmName(key));
}
async function exists(file) {
  try {
    await fs10.access(file);
    return true;
  } catch (error) {
    const err2 = error;
    if (err2.code === "ENOENT") return false;
    throw new Error(`could not look at ${file}: ${err2.code ?? err2.message}`);
  }
}
var started = null;
async function start2() {
  if (started !== null) return started;
  const runtime = runtimeWasmPath();
  started = (async () => {
    if (!await exists(runtime)) {
      throw new Error(
        `the tree-sitter runtime is missing at ${runtime}. Run "stop-rules init" again in this repo to copy it.`
      );
    }
    await Parser.init({ locateFile: () => runtime });
  })();
  return started;
}
var parsers = /* @__PURE__ */ new Map();
async function parseSource(key, source) {
  const wasm = grammarWasmPath(key);
  if (!await exists(wasm)) {
    return { ok: false, kind: "not-installed", reason: `no grammar installed for ${GRAMMAR_TITLE[key]}` };
  }
  await start2();
  let parser = parsers.get(key);
  if (parser === void 0) {
    let language;
    try {
      language = await Language.load(wasm);
    } catch (error) {
      return {
        ok: false,
        kind: "failed",
        reason: `could not load the ${GRAMMAR_TITLE[key]} grammar from ${wasm}: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    parser = new Parser();
    parser.setLanguage(language);
    parsers.set(key, parser);
  }
  let root = null;
  try {
    const tree = parser.parse(source);
    root = tree === null ? null : tree.rootNode;
  } catch (error) {
    return {
      ok: false,
      kind: "failed",
      reason: `the ${GRAMMAR_TITLE[key]} parser failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (root === null) {
    return { ok: false, kind: "failed", reason: `the ${GRAMMAR_TITLE[key]} parser returned no tree` };
  }
  return { ok: true, root };
}

// src/cut.ts
function describeExtension(filePath) {
  const extension = extensionOf(filePath);
  return extension.length === 0 ? "a file with no extension" : extension;
}
async function cutFiles(files, options) {
  const pieces = [];
  const notChecked = [];
  const cutByHunk = [];
  const missing = /* @__PURE__ */ new Set();
  if (options.cut === "hunks") {
    for (const file of files) pieces.push(...piecesByHunk(file));
    return { pieces, notChecked, cutByHunk };
  }
  if (options.cut === "chunks") {
    for (const file of files) pieces.push(...chunkPieces(file));
    return { pieces, notChecked, cutByHunk };
  }
  for (const file of files) {
    const key = grammarForPath(file.file);
    if (key === null) {
      pieces.push(...piecesByHunk(file));
      cutByHunk.push({ file: file.file, reason: `no grammar for ${describeExtension(file.file)}` });
      continue;
    }
    const range = chunkRange(file);
    const source = await options.readSource(file.file);
    if (source === null) {
      notChecked.push({
        file: file.file,
        fromLine: range.from,
        toLine: range.to,
        reason: "stop-rules could not read this file out of the snapshot it took"
      });
      continue;
    }
    const parsed = await parseSource(key, source);
    if (!parsed.ok) {
      if (parsed.kind === "not-installed") {
        missing.add(describeExtension(file.file));
        continue;
      }
      notChecked.push({
        file: file.file,
        fromLine: range.from,
        toLine: range.to,
        reason: parsed.reason
      });
      continue;
    }
    const broken = new Set(errorRows(parsed.root));
    const added = addedLines(file).map((line) => line.line);
    if (added.some((line) => broken.has(line))) {
      notChecked.push({
        file: file.file,
        fromLine: range.from,
        toLine: range.to,
        reason: `could not be parsed as ${GRAMMAR_TITLE[key]}`
      });
      continue;
    }
    const table = TABLES[key];
    pieces.push(...buildPieces(file, source, table, parsed.root));
  }
  for (const extension of [...missing].sort()) {
    notChecked.push({
      reason: `no grammar installed for ${extension}, run stop-rules init again to add it`
    });
  }
  return { pieces, notChecked, cutByHunk };
}

// src/engine.ts
var DEFAULT_THRESHOLD = 0.6;
var DEFAULT_MAX_CALLS = 60;
var PIECES_PER_CALL = 4;
var PACK_MAX_BYTES = 6e4;
var MAX_RULES_PER_CALL = 200;
var CACHE_KEY_VERSION = "v1";
var CACHE_PIECE_KEY = "p0";
function stage1Claim(rule, key) {
  return `The added lines in the diff state.pieces.${key} violate this coding rule: ${rule.text}`;
}
var encoder2 = new TextEncoder();
async function sha256Hex(parts2) {
  const digest2 = await globalThis.crypto.subtle.digest(
    "SHA-256",
    encoder2.encode(parts2.join("\0"))
  );
  return [...new Uint8Array(digest2)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function cacheKey(model, claim, state) {
  return sha256Hex([CACHE_KEY_VERSION, model, claim, JSON.stringify(state)]);
}
function soloState(piece) {
  return { pieces: { [CACHE_PIECE_KEY]: { file: piece.file, diff: chunkText(piece) } } };
}
function reasonFor(failure2, message) {
  return failure2 === "budget" ? "call budget exhausted" : message;
}
function notCheckedFor(piece, reason) {
  return { file: piece.file, fromLine: piece.fromLine, toLine: piece.toLine, reason };
}
function packQuestions(work) {
  const pieces = {};
  const questions = {};
  const byQuestion = {};
  work.forEach((item, index) => {
    const key = `p${index}`;
    pieces[key] = { file: item.piece.file, diff: chunkText(item.piece) };
    item.rules.forEach((rule, ruleIndex) => {
      const id = `q${index}_${ruleIndex}`;
      questions[id] = { type: "noul", instructions: stage1Claim(rule, key) };
      byQuestion[id] = { piece: item.piece, rule };
    });
  });
  return { state: { pieces }, questions, byQuestion };
}
function packBytes(model, work) {
  const { state, questions } = packQuestions(work);
  return utf8Bytes(JSON.stringify({ state, model, questions }));
}
function makePackNode(model, work) {
  const { state, questions, byQuestion } = packQuestions(work);
  return {
    payload: { work, byQuestion },
    state,
    questions,
    halve: () => {
      if (work.length > 1) {
        const mid = Math.ceil(work.length / 2);
        return [makePackNode(model, work.slice(0, mid)), makePackNode(model, work.slice(mid))];
      }
      const only = work[0];
      if (only === void 0) return null;
      const halves = halvePiece(only.piece);
      if (halves === null) return null;
      return [
        makePackNode(model, [{ piece: halves[0], rules: only.rules }]),
        makePackNode(model, [{ piece: halves[1], rules: only.rules }])
      ];
    }
  };
}
function packWork(model, work) {
  const packs = [];
  let current = [];
  for (const item of work) {
    if (current.length === 0) {
      current.push(item);
      continue;
    }
    const candidate = [...current, item];
    if (candidate.length > PIECES_PER_CALL || packBytes(model, candidate) > PACK_MAX_BYTES) {
      packs.push(current);
      current = [item];
      continue;
    }
    current = candidate;
  }
  if (current.length > 0) packs.push(current);
  return packs;
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
    ...input.concurrency !== void 0 ? { concurrency: input.concurrency } : {},
    ...input.slot ? { slot: input.slot } : {}
  });
  const notChecked = [];
  const scored = [];
  const piecesPerCall = [];
  let cacheHits = 0;
  let answered = 0;
  let holdBaseline = false;
  let transportFailed = false;
  let blocked = null;
  const noteFailure = (failure2) => {
    if (blocked !== null) return;
    if (failure2 === "auth") blocked = "auth";
    else if (failure2 === "billing") blocked = "billing";
    else if (failure2 === "busy") blocked = "busy";
  };
  const work = [];
  for (const piece of input.pieces) {
    const state = soloState(piece);
    const uncached = [];
    for (const rule of input.rules) {
      const cached = cache.get(await cacheKey(model, stage1Claim(rule, CACHE_PIECE_KEY), state));
      if (cached === void 0) {
        uncached.push(rule);
        continue;
      }
      cacheHits += 1;
      answered += 1;
      scored.push({ piece, rule, score: cached });
    }
    for (let i2 = 0; i2 < uncached.length; i2 += MAX_RULES_PER_CALL) {
      work.push({ piece, rules: uncached.slice(i2, i2 + MAX_RULES_PER_CALL) });
    }
  }
  const stage1Nodes = packWork(model, work).map((pack) => makePackNode(model, pack));
  for (const result of await client.askAll(stage1Nodes)) {
    const { work: sent, byQuestion } = result.node.payload;
    piecesPerCall.push(sent.length);
    if (!result.outcome.ok) {
      const failure2 = result.outcome.failure;
      if (holdsBaseline(failure2)) holdBaseline = true;
      noteFailure(failure2);
      if (failure2 !== "budget") transportFailed = true;
      for (const item of sent) {
        notChecked.push(notCheckedFor(item.piece, reasonFor(failure2, result.outcome.message)));
      }
      continue;
    }
    for (const [id, target] of Object.entries(byQuestion)) {
      const noul = result.outcome.answers[id];
      if (noul === void 0) {
        note(`Jev returned no answer for rule ${target.rule.id} on ${target.piece.file}`);
        notChecked.push(
          notCheckedFor(target.piece, `Jev returned no answer for rule ${target.rule.id}`)
        );
        continue;
      }
      answered += 1;
      cache.set(
        await cacheKey(model, stage1Claim(target.rule, CACHE_PIECE_KEY), soloState(target.piece)),
        noul
      );
      scored.push({ piece: target.piece, rule: target.rule, score: noul });
    }
  }
  const hits = scored.filter((hit) => hit.score >= threshold);
  const fresh = input.skipFinding === void 0 ? hits : hits.filter((hit) => !input.skipFinding?.(hit.rule.id, chunkText(hit.piece)));
  const findings = fresh.map((hit) => ({ ruleId: hit.rule.id, pieceText: chunkText(hit.piece) }));
  const pieces = groupByPiece(fresh);
  const fromLineOf = (entry) => entry.fromLine === void 0 ? 0 : entry.fromLine;
  notChecked.sort((a, b) => {
    const fileA = a.file ?? "";
    const fileB = b.file ?? "";
    return fileA === fileB ? fromLineOf(a) - fromLineOf(b) : fileA < fileB ? -1 : 1;
  });
  return {
    pieces,
    scores: groupScores(scored),
    notChecked,
    calls: client.calls,
    cacheHits,
    answered,
    piecesPerCall,
    transportFailed,
    holdBaseline,
    blocked,
    usage: client.usage,
    findings
  };
}
function groupByPiece(fresh) {
  const byPiece = /* @__PURE__ */ new Map();
  for (const hit of fresh) {
    const text = chunkText(hit.piece);
    const broken = {
      ruleId: hit.rule.id,
      rule: hit.rule.text,
      confidence: hit.score
    };
    const existing = byPiece.get(text);
    if (existing !== void 0) {
      existing.rules.push(broken);
      continue;
    }
    byPiece.set(text, {
      file: hit.piece.file,
      unit: hit.piece.unitName,
      fromLine: hit.piece.fromLine,
      toLine: hit.piece.toLine,
      diff: text,
      rules: [broken]
    });
  }
  const pieces = [...byPiece.values()];
  for (const piece of pieces) {
    piece.rules.sort((a, b) => b.confidence - a.confidence);
  }
  pieces.sort((a, b) => a.file === b.file ? a.fromLine - b.fromLine : a.file < b.file ? -1 : 1);
  return pieces;
}
function groupScores(scored) {
  const byPiece = /* @__PURE__ */ new Map();
  for (const hit of scored) {
    const text = chunkText(hit.piece);
    const entry = {
      ruleId: hit.rule.id,
      rule: hit.rule.text,
      score: hit.score
    };
    const existing = byPiece.get(text);
    if (existing !== void 0) {
      existing.rules.push(entry);
      continue;
    }
    byPiece.set(text, {
      file: hit.piece.file,
      unit: hit.piece.unitName,
      fromLine: hit.piece.fromLine,
      toLine: hit.piece.toLine,
      rules: [entry]
    });
  }
  const pieces = [...byPiece.values()];
  for (const piece of pieces) piece.rules.sort((a, b) => b.score - a.score);
  const top = (piece) => piece.rules[0]?.score ?? 0;
  pieces.sort((a, b) => {
    if (top(a) !== top(b)) return top(b) - top(a);
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.fromLine - b.fromLine;
  });
  return pieces;
}

// src/git.ts
import { execFile } from "node:child_process";
import { promises as fs11 } from "node:fs";
import * as path17 from "node:path";
import { randomBytes } from "node:crypto";
var MAX_BUFFER = 256 * 1024 * 1024;
function runGit(cwd, args2, extraEnv) {
  return new Promise((resolve3, reject) => {
    execFile(
      "git",
      args2,
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
        reject(new Error(`could not run git ${args2.join(" ")}: ${error.message}`));
      }
    );
  });
}
async function gitOrThrow(cwd, args2, extraEnv) {
  const result = await runGit(cwd, args2, extraEnv);
  if (result.code !== 0) {
    throw new Error(`git ${args2.join(" ")} failed (exit ${result.code}): ${result.stderr.trim()}`);
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
  const out3 = await gitOrThrow(root, ["hash-object", "-w", "-t", "tree", "--stdin"]);
  return out3.trim();
}
async function snapshotWorkingTree(repo, stateDir) {
  await fs11.mkdir(stateDir, { recursive: true });
  const indexPath = path17.join(stateDir, `index-${process.pid}-${randomBytes(4).toString("hex")}`);
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    if (await hasHead(repo.root)) {
      await gitOrThrow(repo.root, ["read-tree", "HEAD"], env);
    }
    await gitOrThrow(repo.root, ["add", "-A", "--", "."], env);
    const tree = await gitOrThrow(repo.root, ["write-tree"], env);
    return tree.trim();
  } finally {
    await fs11.rm(indexPath, { force: true });
    await fs11.rm(`${indexPath}.lock`, { force: true });
  }
}
async function readBlob(root, tree, filePath) {
  const result = await runGit(root, ["cat-file", "blob", `${tree}:${filePath}`]);
  if (result.code !== 0) return null;
  return result.stdout;
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
var MAX_PIECE_LINES = 60;
function confidence(score) {
  return score.toFixed(2);
}
function where(from, to) {
  return from === to ? `line ${from}` : `lines ${from}-${to}`;
}
function notCheckedLine(entry) {
  if (entry.file === void 0) return entry.reason;
  if (entry.fromLine === void 0 || entry.toLine === void 0) {
    return `${entry.file}: ${entry.reason}`;
  }
  return `${entry.file} ${where(entry.fromLine, entry.toLine)}: ${entry.reason}`;
}
function isDiffHeader(line) {
  return line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("old mode ") || line.startsWith("new mode ") || line.startsWith("new file mode ") || line.startsWith("deleted file mode ") || line.startsWith("similarity index ") || line.startsWith("rename from ") || line.startsWith("rename to ");
}
function pieceDiff(piece) {
  const lines = piece.diff.split("\n").filter((line) => line.length > 0 && !isDiffHeader(line));
  const shown = lines.slice(0, MAX_PIECE_LINES).map((line) => `   ${line}`);
  const left = lines.length - MAX_PIECE_LINES;
  if (left > 0) shown.push(`   ... ${left} more lines in this piece`);
  return shown;
}
function ruleLines(rule) {
  return [`   Rule: ${rule.rule}`, `   Confidence: ${confidence(rule.confidence)}`];
}
function pieceBlock(piece, index) {
  const unit = piece.unit === null ? "" : ` in ${piece.unit}`;
  const heading = piece.rules.length === 1 ? `${index}. ${piece.file} ${where(piece.fromLine, piece.toLine)}${unit} breaks 1 rule` : `${index}. ${piece.file} ${where(piece.fromLine, piece.toLine)}${unit} breaks ${piece.rules.length} rules`;
  return [
    heading,
    ...piece.rules.flatMap(ruleLines),
    "   The change this is about:",
    ...pieceDiff(piece)
  ].join("\n");
}
function notCheckedSections(notChecked) {
  if (notChecked.length === 1) {
    const only = notChecked[0];
    return only === void 0 ? [] : [`Not checked (1): ${notCheckedLine(only)}`];
  }
  if (notChecked.length > 1) {
    return [
      `Not checked (${notChecked.length}):
` + notChecked.map((entry) => `  ${notCheckedLine(entry)}`).join("\n")
    ];
  }
  return [];
}
function renderReport(report) {
  const { pieces, notChecked, stats } = report;
  const sections = [];
  if (pieces.length === 0) {
    sections.push(
      stats.pieces === 0 ? "stop-rules: no changes to check." : "stop-rules: no rule violations in your latest changes."
    );
  } else {
    const broken = pieces.reduce((total, piece) => total + piece.rules.length, 0);
    const count = broken === 1 ? "1 rule violation" : `${broken} rule violations`;
    const places = pieces.length === 1 ? "1 place" : `${pieces.length} places`;
    sections.push(
      `stop-rules: ${count} in ${places} in your latest changes.
Fix each one. If a rule truly should not apply here, leave the code and tell the user why.`
    );
    sections.push(pieces.map((piece, i2) => pieceBlock(piece, i2 + 1)).join("\n\n"));
  }
  sections.push(...notCheckedSections(notChecked));
  return sections.join("\n\n");
}
function cutWords(cut) {
  if (cut === "functions") return "whole functions, with tree-sitter";
  if (cut === "hunks") return "one diff hunk each, with no parser";
  return "diff hunks grouped into 12,000 byte chunks, with no parser";
}
function scoreBlock(piece, index) {
  const unit = piece.unit === null ? "" : ` in ${piece.unit}`;
  const lines = [`${index}. ${piece.file} ${where(piece.fromLine, piece.toLine)}${unit}`];
  for (const rule of piece.rules) lines.push(`   ${confidence(rule.score)}  ${rule.rule}`);
  return lines.join("\n");
}
function renderScores(report) {
  const { pieces, notChecked, stats, source } = report;
  const sections = [];
  const scores = pieces.reduce((total, piece) => total + piece.rules.length, 0);
  if (pieces.length === 0) {
    sections.push(`stop-rules score: nothing to score in ${source}.`);
  } else {
    const count = pieces.length === 1 ? "1 piece" : `${pieces.length} pieces`;
    sections.push(
      `stop-rules score: ${count}, ${scores} scores, ${stats.calls} Jev calls, ${stats.cacheHits} answers from the cache.
Scored ${source}. No cutoff applied, nothing was marked as checked, and the baseline did not move.`
    );
    sections.push(pieces.map((piece, i2) => scoreBlock(piece, i2 + 1)).join("\n\n"));
  }
  sections.push(...notCheckedSections(notChecked));
  return sections.join("\n\n");
}

// src/rules.ts
import { createHash } from "node:crypto";
import { promises as fs12 } from "node:fs";
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
    source = await fs12.readFile(rulesPath, "utf8");
  } catch (error) {
    const err2 = error;
    if (err2.code === "ENOENT") {
      return {
        ok: false,
        reason: `no rules file at ${rulesPath}. Run "stop-rules init" to create one.`
      };
    }
    return { ok: false, reason: `could not read ${rulesPath}: ${err2.message}` };
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
`;

// src/slots.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { promises as fs13 } from "node:fs";
import * as os from "node:os";
import * as path18 from "node:path";
import { setTimeout as delay } from "node:timers/promises";
var MACHINE_SLOTS = 8;
var SLOT_WAIT_MS = 6e4;
var SLOT_STALE_MS = 12e4;
var POLL_MS = 100;
var MACHINE_BUSY = "Jev is busy on this machine, this change will be checked on the next run";
function slotsDir(env) {
  const configured = env["XDG_CACHE_HOME"];
  if (configured !== void 0) {
    if (configured.trim().length === 0) {
      throw new Error("XDG_CACHE_HOME is set but empty. Unset it or point it at a folder.");
    }
    return path18.join(configured, "stop-rules", "slots");
  }
  const home = os.homedir();
  if (process.platform === "darwin") return path18.join(home, "Library", "Caches", "stop-rules", "slots");
  return path18.join(home, ".cache", "stop-rules", "slots");
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err2 = error;
    return err2.code === "EPERM";
  }
}
function readSlot(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const pid = parsed.pid;
  const at = parsed.at;
  if (typeof pid !== "number" || typeof at !== "number") return null;
  return { pid, at };
}
async function acquireSlot(dir, waitMs = SLOT_WAIT_MS) {
  await fs13.mkdir(dir, { recursive: true });
  const deadline = Date.now() + waitMs;
  for (; ; ) {
    const claim = path18.join(dir, `claim-${process.pid}-${randomBytes2(4).toString("hex")}`);
    await fs13.writeFile(claim, JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
    try {
      for (let index = 0; index < MACHINE_SLOTS; index += 1) {
        const file = path18.join(dir, `slot-${index}`);
        try {
          await fs13.link(claim, file);
          return {
            ok: true,
            release: async () => {
              try {
                const owner2 = readSlot(await fs13.readFile(file, "utf8"));
                if (owner2 !== null && owner2.pid === process.pid) await fs13.rm(file, { force: true });
              } catch (error) {
                const err2 = error;
                if (err2.code !== "ENOENT") {
                  process.stderr.write(`stop-rules: could not free a Jev slot: ${err2.message}
`);
                }
              }
            }
          };
        } catch (error) {
          const err2 = error;
          if (err2.code !== "EEXIST") throw err2;
        }
        let owner = null;
        let writtenAt = 0;
        try {
          owner = readSlot(await fs13.readFile(file, "utf8"));
          writtenAt = owner === null ? (await fs13.stat(file)).mtimeMs : owner.at;
        } catch (error) {
          const err2 = error;
          if (err2.code !== "ENOENT") throw err2;
          continue;
        }
        const tooOld = Date.now() - writtenAt > SLOT_STALE_MS;
        if (tooOld || owner !== null && !pidAlive(owner.pid)) {
          await fs13.rm(file, { force: true });
        }
      }
    } finally {
      await fs13.rm(claim, { force: true });
    }
    if (Date.now() >= deadline) return { ok: false, reason: MACHINE_BUSY };
    await delay(POLL_MS);
  }
}

// src/state.ts
import { createHash as createHash2, randomBytes as randomBytes3 } from "node:crypto";
import { promises as fs14 } from "node:fs";
import * as path19 from "node:path";
import { setTimeout as delay2 } from "node:timers/promises";
var MAX_CACHE_ENTRIES = 5e3;
var MAX_REPORTED_ENTRIES = 5e3;
var MAX_LOG_BYTES = 1024 * 1024;
var LOCK_POLL_MS = 200;
function stateDirFor(gitDir) {
  return path19.join(gitDir, "stop-rules");
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
    text = await fs14.readFile(file, "utf8");
  } catch (error) {
    const err2 = error;
    if (err2.code === "ENOENT") return null;
    throw new Error(`could not read ${file}: ${err2.code ?? err2.message}`);
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
  const temp = `${file}.tmp-${process.pid}-${randomBytes3(4).toString("hex")}`;
  await fs14.mkdir(path19.dirname(file), { recursive: true });
  await fs14.writeFile(temp, `${JSON.stringify(value2)}
`, "utf8");
  await fs14.rename(temp, file);
}
function isRecord2(value2) {
  return typeof value2 === "object" && value2 !== null && !Array.isArray(value2);
}
async function loadState(stateDir) {
  const file = path19.join(stateDir, "state.json");
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
  await writeJsonAtomic(path19.join(stateDir, "state.json"), state);
}
async function loadCache(stateDir) {
  const file = path19.join(stateDir, "cache.json");
  const raw = await readJson(file);
  if (raw === null) return emptyCache();
  if (!isRecord2(raw) || !isRecord2(raw["entries"])) {
    throw new Error(`${file} is not a stop-rules cache. Delete it and run again.`);
  }
  return { version: 1, entries: raw["entries"] };
}
async function resetState(stateDir) {
  await writeJsonAtomic(path19.join(stateDir, "state.json"), emptyState());
}
async function saveCache(stateDir, cache) {
  prune(cache.entries, (value2) => value2.at, MAX_CACHE_ENTRIES);
  await writeJsonAtomic(path19.join(stateDir, "cache.json"), cache);
}
function reportedKey(ruleId2, chunkText2) {
  return createHash2("sha256").update(`${ruleId2}\0${chunkText2}`, "utf8").digest("hex");
}
function pidAlive2(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err2 = error;
    if (err2.code === "EPERM") return true;
    return false;
  }
}
async function acquireLock(stateDir, timeoutMs = 6e4) {
  await fs14.mkdir(stateDir, { recursive: true });
  const lockPath = path19.join(stateDir, "lock");
  const deadline = Date.now() + timeoutMs;
  for (; ; ) {
    try {
      const handle3 = await fs14.open(lockPath, "wx");
      try {
        await handle3.writeFile(String(process.pid), "utf8");
      } finally {
        await handle3.close();
      }
      return async () => {
        try {
          const owner = await fs14.readFile(lockPath, "utf8");
          if (owner.trim() === String(process.pid)) await fs14.rm(lockPath, { force: true });
        } catch (error) {
          const err2 = error;
          if (err2.code !== "ENOENT") {
            process.stderr.write(`stop-rules: could not release the lock: ${err2.message}
`);
          }
        }
      };
    } catch (error) {
      const err2 = error;
      if (err2.code !== "EEXIST") throw err2;
    }
    let ownerPid = 0;
    try {
      ownerPid = Number.parseInt((await fs14.readFile(lockPath, "utf8")).trim(), 10);
    } catch (readError) {
      const err2 = readError;
      if (err2.code !== "ENOENT") throw err2;
      continue;
    }
    if (!pidAlive2(ownerPid)) {
      await fs14.rm(lockPath, { force: true });
      continue;
    }
    if (Date.now() >= deadline) return null;
    await delay2(LOCK_POLL_MS);
  }
}
async function appendRunLog(stateDir, line) {
  const logPath = path19.join(stateDir, "run.log");
  await fs14.mkdir(stateDir, { recursive: true });
  await fs14.appendFile(logPath, `${JSON.stringify(line)}
`, "utf8");
  const stats = await fs14.stat(logPath);
  if (stats.size <= MAX_LOG_BYTES) return;
  const contents = await fs14.readFile(logPath, "utf8");
  const lines = contents.split("\n").filter((entry) => entry.length > 0);
  const kept = lines.slice(Math.floor(lines.length / 2));
  const temp = `${logPath}.tmp-${process.pid}-${randomBytes3(4).toString("hex")}`;
  await fs14.writeFile(temp, `${kept.join("\n")}
`, "utf8");
  await fs14.rename(temp, logPath);
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
async function run2(options) {
  const started2 = Date.now();
  const env = options.env ?? process.env;
  const notes = [];
  const note = (message) => {
    notes.push(message);
  };
  const repo = await findRepo(options.cwd);
  if (repo === null) return cannotRun(`${options.cwd} is not inside a git repository.`);
  const rulesPath = options.rulesPath ? path20.resolve(options.cwd, options.rulesPath) : path20.join(repo.root, ".stop-rules.md");
  const rulesLoad = await loadRules(rulesPath);
  if (!rulesLoad.ok) return cannotRun(rulesLoad.reason);
  const settingsLoad = await loadSettings(repo.root);
  if (!settingsLoad.ok) return cannotRun(settingsLoad.reason);
  const settings = settingsLoad.loaded.settings;
  const knobs = {
    threshold: options.threshold ?? settings.threshold ?? DEFAULT_THRESHOLD,
    maxCalls: options.maxCalls ?? settings.maxCalls ?? DEFAULT_MAX_CALLS,
    cut: options.cut ?? settings.cut ?? DEFAULT_CUT
  };
  const credentials = await resolveCredentials(settingsLoad.loaded, env);
  if (!credentials.ok) return cannotRun(credentials.reason);
  let slotDir;
  try {
    slotDir = slotsDir(env);
  } catch (error) {
    return cannotRun(error instanceof Error ? error.message : String(error));
  }
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
      knobs,
      stateDir,
      slotDir,
      notes,
      note,
      started: started2
    });
  } finally {
    await release();
  }
}
async function diffFileWork(args2, diffFile) {
  const full = path20.resolve(args2.options.cwd, diffFile);
  let text;
  try {
    text = await fs15.readFile(full, "utf8");
  } catch (error) {
    const err2 = error;
    return { ok: false, reason: `could not read the diff file ${full}: ${err2.code ?? err2.message}` };
  }
  const parsed = parseDiff(text, []);
  if (parsed.files.length === 0 && parsed.failures.length === 0) {
    return { ok: false, reason: `${full} holds no diff with added lines.` };
  }
  const asked = args2.knobs.cut;
  const cut = asked === "functions" ? "hunks" : asked;
  const why = asked === "functions" ? " (a diff file has no file content, so it cannot be cut into functions)" : "";
  return {
    ok: true,
    work: {
      files: parsed.files,
      skipped: parsed.skipped,
      failures: parsed.failures.map((failure2) => ({ file: failure2.file, reason: failure2.reason })),
      readSource: async () => null,
      snapshot: null,
      cut,
      source: `${diffFile}, cut into ${cutWords(cut)}${why}`
    }
  };
}
async function workingTreeWork(args2, state) {
  const { options, repo, rulesPath, stateDir, knobs } = args2;
  const snapshot = await snapshotWorkingTree(repo, stateDir);
  let baseline;
  if (options.base !== void 0) {
    const resolved = await resolveTree(repo.root, options.base);
    if (resolved === null) return { ok: false, reason: `unknown revision ${options.base}.` };
    baseline = resolved;
  } else if (state.lastTree !== void 0) {
    if (!await objectExists(repo.root, state.lastTree)) {
      return {
        ok: false,
        reason: "the saved baseline is gone (git cleaned it up). Run stop-rules baseline --reset to start again from HEAD."
      };
    }
    baseline = state.lastTree;
  } else if (await hasHead(repo.root)) {
    const head = await resolveTree(repo.root, "HEAD");
    if (head === null) {
      return { ok: false, reason: "git could not resolve HEAD to a tree in this repository." };
    }
    baseline = head;
  } else {
    baseline = await emptyTree(repo.root);
  }
  const rulesRelative = path20.relative(repo.root, rulesPath).split(path20.sep).join("/");
  const parsed = parseDiff(await diffTrees(repo.root, baseline, snapshot), [rulesRelative]);
  const against = options.base === void 0 ? "the last check" : `${options.base}`;
  return {
    ok: true,
    work: {
      files: parsed.files,
      skipped: parsed.skipped,
      failures: parsed.failures.map((failure2) => ({ file: failure2.file, reason: failure2.reason })),
      readSource: (file) => readBlob(repo.root, snapshot, file),
      snapshot,
      cut: knobs.cut,
      source: `the working tree against ${against}, cut into ${cutWords(knobs.cut)}`
    }
  };
}
async function runLocked(args2) {
  const { options, rules, credentials, knobs, stateDir, notes, note, started: started2 } = args2;
  const model = credentials.model;
  let state;
  let cache;
  try {
    state = await loadState(stateDir);
    cache = await loadCache(stateDir);
  } catch (error) {
    return cannotRun(error instanceof Error ? error.message : String(error));
  }
  const prepared = options.diffFile === void 0 ? await workingTreeWork(args2, state) : await diffFileWork(args2, options.diffFile);
  if (!prepared.ok) return cannotRun(prepared.reason);
  const work = prepared.work;
  let cut;
  try {
    cut = await cutFiles(work.files, { cut: work.cut, readSource: work.readSource });
  } catch (error) {
    return cannotRun(error instanceof Error ? error.message : String(error));
  }
  const pieces = cut.pieces;
  const alreadyReported = state.reported;
  const engineResult = await runEngine({
    pieces,
    rules,
    slot: () => acquireSlot(args2.slotDir),
    threshold: knobs.threshold,
    maxCalls: knobs.maxCalls,
    model,
    endpoint: credentials.endpoint,
    apiKey: credentials.bearer,
    fetchImpl: options.fetchImpl ?? ((url, init3) => fetch(url, init3)),
    cache: fileCache(cache),
    note,
    ...options.mode === "hook" ? {
      skipFinding: (ruleId2, pieceText) => alreadyReported[reportedKey(ruleId2, pieceText)] !== void 0
    } : {},
    ...options.sleep ? { sleep: options.sleep } : {}
  });
  if (engineResult.blocked !== null) {
    await saveCache(stateDir, cache);
    if (engineResult.blocked === "billing") return cannotRun(BILLING_EXHAUSTED);
    if (engineResult.blocked === "busy") return cannotRun(MACHINE_BUSY);
    return cannotRun(credentials.mode === "team" ? TOKEN_REJECTED : `${AUTH_REJECTED}.`);
  }
  if (pieces.length > 0 && engineResult.answered === 0 && engineResult.transportFailed) {
    await saveCache(stateDir, cache);
    return cannotRun("could not reach Jev for any piece of this diff.");
  }
  const notChecked = [...work.failures, ...cut.notChecked, ...engineResult.notChecked];
  const stats = {
    cut: work.cut,
    files: work.files.length,
    pieces: pieces.length,
    skipped: work.skipped.length,
    calls: engineResult.calls,
    piecesPerCall: engineResult.piecesPerCall,
    cacheHits: engineResult.cacheHits,
    violations: engineResult.pieces.reduce((total, piece) => total + piece.rules.length, 0),
    places: engineResult.pieces.length,
    notChecked: notChecked.length,
    cutByHunk: cut.cutByHunk,
    inputTokens: engineResult.usage.inputTokens,
    outputTokens: engineResult.usage.outputTokens,
    durationMs: Date.now() - started2
  };
  let outcome;
  if (options.mode === "score") {
    const report = {
      pieces: engineResult.scores,
      notChecked,
      skipped: work.skipped,
      stats,
      source: work.source
    };
    outcome = { kind: "scored", report, text: renderScores(report) };
  } else {
    const report = {
      pieces: engineResult.pieces,
      notChecked,
      skipped: work.skipped,
      stats
    };
    outcome = decide(
      options,
      report,
      state,
      engineResult.findings,
      work.snapshot,
      engineResult.holdBaseline
    );
    if (options.mode === "hook") await saveState(stateDir, state);
  }
  await saveCache(stateDir, cache);
  await appendRunLog(stateDir, {
    at: (/* @__PURE__ */ new Date()).toISOString(),
    mode: options.mode + (options.stopHookActive === true ? " (stop_hook_active)" : ""),
    cut: stats.cut,
    files: stats.files,
    pieces: stats.pieces,
    piecesPerCall: stats.piecesPerCall,
    cutByHunk: stats.cutByHunk.length,
    skipped: stats.skipped,
    calls: stats.calls,
    cacheHits: stats.cacheHits,
    violations: stats.violations,
    notChecked: stats.notChecked,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    durationMs: stats.durationMs,
    exitCode: outcome.kind === "violations" ? 2 : outcome.kind === "cannot-run" ? 1 : 0,
    notes
  });
  return outcome;
}
function decide(options, report, state, findings, snapshot, holdBaseline) {
  const text = renderReport(report);
  const hasViolations2 = report.pieces.length > 0;
  if (options.mode !== "hook") {
    return hasViolations2 ? { kind: "violations", report, text } : { kind: "clean", report, text };
  }
  if (snapshot === null) {
    throw new Error("internal error: hook mode ran without a working tree snapshot");
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
    const headline = `stop-rules: still ${report.stats.violations} violations after ${LOOP_GUARD_ROUNDS} rounds, leaving them for the user`;
    return { kind: "handoff", report, text: `${headline}

${text}` };
  }
  for (const finding of findings) {
    state.reported[reportedKey(finding.ruleId, finding.pieceText)] = Date.now();
  }
  if (!holdBaseline) state.lastTree = snapshot;
  return hasViolations2 ? { kind: "violations", report, text } : { kind: "clean", report, text };
}

// src/init.ts
import { promises as fs16 } from "node:fs";
import * as path21 from "node:path";
var NO_LANGUAGES = "no source files in a supported language yet: run stop-rules init again after you add some";
var BUNDLE_PATH = ".stop-rules/stop-rules.mjs";
var BUNDLE_NAME = "stop-rules.mjs";
var VENDOR_DIR = ".stop-rules";
function noGrammars() {
  return { languages: [], added: [], kept: [], bytes: 0 };
}
function failure(repo, reason) {
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
    errors: [reason]
  };
}
function bundleSource(selfPath) {
  if (isBundled()) return selfPath;
  return path21.join(path21.dirname(selfPath), BUNDLE_NAME);
}
async function init2(options) {
  const repo = await findRepo(options.dir);
  if (repo === null) {
    return failure(options.dir, `${options.dir} is not inside a git repository.`);
  }
  const root = repo.root;
  let chosen;
  if (options.agents !== void 0) {
    const unknown = options.agents.filter((name2) => getAdapter(name2) === null);
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
  const existingSettings = await loadSettings(root);
  if (!existingSettings.ok) return failure(root, existingSettings.reason);
  const cut = options.cut ?? existingSettings.loaded.settings.cut ?? DEFAULT_CUT;
  const report = {
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
    errors: []
  };
  const wroteKeys = [];
  if (options.team !== void 0) {
    const written = await writeTeamConfig(root, options.team);
    if (!written.ok) {
      return failure(root, written.lines.join(" ").replace(/^stop-rules: /, ""));
    }
    report.mode = "team";
    report.team = { endpoint: options.team.trim(), path: SETTINGS_FILE, written: true };
    wroteKeys.push("endpoint");
  } else {
    const existing = readTeamEndpoint(existingSettings.loaded, options.env);
    if (!existing.ok) return failure(root, existing.reason);
    if (existing.endpoint !== null) {
      report.mode = "team";
      report.team = { endpoint: existing.endpoint, path: existing.source, written: false };
    }
  }
  if (options.cut !== void 0) {
    const written = await writeSettings(root, { cut: options.cut });
    if (!written.ok) return failure(root, written.reason ?? `could not write ${written.file}`);
    wroteKeys.push("cut");
  }
  if (wroteKeys.length > 0) report.settings = { path: SETTINGS_FILE, wrote: wroteKeys };
  const source = bundleSource(options.selfPath);
  const target = path21.join(root, BUNDLE_PATH);
  if (path21.resolve(source) !== path21.resolve(target)) {
    try {
      await fs16.mkdir(path21.dirname(target), { recursive: true });
      await fs16.copyFile(source, target);
      report.bundle.written = true;
    } catch (error) {
      const err2 = error;
      return failure(
        root,
        err2.code === "ENOENT" ? `no bundle at ${source}. Run "npm run build" in the stop-rules clone first.` : `could not copy the bundle to ${target}: ${err2.message}`
      );
    }
  }
  try {
    report.grammars = cut === "functions" ? await copyGrammars(root) : { languages: [], added: [], kept: [], bytes: await folderBytes(path21.join(root, VENDOR_DIR)) };
  } catch (error) {
    return failure(root, error instanceof Error ? error.message : String(error));
  }
  const rulesPath = path21.join(root, ".stop-rules.md");
  try {
    await fs16.writeFile(rulesPath, STARTER_RULES, { encoding: "utf8", flag: "wx" });
    report.rules.created = true;
  } catch (error) {
    const err2 = error;
    if (err2.code !== "EEXIST") {
      return failure(root, `could not write ${rulesPath}: ${err2.message}`);
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
  if (cut === "functions" && report.grammars.languages.length === 0) {
    report.todo.push(NO_LANGUAGES);
  }
  const vendored = cut === "functions" && report.grammars.languages.length > 0 ? "the checker and its grammars" : "the checker";
  report.todo.push(
    report.mode === "team" ? `Commit ${VENDOR_DIR}/ (${vendored}), ${SETTINGS_FILE} and the config files, so teammates and cloud agents get the check too.` : `Commit ${VENDOR_DIR}/ (${vendored}) and the config files, so teammates and cloud agents get the check too.`
  );
  report.todo.push("Check it works: stop-rules login --check");
  return report;
}
async function languagesInRepo(root) {
  const listed = await runGit(root, ["ls-files", "--cached", "--others", "--exclude-standard"]);
  if (listed.code !== 0) {
    throw new Error(`git ls-files failed in ${root}: ${listed.stderr.trim()}`);
  }
  const keys = /* @__PURE__ */ new Set();
  for (const line of listed.stdout.split("\n")) {
    if (line.length === 0) continue;
    if (isSkippedPath(line)) continue;
    const key = EXTENSIONS[extensionOf(line)];
    if (key !== void 0) keys.add(key);
  }
  return [...keys].sort();
}
async function copyIfNew(source, target) {
  let fresh = true;
  try {
    await fs16.access(target);
    fresh = false;
  } catch (error) {
    const err2 = error;
    if (err2.code !== "ENOENT") throw new Error(`could not look at ${target}: ${err2.message}`);
  }
  await fs16.mkdir(path21.dirname(target), { recursive: true });
  try {
    await fs16.copyFile(source, target);
  } catch (error) {
    const err2 = error;
    throw new Error(
      err2.code === "ENOENT" ? `no file at ${source}. This stop-rules copy is incomplete: clone it again.` : `could not copy ${source} to ${target}: ${err2.message}`
    );
  }
  return fresh;
}
async function folderBytes(dir) {
  let total = 0;
  const entries = await fs16.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path21.join(dir, entry.name);
    if (entry.isDirectory()) total += await folderBytes(full);
    else total += (await fs16.stat(full)).size;
  }
  return total;
}
async function copyGrammars(root) {
  const from = vendorDir();
  const into = path21.join(root, VENDOR_DIR);
  const languages = await languagesInRepo(root);
  await copyIfNew(runtimeWasmPath(from), path21.join(into, "tree-sitter.wasm"));
  const added = [];
  const kept = [];
  for (const key of languages) {
    const name2 = grammarWasmName(key);
    const fresh = await copyIfNew(grammarWasmPath(key, from), path21.join(into, "grammars", name2));
    if (fresh) added.push(name2);
    else kept.push(name2);
  }
  return {
    languages: languages.map((key) => GRAMMAR_TITLE[key]),
    added,
    kept,
    bytes: await folderBytes(into)
  };
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
  const grammars = report.grammars;
  const megabytes = (grammars.bytes / 1e6).toFixed(1);
  if (report.cut !== "functions") {
    lines.push(
      `  cut: ${report.cut}, so no parser and no grammars were copied (${VENDOR_DIR} is ${megabytes} MB)`
    );
  } else {
    lines.push(
      grammars.languages.length === 0 ? `  ${NO_LANGUAGES}, so it copied no grammars (${VENDOR_DIR} is ${megabytes} MB)` : `  grammars for ${grammars.languages.join(", ")}: ${grammars.added.length} copied, ${grammars.kept.length} already there (${VENDOR_DIR} is ${megabytes} MB)`
    );
  }
  lines.push(
    report.rules.created ? `  wrote ${report.rules.path} with ${parseRules(STARTER_RULES).length} starter rules` : `  kept the rules file already at ${report.rules.path}`
  );
  const otherKeys = report.settings?.wrote.filter((key) => key !== "endpoint") ?? [];
  if (report.settings !== null && otherKeys.length > 0) {
    lines.push(`  wrote ${otherKeys.join(" and ")} into ${report.settings.path}`);
  }
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
var MAX_UPSTREAM_IN_FLIGHT = 12;
var inFlight = 0;
var REQUIRED_ENV = ["TYPESAFE_API_KEY", "STOP_RULES_TOKEN"];
function value(env, name2) {
  const raw = env[name2];
  return typeof raw === "string" ? raw.trim() : "";
}
function missingEnv(env) {
  return REQUIRED_ENV.filter((name2) => value(env, name2).length === 0);
}
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
function redact(env, text) {
  let out3 = text;
  for (const name2 of REQUIRED_ENV) {
    const secret = value(env, name2);
    if (secret.length > 0) out3 = out3.split(secret).join("[redacted]");
  }
  return out3;
}
function json(status, body2) {
  return new Response(JSON.stringify(body2), {
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
  for (let i2 = 0; i2 < left.length; i2 += 1) diff |= (left[i2] ?? 0) ^ (right[i2] ?? 0);
  return diff === 0;
}
function bearer(request) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? "";
}
function rejectPayload(body2) {
  if (!isObject(body2)) return "the body must be a JSON object";
  if (!isObject(body2["state"])) return "state must be a JSON object";
  const questions = body2["questions"];
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
  inFlight += 1;
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
    inFlight -= 1;
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
  let body2;
  try {
    body2 = JSON.parse(new TextDecoder().decode(raw));
  } catch (error) {
    return json(400, { error: "invalid_json", message: redact(env, describe(error)) });
  }
  const reason = rejectPayload(body2);
  if (reason !== null) return json(400, { error: "invalid_request", message: reason });
  if (inFlight >= MAX_UPSTREAM_IN_FLIGHT) {
    return new Response(
      JSON.stringify({
        error: "too_many_requests",
        message: `this server already has ${MAX_UPSTREAM_IN_FLIGHT} questions open with Jev. Try again in a second.`
      }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } }
    );
  }
  const asked = body2;
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
  const path22 = new URL(request.url).pathname.replace(/\/+$/, "");
  if (request.method === "GET" && (path22 === "" || path22.endsWith("/health"))) return health(env);
  if (request.method === "POST" && path22.endsWith("/v1/systemone")) return systemone(request, env);
  return json(404, {
    error: "not_found",
    message: "stop-rules serves GET /health and POST /v1/systemone"
  });
}
async function handle2(request, env) {
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
function requestFrom(req, body2) {
  const headers = new Headers();
  for (const [name2, raw] of Object.entries(req.headers)) {
    if (raw === void 0 || HOP_BY_HOP.has(name2)) continue;
    headers.set(name2, Array.isArray(raw) ? raw.join(", ") : raw);
  }
  const method = req.method;
  if (method === void 0) throw new Error("this request had no method");
  if (req.url === void 0) throw new Error("this request had no URL");
  const authority = req.headers.host === void 0 ? `localhost:${DEFAULT_PORT}` : req.headers.host;
  const url = new URL(req.url, `http://${authority}`);
  const init3 = { method, headers };
  if (method !== "GET" && method !== "HEAD") init3.body = body2;
  return new Request(url, init3);
}
async function writeResponse(res, response) {
  const headers = {};
  response.headers.forEach((headerValue, name2) => {
    headers[name2] = headerValue;
  });
  const body2 = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, headers);
  res.end(body2);
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
      handle2(request, env).then((response) => writeResponse(res, response)).catch((error) => {
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
  const stop2 = () => {
    server.close();
  };
  process.on("SIGINT", stop2);
  process.on("SIGTERM", stop2);
  return 0;
}

// src/cli.ts
var USAGE = `stop-rules: check the code your agent just wrote against your team's rules.

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
  --dir <path>         init mode only: the repository to install into (default: this one)
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
var UsageError = class extends Error {
};
function parseArgs(argv) {
  const parsed = {
    command: "",
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
  for (let i2 = 0; i2 < argv.length; i2 += 1) {
    const arg = argv[i2] ?? "";
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
        i2 += 1;
        const value2 = Number(take(i2, "--port"));
        if (!Number.isInteger(value2) || value2 < 0 || value2 > 65535) {
          throw new UsageError("--port must be a port number");
        }
        parsed.port = value2;
        break;
      }
      case "--rules":
        i2 += 1;
        parsed.rules = take(i2, "--rules");
        break;
      case "--base":
        i2 += 1;
        parsed.base = take(i2, "--base");
        break;
      case "--diff":
        i2 += 1;
        parsed.diff = take(i2, "--diff");
        break;
      case "--cut": {
        i2 += 1;
        const value2 = take(i2, "--cut");
        if (value2 !== "functions" && value2 !== "hunks" && value2 !== "chunks") {
          throw new UsageError("--cut must be functions, hunks or chunks");
        }
        parsed.cut = value2;
        break;
      }
      case "--agent":
        i2 += 1;
        parsed.agent = take(i2, "--agent");
        break;
      case "--agents": {
        i2 += 1;
        const names = take(i2, "--agents").split(",").map((name2) => name2.trim()).filter((name2) => name2.length > 0);
        if (names.length === 0) throw new UsageError("--agents needs at least one agent name");
        parsed.agents = names;
        break;
      }
      case "--dir":
        i2 += 1;
        parsed.dir = take(i2, "--dir");
        break;
      case "--team":
        i2 += 1;
        parsed.team = take(i2, "--team");
        break;
      case "--threshold": {
        i2 += 1;
        const value2 = Number(take(i2, "--threshold"));
        if (!Number.isFinite(value2) || value2 < 0 || value2 > 1) {
          throw new UsageError("--threshold must be a number between 0 and 1");
        }
        parsed.threshold = value2;
        break;
      }
      case "--max-calls": {
        i2 += 1;
        const value2 = Number(take(i2, "--max-calls"));
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
  const parts2 = [];
  for await (const part of process.stdin) parts2.push(part);
  return Buffer.concat(parts2).toString("utf8");
}
function runningFile() {
  if (!import.meta.url.startsWith("file:")) {
    throw new Error(
      `stop-rules is running from ${import.meta.url}, which is not a file on disk, so init has nothing to copy`
    );
  }
  return fileURLToPath2(import.meta.url);
}
function emit(delivery) {
  if (delivery.stdout.length > 0) process.stdout.write(delivery.stdout);
  if (delivery.stderr.length > 0) process.stderr.write(delivery.stderr);
  return delivery.exitCode;
}
function deliverOutcome(adapter, outcome) {
  switch (outcome.kind) {
    case "scored":
      throw new Error("internal error: the hook asked for a check and got a score report");
    case "cannot-run":
      return adapter.deliverError(`stop-rules: ${outcome.reason}`);
    case "handoff":
      return adapter.deliverError(outcome.text);
    case "clean":
    case "violations":
      return adapter.deliver(outcome.report, outcome.text);
  }
}
async function runHook(args2) {
  const adapter = getAdapter(args2.agent);
  if (adapter === null) {
    process.stderr.write(
      `stop-rules: unknown agent ${args2.agent}. Known agents: ${agentNames().join(", ")}
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
  const outcome = await run2({
    // An adapter leaves cwd undefined only when its agent documents no directory field at
    // all, and those agents run the hook in the project root. See HookContext.
    cwd: input.cwd === void 0 ? process.cwd() : input.cwd,
    mode: "hook",
    sessionId: input.sessionId,
    stopHookActive: input.stopHookActive === true,
    ...knobArgs(args2),
    ...input.loopCount !== void 0 ? { loopCount: input.loopCount } : {}
  });
  return emit(deliverOutcome(adapter, outcome));
}
function knobArgs(args2) {
  return {
    ...args2.threshold !== void 0 ? { threshold: args2.threshold } : {},
    ...args2.maxCalls !== void 0 ? { maxCalls: args2.maxCalls } : {},
    ...args2.cut !== void 0 ? { cut: args2.cut } : {},
    ...args2.rules !== void 0 ? { rulesPath: args2.rules } : {}
  };
}
async function runCheckCommand(args2) {
  const outcome = await run2({
    cwd: process.cwd(),
    mode: "check",
    ...knobArgs(args2),
    ...args2.base !== void 0 ? { base: args2.base } : {}
  });
  if (outcome.kind === "cannot-run") {
    process.stderr.write(`stop-rules: ${outcome.reason}
`);
    return 1;
  }
  if (args2.json) process.stdout.write(`${JSON.stringify(outcome.report, null, 2)}
`);
  else process.stdout.write(`${outcome.text}
`);
  return outcome.kind === "violations" ? 2 : 0;
}
async function runScoreCommand(args2) {
  if (args2.diff !== void 0 && args2.base !== void 0) {
    process.stderr.write("stop-rules: score takes --diff or --base, not both\n");
    return 1;
  }
  const outcome = await run2({
    cwd: process.cwd(),
    mode: "score",
    ...knobArgs(args2),
    ...args2.base !== void 0 ? { base: args2.base } : {},
    ...args2.diff !== void 0 ? { diffFile: args2.diff } : {}
  });
  if (outcome.kind === "cannot-run") {
    process.stderr.write(`stop-rules: ${outcome.reason}
`);
    return 1;
  }
  if (outcome.kind !== "scored") {
    throw new Error(`internal error: score mode returned a ${outcome.kind} outcome`);
  }
  if (args2.json) process.stdout.write(`${JSON.stringify(outcome.report, null, 2)}
`);
  else process.stdout.write(`${outcome.text}
`);
  return 0;
}
async function runInitCommand(args2) {
  const report = await init2({
    dir: args2.dir ?? process.cwd(),
    selfPath: runningFile(),
    env: process.env,
    ...args2.agents !== void 0 ? { agents: args2.agents } : {},
    ...args2.team !== void 0 ? { team: args2.team } : {},
    ...args2.cut !== void 0 ? { cut: args2.cut } : {}
  });
  if (args2.json) {
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
async function runBaselineCommand(args2) {
  if (!args2.reset) {
    process.stderr.write("stop-rules: baseline only takes --reset, as in stop-rules baseline --reset\n");
    return 1;
  }
  return writeResult(await resetBaseline(process.cwd()));
}
async function runTeamCommand(args2) {
  if (args2.operand === void 0) {
    process.stderr.write("stop-rules: team needs an endpoint, as in stop-rules team https://example.com\n");
    return 1;
  }
  const repo = await findRepo(process.cwd());
  if (repo === null) {
    process.stderr.write(`stop-rules: ${process.cwd()} is not inside a git repository.
`);
    return 1;
  }
  return writeResult(await writeTeamConfig(repo.root, args2.operand));
}
async function runLoginCommand(args2) {
  if (args2.check) {
    const repo = await findRepo(process.cwd());
    const root = repo === null ? process.cwd() : repo.root;
    return writeResult(await loginCheck(root, process.env));
  }
  if (args2.tokenStdin === args2.jevKeyStdin) {
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
  return writeResult(await login(process.env, args2.tokenStdin ? "token" : "jev-key", secret));
}
async function main() {
  let args2;
  try {
    args2 = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`stop-rules: ${error instanceof Error ? error.message : String(error)}
`);
    process.stderr.write(USAGE);
    return 1;
  }
  if (args2.version) {
    process.stdout.write(`${VERSION}
`);
    return 0;
  }
  if (args2.help || args2.command.length === 0) {
    process.stdout.write(USAGE);
    return args2.help ? 0 : 1;
  }
  if (args2.operand !== void 0 && args2.command !== "team") {
    process.stderr.write(`stop-rules: unexpected argument ${args2.operand}
`);
    return 1;
  }
  switch (args2.command) {
    case "hook":
      return runHook(args2);
    case "check":
      return runCheckCommand(args2);
    case "score":
      return runScoreCommand(args2);
    case "init":
      return runInitCommand(args2);
    case "team":
      return runTeamCommand(args2);
    case "login":
      return runLoginCommand(args2);
    case "serve":
      try {
        return await serveMain(args2.port);
      } catch (error) {
        process.stderr.write(
          `stop-rules: ${error instanceof Error ? error.message : String(error)}
`
        );
        return 1;
      }
    case "baseline":
      return runBaselineCommand(args2);
    default:
      process.stderr.write(`stop-rules: unknown command ${args2.command}
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
