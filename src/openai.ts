/**
 * OpenAI judge transport. One Responses API request per piece, with strict structured output.
 * Budget, retries, 429 handling and the failure classes are Jev's, from jev.ts, so a run
 * behaves the same whichever judge it asks. No Node-only imports, so it also runs on edge
 * runtimes.
 *
 * The request shape is the one that was measured: the system instruction, then the rules,
 * which are the same on every call of a run, then the piece last, so the part every call
 * shares comes first and OpenAI's prompt cache can reuse it. The answer is
 * `{"scores": [number, ...]}`, one probability per rule, in the order the rules were listed.
 */

import {
  BACKOFF_CAP_MS,
  BACKOFF_START_MS,
  MAX_ATTEMPTS,
  STEP_UP_AFTER,
  defaultSleep,
  parseRetryAfter,
  stopsEverything,
  type FailureClass,
  type FetchLike,
  type SlotGate,
} from "./jev.js";
import type { Effort } from "./judge.js";
import type { JevView } from "./types.js";

export const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
/** What a 401 from OpenAI reads as. Team mode translates it for the user. */
export const OPENAI_AUTH_REJECTED = "OpenAI rejected the API key";
/** What an OpenAI account with no credit left reads as. It is the team's problem, not the agent's. */
export const OPENAI_BILLING_EXHAUSTED =
  "the OpenAI account is out of credits or over its spending limit. Add credits at OpenAI, then run again.";

/**
 * The system instruction, as measured. It is as close to the claim Jev is asked as a system
 * instruction can be, and it names the answer's order because the answer carries no rule ids.
 */
export const SYSTEM_INSTRUCTION =
  "You judge whether the added lines in a diff break a coding rule. For each rule below, give the probability from 0 to 1 that the added lines in this diff violate that rule. Use the whole range: 0.05 when the rule is clearly not broken, 0.95 when it clearly is, values between when it is unclear. Give exactly one probability per rule, in the order the rules are listed.";

/** The compact answer: one number per rule, in rule order. The count is checked here. */
export const VERDICT_SCHEMA = {
  type: "object",
  properties: { scores: { type: "array", items: { type: "number" } } },
  required: ["scores"],
  additionalProperties: false,
} as const;

/**
 * The ceiling on one answer, reasoning included. Measured over 800 calls per effort on
 * 20 to 22 September 2026, the longest answer was 683 tokens at low and 1,662 at medium, so
 * this only stops a runaway answer, which then fails plainly as incomplete.
 */
export const MAX_OUTPUT_TOKENS = 8000;

export interface OpenAiRule {
  id: string;
  text: string;
}

/** The rules, one "id: text" line each. The same on every call of a run. */
export function rulesBlock(rules: readonly OpenAiRule[]): string {
  return `Rules:\n${rules.map((rule) => `${rule.id}: ${rule.text}`).join("\n")}\n`;
}

/**
 * One piece exactly as the engine builds it for Jev: the file, the diff with the code around
 * it, and in `functions` mode the whole function after the change.
 */
export function pieceBlock(view: JevView): string {
  let text = `File: ${view.file}\n\nDiff:\n${view.diff}\n`;
  for (const unit of view.function ?? []) {
    text += `\nThe whole function ${unit.name} after the change, lines ${unit.fromLine}-${unit.toLine}:\n${unit.text}\n`;
  }
  return text;
}

/** The user message: the rules first, the piece last. */
export function userInput(view: JevView, rules: readonly OpenAiRule[]): string {
  return `${rulesBlock(rules)}\n${pieceBlock(view)}`;
}

const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Sent as prompt_cache_key, so calls that share the instruction and the rules land where
 * OpenAI can reuse their common start. A hash, so no rule text leaves in it.
 */
export async function promptCacheKey(rules: readonly OpenAiRule[]): Promise<string> {
  return `stop-rules-${(await sha256Hex(`${SYSTEM_INSTRUCTION}\u0000${rulesBlock(rules)}`)).slice(0, 24)}`;
}

