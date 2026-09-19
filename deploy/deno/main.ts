/**
 * Deno Deploy entry point. Deno runs the TypeScript source with no build step, and the
 * handler has no node: imports, so this is the whole adapter.
 *
 * Set the app's entrypoint to deploy/deno/main.ts, then set TYPESAFE_API_KEY and
 * STOP_RULES_TOKEN as environment variables in the Deno Deploy dashboard.
 */
import { handle } from "../../src/server/handler.ts";

Deno.serve((request: Request) => handle(request, Deno.env.toObject()));
