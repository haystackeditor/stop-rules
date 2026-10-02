/**
 * Clef transport: Cloudflare's decision model on Workers AI. Budget, retries, 429 handling,
 * splitting an over-long request, and making sure Clef read all of what it was sent.
 * No domain knowledge, and no Node-only imports so it also runs on edge runtimes.
 */

/** Where Workers AI runs a model for an account. */
export const WORKERS_AI_ACCOUNTS = "https://api.cloudflare.com/client/v4/accounts";

/** The URL one account asks one Clef model at. The body names the model again. */
export function clefEndpoint(accountId: string, model: string): string {
  return `${WORKERS_AI_ACCOUNTS}/${encodeURIComponent(accountId)}/ai/run/@cf/cloudflare/${model}`;
}

/**
 * What a 401 or 403 from Workers AI reads as. A wrong account id gets the same 401, code 10000
 * "Authentication error", as a wrong token (measured 2 October 2026). Team mode translates it
 * for the user.
 */
export const AUTH_REJECTED =
  "Workers AI rejected the Cloudflare account id or API token. The token needs the Workers AI permission on that account";
/**
 * What a Cloudflare account Workers AI will not run Clef for reads as. It is the team's problem,
 * not the agent's, so it can never be delivered as something to fix. In team mode the server
 * relays the upstream status and body as they are, so the client sees the same answer.
 */
export const BILLING_EXHAUSTED =
  "the Cloudflare account has no Workers AI allowance left. Upgrade it to Workers Paid, or wait for the daily free allowance, then run again.";

/**
 * Questions one call may carry. The request schema caps `questions` at 64 entries, and a 65th
 * is refused with a 422 (measured 2 October 2026).
 */
export const MAX_QUESTIONS = 64;

/**
 * Tokens of `state` Workers AI reads. It drops the rest without a word and answers 200 on what
 * is left. Measured on 2 October 2026: `usage.input_tokens` grows one for one with the state up
 * to 2,048 state tokens and never past it, whatever the size, while the questions are counted
 * in full on top, about 76 tokens each plus their own text. On 1 October a fact placed after
 * 16,000 characters of filler was never seen. The model catalog says 64k; for the state it is
 * wrong. No answer computed on a cut state is ever used.
 */
export const STATE_TOKENS = 2048;

/**
 * The most bytes of JSON state one token has been measured to cover, rounded up: 4.37 for an
 * indented YAML file, 3.1 to 3.6 for TypeScript, Markdown and HTML diffs, 2.5 for a
 * package-lock (2 October 2026). A state over STATE_TOKENS times this cannot be read whole, so
 * it is halved before it is ever sent.
 */
export const MOST_BYTES_PER_TOKEN = 4.5;
/** The state size past which a call is not even sent. */
export const MOST_STATE_BYTES = Math.floor(STATE_TOKENS * MOST_BYTES_PER_TOKEN);

/**
 * The fewest bytes of JSON state one token has been measured to cover in a real file, 2.5 for a
 * package-lock (a synthetic line of short numbered assignments went to 2.15). A state up to
 * STATE_TOKENS times this is all but sure to be read whole, which is what the engine uses to
 * decide whether the code around a piece can ride with it.
 */
export const FEWEST_BYTES_PER_TOKEN = 2.5;
export const SURE_STATE_BYTES = Math.floor(STATE_TOKENS * FEWEST_BYTES_PER_TOKEN);

/** `{}` as a state costs one token, the same as the one letter state "x" (measured). */
const EMPTY_STATE_TOKENS = 1;

export interface ClefQuestion {
  type: "noul";
  instructions: string;
}

export interface ClefUsage {
  inputTokens: number;
  outputTokens: number;
}

export type FailureClass =
  | "network"
  | "server"
  | "rate_limit"
  | "auth"
  | "billing"
  | "client"
  | "too_large"
  | "budget"
  | "busy"
  | "model";

