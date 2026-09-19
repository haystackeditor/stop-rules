/**
 * Cloudflare Workers entry module. A Workers entry may export handlers and nothing else:
 * workerd refuses to start if it finds a plain named export beside them, which is why this
 * file exists instead of pointing wrangler at handler.ts.
 */

import { handle, type ServerEnv } from "./handler.js";

export default {
  fetch(request: Request, env: ServerEnv): Promise<Response> {
    return handle(request, env);
  },
};