/** One question: the user message, and the answer id each rule's score is filed under. */
export interface OpenAiQuestion {
  input: string;
  promptCacheKey: string;
  /** One id per rule, in the order the rules are listed in the input. */
  ids: string[];
}

export function requestBody(model: string, effort: Effort, question: OpenAiQuestion): string {
  return JSON.stringify({
    model,
    reasoning: { effort },
    instructions: SYSTEM_INSTRUCTION,
    input: question.input,
    text: {
      format: { type: "json_schema", name: "verdict", strict: true, schema: VERDICT_SCHEMA },
    },
    max_output_tokens: MAX_OUTPUT_TOKENS,
    prompt_cache_key: question.promptCacheKey,
    store: false,
  });
}

export interface OpenAiUsage {
  inputTokens: number;
  /** Input tokens OpenAI served from its prompt cache, a part of inputTokens. */
  cachedInputTokens: number;
  outputTokens: number;
  /** Output tokens spent reasoning, a part of outputTokens. */
  reasoningTokens: number;
}

export type OpenAiOutcome<A> =
  | { ok: true; answer: A; usage: OpenAiUsage }
  | { ok: false; failure: FailureClass; message: string };

export type OpenAiSendOutcome =
  | { ok: true; answers: Record<string, number>; usage: OpenAiUsage }
  | { ok: false; failure: FailureClass; message: string };

/**
 * One request body and how to read its answer. `read` returns what was wrong with the answer
 * as a string, which the client retries and then reports as a failure.
 */
export interface OpenAiRequest<A> {
  body: string;
  read: (body: ResponsesBody) => A | string;
}

/** One request that can shrink itself if the model says it is too long. */
export interface OpenAiNode<T, A> {
  payload: T;
  request: OpenAiRequest<A>;
  halve: () => [OpenAiNode<T, A>, OpenAiNode<T, A>] | null;
}

export interface OpenAiNodeOutcome<T, A> {
  node: OpenAiNode<T, A>;
  outcome: OpenAiOutcome<A>;
}

export interface OpenAiClientOptions {
  endpoint: string;
  model: string;
  effort: Effort;
  apiKey: string;
  maxCalls: number;
  fetchImpl: FetchLike;
  /** Calls kept open at once. */
  concurrency: number;
  requestTimeoutMs?: number;
  note: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  slot?: SlotGate;
}

/** The pieces of a Responses API body this client reads. */
export interface ResponsesBody {
  status?: unknown;
  incomplete_details?: unknown;
  output?: unknown;
  usage?: {
    input_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown };
    output_tokens?: unknown;
    output_tokens_details?: { reasoning_tokens?: unknown };
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readUsage(body: ResponsesBody): OpenAiUsage {
  return {
    inputTokens: count(body.usage?.input_tokens),
    cachedInputTokens: count(body.usage?.input_tokens_details?.cached_tokens),
    outputTokens: count(body.usage?.output_tokens),
    reasoningTokens: count(body.usage?.output_tokens_details?.reasoning_tokens),
  };
}

/** The error message OpenAI put in its body, or the start of the body when it has none. */
function errorText(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.replace(/\s+/g, " ").trim().slice(0, 300);
    }
  } catch {
    // Not JSON: the body itself is the best description there is.
  }
  return text.slice(0, 200).replace(/\s+/g, " ").trim();
}

/** The `code` and `param` fields of an OpenAI error body, when it has them. */
function errorFields(text: string): { code: string; param: string } {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; param?: unknown } };
    const code = parsed.error?.code;
    const param = parsed.error?.param;
    return {
      code: typeof code === "string" ? code : "",
      param: typeof param === "string" ? param : "",
    };
  } catch {
    return { code: "", param: "" };
  }
}

/** The names a team server's not_configured answer lists, or null for any other body. */
function notConfigured(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; missing?: unknown };
    if (parsed.error !== "not_configured") return null;
    const missing = Array.isArray(parsed.missing)
      ? parsed.missing.filter((name): name is string => typeof name === "string")
      : [];
    return missing.length === 0 ? "an environment variable" : missing.join(" and ");
  } catch {
    return null;
  }
}

