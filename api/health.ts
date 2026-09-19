/** Vercel Function, Node runtime: GET https://<your-app>.vercel.app/api/health */
import { handle } from "../dist/server/handler.js";

export default {
  fetch(request: Request): Promise<Response> {
    return handle(request, process.env);
  },
};
