/** Vercel Function, Node runtime: POST https://<your-app>.vercel.app/api/v1/systemone */
import { handle } from "../../dist/server/handler.js";

export default {
  fetch(request: Request): Promise<Response> {
    return handle(request, process.env);
  },
};