/**
 * The one JSON text part of a completed answer, parsed. A string is what was wrong with it:
 * every shape problem is a plain failure, never a zero and never a partial answer.
 */
export function readOutputJson(body: ResponsesBody): { json: unknown } | string {
  if (body.status !== "completed") {
    return `the answer has status ${JSON.stringify(body.status ?? null)}, not completed (${JSON.stringify(body.incomplete_details ?? null)})`;
  }
  if (!Array.isArray(body.output)) return "the answer has no output list";
  const parts: { type?: unknown; text?: unknown; refusal?: unknown }[] = [];
  for (const item of body.output as { type?: unknown; content?: unknown }[]) {
    if (item === null || typeof item !== "object" || item.type !== "message") continue;
    if (!Array.isArray(item.content)) continue;
    parts.push(...(item.content as { type?: unknown; text?: unknown; refusal?: unknown }[]));
  }
  const refusal = parts.find((part) => part.type === "refusal");
  if (refusal !== undefined) return `the model refused: ${String(refusal.refusal ?? "")}`;
  const texts = parts.filter((part) => part.type === "output_text");
  if (texts.length !== 1) return `the answer has ${texts.length} text parts, not 1`;
  const text = texts[0]?.text;
  if (typeof text !== "string") return "the answer's text is not a string";
  try {
    return { json: JSON.parse(text) as unknown };
  } catch {
    return `the answer is not JSON: ${text.slice(0, 120)}`;
  }
}

/** Reads the probability form's verdict: one number from 0 to 1 per rule, in rule order. */
export function readVerdict(body: ResponsesBody, ids: readonly string[]): Record<string, number> | string {
  const read = readOutputJson(body);
  if (typeof read === "string") return read;
  const verdict = read.json;
  if (typeof verdict !== "object" || verdict === null || Array.isArray(verdict)) {
    return "the answer is not a JSON object";
  }
  const keys = Object.keys(verdict);
  if (keys.length !== 1 || keys[0] !== "scores") {
    return `the answer has the keys ${keys.join(", ")}, not just scores`;
  }
  const scores = (verdict as { scores: unknown }).scores;
  if (!Array.isArray(scores)) return "the answer's scores are not a list";
  if (scores.length !== ids.length) {
    return `the answer gives ${scores.length} scores for ${ids.length} rules`;
  }
  const answers: Record<string, number> = {};
  for (let index = 0; index < ids.length; index += 1) {
    const value: unknown = scores[index];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      return `the answer's score number ${index + 1} is ${JSON.stringify(value)}, not a number from 0 to 1`;
    }
    answers[ids[index] as string] = value;
  }
  return answers;
}

