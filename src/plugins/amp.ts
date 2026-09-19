/**
 * Template for the Amp plugin `init` writes to `.amp/plugins/stop-rules.ts`.
 *
 * Verified against Amp's plugin docs and plugin API types on 2026-09-19: project plugins
 * live in `.amp/plugins/`, a plugin is a module with `export default function (amp)`,
 * `amp.on('agent.end', handler)` receives `{ thread: { id }, message, status, messages }`,
 * the handler may return `{ action: 'continue', userMessage }` to start one more turn, and
 * `amp.workspaceRoot` is a file URI that `amp.helpers.filePathFromURI` turns into a path.
 * Amp ignores `continue` after 5 consecutive plugin continuations by default.
 *
 * The plugin spawns stop-rules with `--agent plain` and acts on exit code 2. It needs no
 * loop guard of its own: the plain adapter's session counter exits 1 after three rounds of
 * the same violations, and exit 1 asks the plugin to do nothing.
 */
export function ampPlugin(bundlePath: string): string {
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
