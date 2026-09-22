/**
 * Team mode server: a locked down proxy for the two judges and nothing more. It swaps a team
 * token for the real key, Jev's on POST /v1/systemone and OpenAI's on POST /v1/responses, so
 * no developer needs a key and all the checking logic stays in the client.
 *
 * Web standard APIs only: no node: imports, no process, no Buffer, no AbortSignal.timeout.
 * That is what lets this one file run unchanged on Node, Cloudflare Workers, Deno Deploy,
 * Supabase Edge Functions, Netlify Functions, Vercel Functions and AWS Lambda.
 */

/** Reported by the health route. Bump with the package version. */
export const SERVER_VERSION = "0.1.0";
export const DEFAULT_UPSTREAM = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";
export const OPENAI_UPSTREAM = "https://api.openai.com/v1/responses";
export const MAX_BODY_BYTES = 1000000;
export const UPSTREAM_TIMEOUT_MS = 30000;
/**
 * OpenAI answers take longer, because the model reasons first. Measured over 800 calls per
 * effort in September 2026, the slowest was 13 s at low and 26 s at medium.
 */
export const OPENAI_UPSTREAM_TIMEOUT_MS = 60000;
/**
 * How many calls this server instance keeps open to Jev at once. Jev's limit is per account:
 * measured, 16 in flight is fine and 32 gets about half refused, so one server stays under
 * it with room for the developers who also run their own key. Past this the server answers
 * 429 with Retry-After: 1 and the client backs off through the same code path it uses for a
 * 429 from Jev itself. On a serverless platform this count is per instance.
 */
export const MAX_UPSTREAM_IN_FLIGHT = 12;

/**
 * Calls open to each upstream. OpenAI's limit is per account too, and it gets the same
 * ceiling of 12, which was not measured against OpenAI: its limits depend on the account's
 * usage tier and are far above 12 calls at once on every paid tier.
 */
const inFlight = { jev: 0, openai: 0 };
/** The two secrets a deploy has to set for Jev. Values are never echoed, only these names. */
export const REQUIRED_ENV = ["TYPESAFE_API_KEY", "STOP_RULES_TOKEN"];
/** The two secrets the OpenAI judge's route needs. */
export const OPENAI_REQUIRED_ENV = ["OPENAI_API_KEY", "STOP_RULES_TOKEN"];
/** Every secret this server may hold, so none of them can leave in an error message. */
const SECRET_ENV = ["TYPESAFE_API_KEY", "OPENAI_API_KEY", "STOP_RULES_TOKEN"];

export type ServerEnv = Record<string, string | undefined>;
export type JudgeRoute = "jev" | "openai";

function value(env: ServerEnv, name: string): string {
  const raw = env[name];
  return typeof raw === "string" ? raw.trim() : "";
}

/** What one judge's route still needs. Names, never values. */
export function missingFor(env: ServerEnv, judge: JudgeRoute): string[] {
  return (judge === "jev" ? REQUIRED_ENV : OPENAI_REQUIRED_ENV).filter(
    (name) => value(env, name).length === 0,
  );
}

/**
 * Names, never values, so a fresh deploy can be diagnosed from a browser. Empty once either
 * judge's route is ready. Before that it names what Jev, the default judge, needs.
 */