export class OpenAiClient {
  private callsUsed = 0;
  /** The in-flight ceiling for this run. Halved on a 429, one step back up after four wins. */
  private limit: number;
  private readonly ceiling: number;
  private successStreak = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly usage: OpenAiUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };

  constructor(private readonly options: OpenAiClientOptions) {
    this.ceiling = options.concurrency;
    this.limit = this.ceiling;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get calls(): number {
    return this.callsUsed;
  }

  private slowDown(): void {
    this.limit = Math.max(1, Math.floor(this.limit / 2));
    this.successStreak = 0;
  }

  private speedUp(): void {
    if (this.limit >= this.ceiling) return;
    this.successStreak += 1;
    if (this.successStreak < STEP_UP_AFTER) return;
    this.limit += 1;
    this.successStreak = 0;
  }

  private redact(text: string): string {
    if (this.options.apiKey.length === 0) return text;
    return text.split(this.options.apiKey).join("[redacted]");
  }

  /** One HTTP attempt, with a machine wide slot held for its whole length. */
  private async fetchOnce(
    body: string,
  ): Promise<
    | { kind: "busy"; reason: string }
    | { kind: "error"; message: string }
    | { kind: "response"; status: number; text: string; retryAfter: string | null }
  > {
    let free: (() => Promise<void>) | null = null;
    if (this.options.slot !== undefined) {
      const gate = await this.options.slot();
      if (!gate.ok) return { kind: "busy", reason: gate.reason };
      free = gate.release;
    }
    try {
      let response: Response;
      try {
        response = await this.options.fetchImpl(this.options.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            "Content-Type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 90_000),
        });
      } catch (error) {
        const message = this.redact(error instanceof Error ? error.message : String(error));
        return { kind: "error", message: `network error: ${message}` };
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        const message = this.redact(error instanceof Error ? error.message : String(error));
        return { kind: "error", message: `unreadable response: ${message}` };
      }
      return {
        kind: "response",
        status: response.status,
        text,
        retryAfter: response.headers.get("retry-after"),
      };
    } finally {
      if (free !== null) await free();
    }
  }

  /** The probability form: one piece, one number per rule. */
  async send(question: OpenAiQuestion): Promise<OpenAiSendOutcome> {
    const { model, effort } = this.options;
    const outcome = await this.request({
      body: requestBody(model, effort, question),
      read: (parsed) => readVerdict(parsed, question.ids),
    });
    return outcome.ok ? { ok: true, answers: outcome.answer, usage: outcome.usage } : outcome;
  }

  /** One logical request, including retries. Every attempt costs one unit of budget. */
  async request<A>(req: OpenAiRequest<A>): Promise<OpenAiOutcome<A>> {
    const { model, effort } = this.options;
    const body = req.body;
    let attempt = 0;
    let backoff = BACKOFF_START_MS;

    for (;;) {
      if (this.callsUsed >= this.options.maxCalls) {
        return { ok: false, failure: "budget", message: "call budget exhausted" };
      }
      attempt += 1;
      this.callsUsed += 1;

      const sent = await this.fetchOnce(body);
      if (sent.kind === "busy") {
        this.callsUsed -= 1;
        return { ok: false, failure: "busy", message: sent.reason };
      }

      if (sent.kind === "error") {
        if (attempt < MAX_ATTEMPTS) {
          this.options.note(`${sent.message}, retrying`);
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
          continue;
        }
        this.options.note(`${sent.message}, giving up`);
        return { ok: false, failure: "network", message: sent.message };
      }

      const { status, text } = sent;

      if (status === 200) {
        let parsed: ResponsesBody;
        try {
          parsed = JSON.parse(text) as ResponsesBody;
        } catch (error) {
          const message = this.redact(error instanceof Error ? error.message : String(error));
          if (attempt < MAX_ATTEMPTS) {
            this.options.note(`unparseable 200 body from ${model}, retrying: ${message}`);
            await this.sleep(backoff);
            backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
            continue;
          }
          return { ok: false, failure: "server", message: `unparseable response from ${model}: ${message}` };
        }
        // Paid for whether or not the answer is usable, so it is counted either way.
        const usage = readUsage(parsed);
        this.usage.inputTokens += usage.inputTokens;
        this.usage.cachedInputTokens += usage.cachedInputTokens;
        this.usage.outputTokens += usage.outputTokens;
        this.usage.reasoningTokens += usage.reasoningTokens;
        const answer = req.read(parsed);
        if (typeof answer === "string") {
          const message = this.redact(`${model}: ${answer}`);
          if (attempt < MAX_ATTEMPTS) {
            this.options.note(`${message}, retrying`);
            await this.sleep(backoff);
            backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
            continue;
          }
          return { ok: false, failure: "server", message };
        }
        this.speedUp();
        return { ok: true, answer, usage };
      }

      const fields = errorFields(text);
      const said = this.redact(errorText(text));

      // No credit left. OpenAI answers that with a 429 whose code says so, which must not be
      // mistaken for a rate limit and retried.
      if (status === 402 || fields.code === "insufficient_quota" || text.includes('"insufficient_quota"')) {
        return { ok: false, failure: "billing", message: OPENAI_BILLING_EXHAUSTED };
      }

      if (status === 429) {
        this.slowDown();
        const wait = parseRetryAfter(sent.retryAfter) ?? backoff;
        if (attempt < MAX_ATTEMPTS) {
          const room = this.limit === 1 ? "1 call" : `${this.limit} calls`;
          this.options.note(`rate limited, waiting ${wait} ms, ${room} in flight from now on`);
          await this.sleep(wait);
          backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
          continue;
        }
        return { ok: false, failure: "rate_limit", message: "rate limited by OpenAI" };
      }

      if (status === 400 && (fields.code === "context_length_exceeded" || text.includes("context_length_exceeded"))) {
        return { ok: false, failure: "too_large", message: "context_length_exceeded" };
      }

      if (status === 401) {
        return { ok: false, failure: "auth", message: OPENAI_AUTH_REJECTED };
      }

      // A model the key cannot use, or a setting that model does not take. Nothing the agent
      // can change, so it stops the run and holds the baseline, like a rejected key.
      if (
        status === 404 ||
        status === 403 ||
        fields.code === "model_not_found" ||
        (status === 400 && (fields.param === "model" || fields.param.startsWith("reasoning")))
      ) {
        return {
          ok: false,
          failure: "model",
          message: `OpenAI will not run ${model} at effort ${effort} for this key (${status}): ${said}`,
        };
      }

      // A team server that holds no OpenAI key says so. Asking again cannot change that.
      const unset = notConfigured(text);
      if (status === 503 && unset !== null) {
        return {
          ok: false,
          failure: "server",
          message: `the team server is not set up for the openai judge: it is missing ${unset}`,
        };
      }

      if (status >= 500) {
        if (attempt < MAX_ATTEMPTS) {
          this.options.note(`OpenAI returned ${status}, retrying`);
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
          continue;
        }
        return { ok: false, failure: "server", message: `OpenAI returned ${status}` };
      }

      return { ok: false, failure: "client", message: `OpenAI returned ${status}: ${said}` };
    }
  }

  /**
   * Runs nodes with bounded concurrency, the same way JevClient.askAll does. A node the model
   * calls too long is halved and both halves are queued.
   */
  async askAll<T, A>(nodes: readonly OpenAiNode<T, A>[]): Promise<OpenAiNodeOutcome<T, A>[]> {
    const queue: OpenAiNode<T, A>[] = [...nodes];
    const results: OpenAiNodeOutcome<T, A>[] = [];
    let active = 0;
    let settled = false;

    return new Promise<OpenAiNodeOutcome<T, A>[]>((resolve) => {
      const pump = (): void => {
        if (settled) return;
        if (queue.length === 0 && active === 0) {
          settled = true;
          resolve(results);
          return;
        }
        while (active < this.limit && queue.length > 0) {
          const node = queue.shift();
          if (node === undefined) break;
          active += 1;
          this.request(node.request)
            .then((outcome) => {
              if (!outcome.ok && outcome.failure === "too_large") {
                const halves = node.halve();
                if (halves !== null) {
                  this.options.note(`request too long for ${this.options.model}, resending as two halves`);
                  queue.push(halves[0], halves[1]);
                  return;
                }
                results.push({
                  node,
                  outcome: {
                    ok: false,
                    failure: "client",
                    message: `too long for ${this.options.model} and cannot be split further`,
                  },
                });
                return;
              }
              results.push({ node, outcome });
              if (!outcome.ok && stopsEverything(outcome.failure)) {
                while (queue.length > 0) {
                  const waiting = queue.shift();
                  if (waiting !== undefined) results.push({ node: waiting, outcome });
                }
              }
            })
            .catch((error: unknown) => {
              const message = this.redact(error instanceof Error ? error.message : String(error));
              this.options.note(`unexpected error while asking ${this.options.model}: ${message}`);
              results.push({ node, outcome: { ok: false, failure: "network", message } });
            })
            .finally(() => {
              active -= 1;
              pump();
            });
        }
      };
      pump();
    });
  }
}
