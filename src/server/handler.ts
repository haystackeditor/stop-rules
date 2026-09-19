/**
 * Team mode server: a locked down Jev proxy and nothing more. It swaps a team token for
 * the real Jev key, so no developer needs the key and all the checking logic stays in the
 * client.
 *
 * Web standard APIs only: no node: imports, no process, no Buffer, no AbortSignal.timeout.
 * That is what lets this one file run unchanged on Node, Cloudflare Workers, Deno Deploy,
 * Supabase Edge Functions, Netlify Functions, Vercel Functions and AWS Lambda.
 */

/** Reported by the health route. Bump with the package version. */
export const SERVER_VERSION = "0.1.0";
export const DEFAULT_UPSTREAM = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";
export const MAX_BODY_BYTES = 1000000;
export const UPSTREAM_TIMEOUT_MS = 30000;
/** The two secrets a deploy has to set. Values are never echoed, only these names. */
export const REQUIRED_ENV = ["TYPESAFE_API_KEY", "STOP_RULES_TOKEN"];

export type ServerEnv = Record<string, string | undefined>;

function value(env: ServerEnv, name: string): string {
  const raw = env[name];
  return typeof raw === "string" ? raw.trim() : "";
}

/** Names, never values, so a fresh deploy can be diagnosed from a browser. */
export function missingEnv(env: ServerEnv): string[] {
  return REQUIRED_ENV.filter((name) => value(env, name).length === 0);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Removes anything secret from text that is about to leave this server. */
function redact(env: ServerEnv, text: string): string {
  let out = text;
  for (const name of REQUIRED_ENV) {
    const secret = value(env, name);
    if (secret.length > 0) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}

async function digest(text: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/**
 * Compares two secrets without an early exit, so a wrong token tells an attacker nothing
 * through timing. Both sides are hashed first, which also makes the lengths equal.
 */
async function secretsMatch(offered: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([digest(offered), digest(expected)]);
  let diff = left.length ^ right.length;
  for (let i = 0; i < left.length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? "";
}

/** A plain reason when the body is not a question set this proxy will forward. */
function rejectPayload(body: unknown): string | null {
  if (!isObject(body)) return "the body must be a JSON object";
  if (!isObject(body["state"])) return "state must be a JSON object";
  const questions = body["questions"];
  if (!isObject(questions)) return "questions must be a JSON object";
  const ids = Object.keys(questions);
  if (ids.length === 0) return "questions must hold at least one question";
  for (const id of ids) {
    const question = questions[id];
    if (!isObject(question)) return `question ${id} must be a JSON object`;
    if (question["type"] !== "noul") return `question ${id} must have type noul`;
  }
  return null;
}

function health(env: ServerEnv): Response {
  const missing = missingEnv(env);
  return json(200, {
    ok: true,
    service: "stop-rules",
    version: SERVER_VERSION,
    configured: missing.length === 0,
    missing,
  });
}

async function forward(env: ServerEnv, payload: string): Promise<Response> {
  const upstream = value(env, "STOP_RULES_JEV_UPSTREAM") || DEFAULT_UPSTREAM;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(upstream, {
      method: "POST",
      headers: {
        authorization: `Bearer ${value(env, "TYPESAFE_API_KEY")}`,
        "content-type": "application/json",
      },
      body: payload,
      signal: controller.signal,
    });
    const text = await response.text();
    const headers: Record<string, string> = {
      "content-type": response.headers.get("content-type") ?? "application/json",
    };
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter !== null) headers["retry-after"] = retryAfter;
    // Status, body and Retry-After go back untouched, so the client's own 429 backoff and
    // max_tokens_exceeded halving keep working through the proxy.
    const empty = response.status === 204 || response.status === 304;
    return new Response(empty ? null : text, { status: response.status, headers });
  } catch (error) {
    return json(502, {
      error: "upstream_unreachable",
      message: redact(env, `could not reach ${upstream}: ${describe(error)}`),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function systemone(request: Request, env: ServerEnv): Promise<Response> {
  const missing = missingEnv(env);
  if (missing.length > 0) {
    return json(503, {
      error: "not_configured",
      message: "this stop-rules server is missing environment variables",
      missing,
    });
  }
  if (!(await secretsMatch(bearer(request), value(env, "STOP_RULES_TOKEN")))) {
    return json(401, {
      error: "unauthorized",
      message: "send Authorization: Bearer with your team token. Run stop-rules login.",
    });
  }

  const tooLarge = json(413, {
    error: "payload_too_large",
    message: `the body must be at most ${MAX_BODY_BYTES} bytes`,
  });
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge;

  let raw: ArrayBuffer;
  try {
    raw = await request.arrayBuffer();
  } catch (error) {
    return json(400, { error: "unreadable_body", message: redact(env, describe(error)) });
  }
  if (raw.byteLength > MAX_BODY_BYTES) return tooLarge;

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch (error) {
    return json(400, { error: "invalid_json", message: redact(env, describe(error)) });
  }
  const reason = rejectPayload(body);
  if (reason !== null) return json(400, { error: "invalid_request", message: reason });

  const asked = body as { state: unknown; questions: unknown };
  // The model is the server's choice, not the client's.
  return forward(
    env,
    JSON.stringify({
      state: asked.state,
      model: value(env, "STOP_RULES_JEV_MODEL") || DEFAULT_MODEL,
      questions: asked.questions,
    }),
  );
}

async function route(request: Request, env: ServerEnv): Promise<Response> {
  // Path suffixes, because some platforms mount a function under a prefix of their own.
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  if (request.method === "GET" && (path === "" || path.endsWith("/health"))) return health(env);
  if (request.method === "POST" && path.endsWith("/v1/systemone")) return systemone(request, env);
  return json(404, {
    error: "not_found",
    message: "stop-rules serves GET /health and POST /v1/systemone",
  });
}

/**
 * The one entry point every platform wrapper calls.
 *
 * This module deliberately has no default export. A Workers entry module may only export
 * handlers, and workerd refuses to start when it finds a named export such as
 * DEFAULT_MODEL next to them, so the Worker shape lives in cloudflare.ts instead.
 */
export async function handle(request: Request, env: ServerEnv): Promise<Response> {
  try {
    return await route(request, env);
  } catch (error) {
    // Nothing is allowed to escape as an opaque platform error.
    return json(500, { error: "server_error", message: redact(env, describe(error)) });
  }
}