export function missingEnv(env: ServerEnv): string[] {
  if (missingFor(env, "openai").length === 0) return [];
  return missingFor(env, "jev");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Removes anything secret from text that is about to leave this server. */
function redact(env: ServerEnv, text: string): string {
  let out = text;
  for (const name of SECRET_ENV) {
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

/**
 * A plain reason when the body is not a Responses API request this proxy will forward: one
 * text input answered in strict structured output, which is the only thing the client sends.
 */
function rejectResponsesPayload(body: unknown): string | null {
  if (!isObject(body)) return "the body must be a JSON object";
  if (typeof body["model"] !== "string" || body["model"].trim().length === 0) {
    return "model must be a model name";
  }
  if (typeof body["input"] !== "string") return "input must be a string";
  if (body["instructions"] !== undefined && typeof body["instructions"] !== "string") {
    return "instructions must be a string";
  }
  if (body["reasoning"] !== undefined && !isObject(body["reasoning"])) {
    return "reasoning must be a JSON object";
  }
  const text = body["text"];
  const format = isObject(text) ? text["format"] : undefined;
  if (!isObject(format) || format["type"] !== "json_schema" || format["strict"] !== true) {
    return "text.format must be a strict json_schema";
  }
  return null;
}

/**
 * The only fields forwarded to OpenAI. Anything else the body holds, such as tools, is left
 * behind, so the team token buys scoring and nothing more.
 */
const RESPONSES_FIELDS = [
  "model",
  "reasoning",
  "instructions",
  "input",
  "text",
  "max_output_tokens",
  "prompt_cache_key",
];

function health(env: ServerEnv): Response {
  const missing = missingEnv(env);
  return json(200, {
    ok: true,
    service: "stop-rules",
    version: SERVER_VERSION,
    configured: missing.length === 0,
    missing,
    judges: {
      jev: missingFor(env, "jev").length === 0,
      openai: missingFor(env, "openai").length === 0,
    },
  });
}

async function forward(env: ServerEnv, judge: JudgeRoute, payload: string): Promise<Response> {
  const upstream =
    judge === "jev" ? value(env, "STOP_RULES_JEV_UPSTREAM") || DEFAULT_UPSTREAM : OPENAI_UPSTREAM;
  const key = value(env, judge === "jev" ? "TYPESAFE_API_KEY" : "OPENAI_API_KEY");
  const controller = new AbortController();
  const timer = setTimeout(
    () => {
      controller.abort();
    },
    judge === "jev" ? UPSTREAM_TIMEOUT_MS : OPENAI_UPSTREAM_TIMEOUT_MS,
  );
  inFlight[judge] += 1;
  try {
    const response = await fetch(upstream, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
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
    // Status, body and Retry-After go back untouched, so the client's own 429 backoff, its
    // halving of a request that is too long and its reading of OpenAI's error codes keep
    // working through the proxy.
    const empty = response.status === 204 || response.status === 304;
    return new Response(empty ? null : text, { status: response.status, headers });
  } catch (error) {
    return json(502, {
      error: "upstream_unreachable",
      message: redact(env, `could not reach ${upstream}: ${describe(error)}`),
    });
  } finally {
    clearTimeout(timer);
    inFlight[judge] -= 1;
  }
}

/**
 * The part both routes share: configured, the right team token, a body of a sane size that
 * is JSON. Returns the parsed body, or the response to send instead.
 */
async function admit(
  request: Request,
  env: ServerEnv,
  judge: JudgeRoute,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const missing = missingFor(env, judge);
  if (missing.length > 0) {
    return {
      ok: false,
      response: json(503, {
        error: "not_configured",
        message:
          judge === "jev"
            ? "this stop-rules server is missing environment variables"
            : "this stop-rules server is missing environment variables for the openai judge",
        missing,
      }),
    };
  }
  if (!(await secretsMatch(bearer(request), value(env, "STOP_RULES_TOKEN")))) {
    return {
      ok: false,
      response: json(401, {
        error: "unauthorized",
        message: "send Authorization: Bearer with your team token. Run stop-rules login.",
      }),
    };
  }

  const tooLarge = json(413, {
    error: "payload_too_large",
    message: `the body must be at most ${MAX_BODY_BYTES} bytes`,
  });
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false, response: tooLarge };

  let raw: ArrayBuffer;
  try {
    raw = await request.arrayBuffer();
  } catch (error) {
    return { ok: false, response: json(400, { error: "unreadable_body", message: redact(env, describe(error)) }) };
  }
  if (raw.byteLength > MAX_BODY_BYTES) return { ok: false, response: tooLarge };

  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(raw)) as unknown };
  } catch (error) {
    return { ok: false, response: json(400, { error: "invalid_json", message: redact(env, describe(error)) }) };
  }
}

/** Past the ceiling, tell the client to come back in a second. */
function busy(judge: JudgeRoute): Response | null {
  if (inFlight[judge] < MAX_UPSTREAM_IN_FLIGHT) return null;
  const name = judge === "jev" ? "Jev" : "OpenAI";
  return new Response(
    JSON.stringify({
      error: "too_many_requests",
      message: `this server already has ${MAX_UPSTREAM_IN_FLIGHT} questions open with ${name}. Try again in a second.`,
    }),
    { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } },
  );
}

async function responses(request: Request, env: ServerEnv): Promise<Response> {
  const admitted = await admit(request, env, "openai");
  if (!admitted.ok) return admitted.response;
  const body = admitted.body;
  const reason = rejectResponsesPayload(body);
  if (reason !== null) return json(400, { error: "invalid_request", message: reason });
  const full = busy("openai");
  if (full !== null) return full;

  // The model and effort are the client's: they are in the repository's committed settings,
  // and the client keys its cache on them. Nothing OpenAI keeps is asked for.
  const asked = body as Record<string, unknown>;
  const forwarded: Record<string, unknown> = {};
  for (const field of RESPONSES_FIELDS) {
    if (asked[field] !== undefined) forwarded[field] = asked[field];
  }
  forwarded["store"] = false;
  return forward(env, "openai", JSON.stringify(forwarded));
}

async function systemone(request: Request, env: ServerEnv): Promise<Response> {
  const admitted = await admit(request, env, "jev");
  if (!admitted.ok) return admitted.response;
  const body = admitted.body;
  const reason = rejectPayload(body);
  if (reason !== null) return json(400, { error: "invalid_request", message: reason });

  // Hold the line at the account wide limit: tell the client to come back in a second.
  const full = busy("jev");
  if (full !== null) return full;

  const asked = body as { state: unknown; questions: unknown };
  // The model is the server's choice, not the client's.
  return forward(
    env,
    "jev",
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
  if (request.method === "POST" && path.endsWith("/v1/responses")) return responses(request, env);
  return json(404, {
    error: "not_found",
    message: "stop-rules serves GET /health, POST /v1/systemone and POST /v1/responses",
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