/** A failure the next run could still succeed at, so the baseline must not advance. */
export function holdsBaseline(failure: FailureClass): boolean {
  return (
    failure === "network" ||
    failure === "server" ||
    failure === "rate_limit" ||
    failure === "auth" ||
    failure === "billing" ||
    failure === "budget" ||
    failure === "busy" ||
    failure === "model"
  );
}

/**
 * A rejected key, an empty account, a model the account cannot use and a busy machine end the
 * whole run, so the work still queued is given the same answer instead of asking again.
 */
export function stopsEverything(failure: FailureClass): boolean {
  return failure === "busy" || failure === "billing" || failure === "auth" || failure === "model";
}

/**
 * The machine wide gate. One slot is held for one HTTP attempt. Implemented in slots.ts,
 * which is Node only; this module stays runtime free.
 */
export type SlotGate = () => Promise<
  { ok: true; release: () => Promise<void> } | { ok: false; reason: string }
>;

export type SendOutcome =
  | { ok: true; answers: Record<string, number>; usage: ClefUsage }
  | { ok: false; failure: FailureClass; message: string };

/**
 * One request that can shrink itself if Clef cannot read all of it. The payload is opaque to
 * this module, which knows nothing about diffs or rules.
 */
export interface AskNode<T> {
  payload: T;
  state: unknown;
  questions: Record<string, ClefQuestion>;
  halve: () => [AskNode<T>, AskNode<T>] | null;
}

export interface NodeOutcome<T> {
  node: AskNode<T>;
  outcome: SendOutcome;
}

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

export interface ClefClientOptions {
  endpoint: string;
  model: string;
  /** The Cloudflare API token in local mode, the team token in team mode. */
  apiKey: string;
  maxCalls: number;
  fetchImpl: FetchLike;
  concurrency?: number;
  requestTimeoutMs?: number;
  /** Called with a one line description of anything that went wrong. */
  note: (message: string) => void;
  /** Injected in verification so retry timing does not slow a run down. */
  sleep?: (ms: number) => Promise<void>;
  /** The machine wide slot gate, when the caller has one. */
  slot?: SlotGate;
}

export const MAX_ATTEMPTS = 3;
export const BACKOFF_START_MS = 1000;
export const BACKOFF_CAP_MS = 16_000;
/** Successes in a row before the in-flight ceiling goes back up by one. */
export const STEP_UP_AFTER = 4;

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

export function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(when - Date.now(), 0);
}

/** The bytes a state weighs as JSON, which is how it travels. */
export function stateBytes(state: unknown): number {
  return new TextEncoder().encode(JSON.stringify(state)).length;
}

/** Workers AI wraps every answer: `{ success, result: { answers, usage }, errors, messages }`. */
function readResult(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null) return null;
  const result = (body as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return null;
  return result as Record<string, unknown>;
}

function readAnswers(result: Record<string, unknown>): Record<string, number> | null {
  const answers = result["answers"];
  if (typeof answers !== "object" || answers === null) return null;
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(answers as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const noul = (value as { noul?: unknown }).noul;
    if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) continue;
    out[id] = noul;
  }
  return out;
}

/**
 * The token counts. Null when the input count is missing, because without it there is no
 * telling whether the whole state was read.
 */
