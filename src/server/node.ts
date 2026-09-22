/**
 * The team mode server on plain Node, for a laptop or a virtual machine. Everything that
 * decides anything lives in handler.ts; this file only moves bytes between node:http and
 * the web standard Request and Response.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { handle, missingEnv, missingFor, SERVER_VERSION } from "./handler.js";

export const DEFAULT_PORT = 8080;
const HOST = "0.0.0.0";

/** Connection level headers that belong to node:http, not to the request we build. */
const HOP_BY_HOP = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function requestFrom(req: IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(req.headers)) {
    if (raw === undefined || HOP_BY_HOP.has(name)) continue;
    headers.set(name, Array.isArray(raw) ? raw.join(", ") : raw);
  }
  // node:http always sets both on a server request. If one is missing something is wrong
  // with the request, and this server says so rather than answering a made up one.
  const method = req.method;
  if (method === undefined) throw new Error("this request had no method");
  if (req.url === undefined) throw new Error("this request had no URL");
  // Only the path is used. The Host header is optional in HTTP/1.0, so a placeholder
  // authority is how the path gets parsed, not a stand in for missing input.
  const authority = req.headers.host === undefined ? `localhost:${DEFAULT_PORT}` : req.headers.host;
  const url = new URL(req.url, `http://${authority}`);
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") init.body = body;
  return new Request(url, init);
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((headerValue, name) => {
    headers[name] = headerValue;
  });
  const body = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, headers);
  res.end(body);
}

/** Last resort: the client gets an answer and the operator gets the reason. */
function fail(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`stop-rules serve: ${message}\n`);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "server_error", message: "see the server log" }));
}

export function createStopRulesServer(env: NodeJS.ProcessEnv = process.env): Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("error", (error: unknown) => {
      fail(res, error);
    });
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      let request: Request;
      try {
        request = requestFrom(req, Buffer.concat(chunks));
      } catch (error) {
        fail(res, error);
        return;
      }
      handle(request, env as Record<string, string | undefined>)
        .then((response) => writeResponse(res, response))
        .catch((error: unknown) => {
          fail(res, error);
        });
    });
  });
}

export function resolvePort(env: NodeJS.ProcessEnv, override?: number): number {
  if (override !== undefined) return override;
  const set = env["PORT"];
  // Not set means the documented default. Set to nothing is a mistake worth saying out loud.
  if (set === undefined) return DEFAULT_PORT;
  const raw = set.trim();
  if (raw.length === 0) throw new Error("PORT is set but empty. Unset it or give it a port number.");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT is not a port number: ${raw}`);
  }
  return port;
}

export function startServer(port: number, env: NodeJS.ProcessEnv = process.env): Promise<Server> {
  const server = createStopRulesServer(env);
  return new Promise<Server>((resolve, reject) => {
    let listening = false;
    server.on("error", (error: Error) => {
      if (!listening) {
        reject(error);
        return;
      }
      // After listen, a socket error must still be visible somewhere.
      process.stderr.write(`stop-rules serve: ${error.message}\n`);
    });
    server.listen(port, HOST, () => {
      listening = true;
      resolve(server);
    });
  });
}

/** The lines printed on startup. Env NAMES only, never values. */
export function startupLines(port: number, env: NodeJS.ProcessEnv): string[] {
  const lines = [`stop-rules ${SERVER_VERSION} listening on http://${HOST}:${port}`];
  const serverEnv = env as Record<string, string | undefined>;
  const missing = missingEnv(serverEnv);
  if (missing.length > 0) {
    lines.push(`not configured yet: set ${missing.join(" and ")} and restart`);
  }
  const judge = (name: string, route: "jev" | "openai"): string => {
    const needs = missingFor(serverEnv, route);
    return needs.length === 0 ? `${name} ready` : `${name} needs ${needs.join(" and ")}`;
  };
  lines.push(`judges: ${judge("jev", "jev")}, ${judge("openai", "openai")}`);
  return lines;
}

export async function serveMain(port?: number): Promise<number> {
  const resolved = resolvePort(process.env, port);
  const server = await startServer(resolved);
  process.stdout.write(`${startupLines(resolved, process.env).join("\n")}\n`);
  const stop = (): void => {
    server.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return 0;
}
