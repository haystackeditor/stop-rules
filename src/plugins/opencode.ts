/**
 * Template for the OpenCode plugin `init` writes to `.opencode/plugins/stop-rules.ts`.
 *
 * Verified against opencode's plugin docs and the `@opencode-ai/sdk` types on 2026-09-19:
 * local plugins are loaded from `.opencode/plugins/`, a plugin is a module exporting a
 * function that receives `{ client, project, directory, worktree, $ }` and returns a hooks
 * object, the `event` hook receives `{ event }`, `EventSessionIdle` is
 * `{ type: "session.idle", properties: { sessionID: string } }`, and
 * `client.session.prompt({ path: { id }, body: { parts: [{ type: "text", text }] } })`
 * posts a new user message to a session.
 *
 * The plugin spawns stop-rules with `--agent plain` and acts on exit code 2. It does not
 * need its own loop guard: the plain adapter's session counter exits 1 after three rounds
 * of the same violations, and exit 1 tells the plugin to do nothing.
 */
export function opencodePlugin(bundlePath: string): string {
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
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }))
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