function readUsage(result: Record<string, unknown>): ClefUsage | null {
  const usage = result["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const input = (usage as { input_tokens?: unknown }).input_tokens;
  const output = (usage as { output_tokens?: unknown }).output_tokens;
  if (typeof input !== "number" || !Number.isFinite(input)) return null;
  return { inputTokens: input, outputTokens: typeof output === "number" ? output : 0 };
}

/** A body that names Cloudflare's own error code, as in `"code":4006`. */
function hasErrorCode(text: string, code: number): boolean {
  return new RegExp(`"code"\\s*:\\s*${code}\\b`).test(text);
}

/** The questions' share of the input count, or the failure that kept it from being measured. */
type QuestionCost = { ok: true; tokens: number } | { ok: false; failure: FailureClass; message: string };

export class ClefClient {
  private callsUsed = 0;
  /** The in-flight ceiling for this run. Halved on a 429, one step back up after four wins. */
  private limit: number;
  private readonly ceiling: number;
  private successStreak = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  /** What each set of questions costs on its own, measured once per run and shared. */
  private readonly questionCosts = new Map<string, Promise<QuestionCost>>();
  readonly usage: ClefUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(private readonly options: ClefClientOptions) {
    this.ceiling = options.concurrency ?? 4;
    this.limit = this.ceiling;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get calls(): number {
    return this.callsUsed;
  }

  /** The current in-flight ceiling, for the run log. */
  get inFlightLimit(): number {
    return this.limit;
  }

  /** A 429 means slow down: halve the ceiling, never below one. */
  private slowDown(): void {
    this.limit = Math.max(1, Math.floor(this.limit / 2));
    this.successStreak = 0;
  }

  /** Four answers in a row without a 429 buy back one slot. */
  private speedUp(): void {
    if (this.limit >= this.ceiling) return;
    this.successStreak += 1;
    if (this.successStreak < STEP_UP_AFTER) return;
    this.limit += 1;
    this.successStreak = 0;
  }

  /** Removes the key from any text that is about to be shown or logged. */
  private redact(text: string): string {
    if (this.options.apiKey.length === 0) return text;
    return text.split(this.options.apiKey).join("[redacted]");
  }

  /**
   * One HTTP attempt, with a machine wide slot held for its whole length, so all the
   * stop-rules processes on this machine together stay inside the account's limit.
   */
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

  /** One call, including retries. Every attempt costs one unit of budget. */
  private async post(state: unknown, questions: Record<string, ClefQuestion>): Promise<SendOutcome> {
    const body = JSON.stringify({ model: this.options.model, state, questions });
    let attempt = 0;
    let backoff = BACKOFF_START_MS;

    for (;;) {
      if (this.callsUsed >= this.options.maxCalls) {
        return { ok: false, failure: "budget", message: "call budget exhausted" };
      }
      attempt += 1;
      // The unit is taken before the attempt, not after it. Several attempts run at once, so
      // counting afterwards let them all pass the check above and overshoot the ceiling.
      this.callsUsed += 1;

      const sent = await this.fetchOnce(body);
      if (sent.kind === "busy") {
        // Nothing was sent, so this costs no budget. The whole run stops here.
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

      const status = sent.status;
      const text = sent.text;

      if (status === 200) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (error) {
          const message = this.redact(error instanceof Error ? error.message : String(error));
          if (attempt < MAX_ATTEMPTS) {
            this.options.note(`unparseable 200 body, retrying: ${message}`);
            await this.sleep(backoff);
            backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
            continue;
          }
          return { ok: false, failure: "server", message: `unparseable response: ${message}` };
        }
        const result = readResult(parsed);
        const answers = result === null ? null : readAnswers(result);
        if (result === null || answers === null) {
          if (attempt < MAX_ATTEMPTS) {
            this.options.note("200 response without a result.answers object, retrying");
            await this.sleep(backoff);
            backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
            continue;
          }
          return { ok: false, failure: "server", message: "response had no result.answers object" };
        }
        const usage = readUsage(result);
        if (usage === null) {
          return {
            ok: false,
            failure: "server",
            message: "response had no result.usage.input_tokens, so there is no telling whether Clef read the whole piece",
          };
        }
        this.usage.inputTokens += usage.inputTokens;
        this.usage.outputTokens += usage.outputTokens;
        this.speedUp();
        return { ok: true, answers, usage };
      }

      // An account Workers AI will not run the model for. 402 if Cloudflare ever answers with
      // it; 4006 is the code Workers AI names when a Workers Free account has used its daily
      // allowance, and it can arrive under another status.
      if (status === 402 || hasErrorCode(text, 4006)) {
        return { ok: false, failure: "billing", message: BILLING_EXHAUSTED };
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
        return { ok: false, failure: "rate_limit", message: "rate limited by Workers AI" };
      }

      if (status === 401 || status === 403) {
        return { ok: false, failure: "auth", message: AUTH_REJECTED };
      }

      if (status >= 500) {
        if (attempt < MAX_ATTEMPTS) {
          this.options.note(`Clef returned ${status}, retrying`);
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
          continue;
        }
        return { ok: false, failure: "server", message: `Clef returned ${status}` };
      }

      const snippet = this.redact(text.slice(0, 200).replace(/\s+/g, " ").trim());
      return {
        ok: false,
        failure: "client",
        message: `Clef returned ${status}: ${snippet}`,
      };
    }
  }

  /**
   * What these questions cost with nothing else in the call: the same questions about an empty
   * state, asked once per run however many calls carry them. A failed measurement is not kept,
   * so a later call asks again.
   */
  private questionCost(questions: Record<string, ClefQuestion>): Promise<QuestionCost> {
    const key = JSON.stringify(questions);
    const known = this.questionCosts.get(key);
    if (known !== undefined) return known;
    const measured = this.post({}, questions).then((outcome): QuestionCost => {
      if (!outcome.ok) {
        this.questionCosts.delete(key);
        return outcome;
      }
      return { ok: true, tokens: outcome.usage.inputTokens - EMPTY_STATE_TOKENS };
    });
    this.questionCosts.set(key, measured);
    return measured;
  }

  /**
   * One logical request: the call, its retries, and the check that Clef read the whole state.
   * An answer on a cut state is thrown away and reported as too large, so the caller halves
   * the request instead of ever using it.
   */
  async send(state: unknown, questions: Record<string, ClefQuestion>): Promise<SendOutcome> {
    const count = Object.keys(questions).length;
    if (count > MAX_QUESTIONS) {
      return {
        ok: false,
        failure: "client",
        message: `${count} questions in one call, and Clef takes at most ${MAX_QUESTIONS}`,
      };
    }
    const asked = await this.post(state, questions);
    if (!asked.ok) return asked;
    // The count is the state's tokens plus the questions'. Under STATE_TOKENS in all, the state
    // cannot have reached the cut, and no measurement is needed.
    if (asked.usage.inputTokens < STATE_TOKENS) return asked;
    const cost = await this.questionCost(questions);
    if (!cost.ok) return cost;
    const read = asked.usage.inputTokens - cost.tokens;
    if (read >= STATE_TOKENS) {
      return {
        ok: false,
        failure: "too_large",
        message: `Clef read only the first ${STATE_TOKENS} tokens of the state`,
      };
    }
    return asked;
  }

  /**
   * Runs nodes with bounded concurrency. A node whose state is plainly too big for Clef is
   * halved before it is sent, one Clef read only part of is halved and sent again, and a node
   * that cannot halve is returned as a failure: never as an answer on part of a piece.
   */
  async askAll<T>(nodes: readonly AskNode<T>[]): Promise<NodeOutcome<T>[]> {
    const queue: AskNode<T>[] = [...nodes];
    const results: NodeOutcome<T>[] = [];
    let active = 0;
    let settled = false;

    const ask = (node: AskNode<T>): Promise<SendOutcome> => {
      const bytes = stateBytes(node.state);
      if (bytes > MOST_STATE_BYTES) {
        return Promise.resolve({
          ok: false,
          failure: "too_large",
          message: `${bytes} bytes of state is more than the ${STATE_TOKENS} tokens Clef reads`,
        });
      }
      return this.send(node.state, node.questions);
    };

    return new Promise<NodeOutcome<T>[]>((resolve) => {
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
          ask(node)
            .then((outcome) => {
              if (!outcome.ok && outcome.failure === "too_large") {
                const halves = node.halve();
                if (halves !== null) {
                  this.options.note(`${outcome.message}, asking again in two halves`);
                  queue.push(halves[0], halves[1]);
                  return;
                }
                results.push({
                  node,
                  outcome: {
                    ok: false,
                    failure: "client",
                    message: `larger than Clef reads (${STATE_TOKENS} tokens of state) and cannot be split further`,
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
              this.options.note(`unexpected error while asking Clef: ${message}`);
              results.push({
                node,
                outcome: { ok: false, failure: "network", message },
              });
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
