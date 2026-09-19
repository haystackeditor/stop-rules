/**
 * The team server as its own program, for `npm start` and the Docker image.
 *
 * It lives in its own file on purpose. `src/server/node.ts` is a library: the CLI imports
 * it for `stop-rules serve`, and the single file bundle inlines it. A module that starts a
 * server the moment it is imported would make every bundled command start one too.
 */

import { serveMain } from "./node.js";

serveMain().catch((error: unknown) => {
  process.stderr.write(
    `stop-rules serve: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
