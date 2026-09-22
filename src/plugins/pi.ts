/**
 * Template for the Pi extension `init` writes to `.pi/extensions/stop-rules.ts`.
 *
 * Verified against Pi's extension docs, configuration and security docs, and the published
 * `@earendil-works/pi-coding-agent` 0.87.1 types and runtime on 2026-09-22: project
 * extensions are loaded from `.pi/extensions/` under the working directory, and only after
 * the project is trusted; an extension is a module with `export default function (pi)`;
 * `pi.on("agent_before_settle", handler)` is "the final actionable boundary", and the
 * handler receives `{ entries, continue, context, outcome }` plus a context with `cwd` and
 * `sessionManager.getSessionId()`. It may return `{ entries, continue: true }`, where a
 * `custom_message` entry is `{ type, customType, content, display }` and reaches the model
 * as a user message. Pi takes the returned `entries` as the whole list, so the extension
 * passes along what earlier handlers proposed. `continue: true` buys exactly one more model
 * request, after which Pi fires `agent_before_settle` again; Pi itself sets no cap on how
 * many settles in a row continue.
 *
 * The extension spawns stop-rules with `--agent plain` and acts on exit code 2, like the
 * OpenCode and Amp plugins. The loop guard is the plain adapter's: a finding already
 * delivered is never delivered again, and after three rounds of violations it exits 1,
 * which asks the extension to do nothing. A stop-rules entry already in `entries` means
 * this settle has its report, so a second copy of the extension adds nothing.
 */
export function piExtension(bundlePath: string): string {
  return `// Written by stop-rules. Re-run "stop-rules init" to update it.
import { spawn } from "node:child_process"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

const BUNDLE = ${JSON.stringify(bundlePath)}
const CUSTOM_TYPE = "stop-rules"

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

// For the user, never the model: the model cannot fix a missing key.
function tellUser(ctx: ExtensionContext, line: string): void {
  if (ctx.hasUI) ctx.ui.notify(line, "error")
  else console.error(line)
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "completed") return undefined
    const already = event.entries.some(
      (entry) => entry.type === "custom_message" && entry.customType === CUSTOM_TYPE,
    )
    if (already) return undefined

    // Pi reads .pi/extensions from the working directory, so that is where init wrote this.
    const root = ctx.cwd
    let run: Run
    try {
      run = await runStopRules(root, ctx.sessionManager.getSessionId())
    } catch (error) {
      // Never swallow it: the user needs to know the check did not run.
      tellUser(ctx, "stop-rules: could not run the check: " + String(error))
      return undefined
    }
    if (run.code === 2) {
      const report = (run.stdout.trim().length > 0 ? run.stdout : run.stderr).trim()
      if (report.length === 0) return undefined
      return {
        entries: [
          ...event.entries,
          { type: "custom_message" as const, customType: CUSTOM_TYPE, content: report, display: true },
        ],
        continue: true,
      }
    }
    if (run.code !== 0) tellUser(ctx, run.stderr.trim())
    return undefined
  })
}
`;
}
