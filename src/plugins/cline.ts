/**
 * The Cline TaskComplete hook is an executable file with a shebang, not a config entry, so
 * `install` writes this two line shell script. It sits at `.clinerules/hooks/TaskComplete`,
 * which puts the repository root two directories up, and hands its stdin straight through.
 */
export function clineHookScript(bundlePath: string): string {
  return `#!/usr/bin/env bash
# Written by stop-rules. Re-run "stop-rules init" to update it.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
exec node "$repo/${bundlePath}" hook --agent cline
`;
}
