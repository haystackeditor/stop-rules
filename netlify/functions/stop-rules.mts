/**
 * Netlify Function. One function serves every route, so the team endpoint is the site
 * root. The build command compiles src/server into dist before this file is bundled.
 */
import { handle } from "../../dist/server/handler.js";

export default async (request: Request): Promise<Response> => handle(request, process.env);

export const config = {
  path: ["/health", "/v1/systemone", "/v1/responses"],
};
