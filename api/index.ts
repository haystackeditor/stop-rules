/**
 * Vercel Function, Node runtime. The build script compiles src/server into dist, so this
 * wrapper only forwards the request. Vercel routes api/<path> by file name, so the team
 * endpoint is https://<your-app>.vercel.app/api and the questions land on
 * api/v1/systemone.ts.
 */
import { handle } from "../dist/server/handler.js";

export default {
  fetch(request: Request): Promise<Response> {
    // This file is only reached for the bare mount, which is the health route.
    const url = new URL(request.url);
    url.pathname = "/health";
    return handle(new Request(url, request), process.env);
  },
};
