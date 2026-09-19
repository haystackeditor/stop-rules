/**
 * Supabase Edge Function. Edge Functions run on Deno, so this imports the TypeScript
 * source directly. Supabase serves the function under /functions/v1/stop-rules, so the
 * mount prefix comes off before the handler sees the path.
 *
 * JWT verification is off in ../../config.toml because this service does its own bearer
 * token check.
 */
import { handle } from "../../../src/server/handler.ts";

const MOUNT = "/functions/v1/stop-rules";

Deno.serve((request: Request) => {
  const url = new URL(request.url);
  if (url.pathname === MOUNT || url.pathname.startsWith(`${MOUNT}/`)) {
    url.pathname = url.pathname.slice(MOUNT.length);
    return handle(new Request(url, request), Deno.env.toObject());
  }
  return handle(request, Deno.env.toObject());
});
