/**
 * Jev transport. Budget, retries, 429 handling and splitting an over-long request.
 * No domain knowledge, and no Node-only imports so it also runs on edge runtimes.
 */

export const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";
/** What a 401 or 403 from the endpoint reads as. Team mode translates it for the user. */
export const AUTH_REJECTED = "Jev rejected the API key";

export interface JevQuestion {
  type: "noul";
  instructions: string;
}

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
}

export type FailureClass =
  | "network"
  | "server"
  | "rate_limit"
  | "auth"
  | "client"
  | "too_large"
  | "budget";

/** A failure the next run could still succeed at, so the baseline must not advance. */
export function holdsBaseline(failure: FailureClass): boolean {
  return (
    failure === "network" ||
    failure === "server" ||
    failure === "rate_limit" ||
    failure === "auth" ||
    failure === "budget"
  );
}

export type SendOutcome =
  | { ok: true; answers: Record<string, number>; usage: JevUsage }
  | { ok: false; failure: FailureClass; message: string };

/**
 * One request that can shrink itself if the service says it is too long. The payload is
 * opaque to this module, which knows nothing about diffs or rules.
 */
export interface AskNode<T> {
  payload: T;
  state: unknown;
  questions: Record<string, JevQuestion>;
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

export interface JevClientOptions {
  endpoint: string;
  model: string;
  apiKey: string;
  maxCalls: number;
  fetchImpl: FetchLike;
  concurrency?: number;
  requestTimeoutMs?: number;
  /** Called with a one line description of anything that went wrong. */
  note: (message: string) => void;
  /** Injected in verification so retry timing does not slow a run down. */
  sleep?: (ms: number) => Promise<void>;
}

const MAX_ATTEMPTS = 3;
const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 16_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(when - Date.now(), 0);
}

function readAnswers(body: unknown): Record<string, number> | null {
  if (typeof body !== "object" || body === null) return null;
  const answers = (body as { answers?: unknown }).answers;
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

function readUsage(body: unknown): JevUsage {
  if (typeof body !== "object" || body === null) return { inputTokens: 0, outputTokens: 0 };
  const usage = (body as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return { inputTokens: 0, outputTokens: 0 };
  const input = (usage as { input_tokens?: unknown }).input_tokens;
  const output = (usage as { output_tokens?: unknown }).output_tokens;
  return {
    inputTokens: typeof input === "number" ? input : 0,
    outputTokens: typeof output === "number" ? output : 0,
  };
}

export class JevClient {
  private callsUsed = 0;
  private limit: number;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly usage: JevUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(private readonly options: JevClientOptions) {
    this.limit = options.concurrency ?? 4;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get calls(): number {
    return this.callsUsed;
  }

  /** Removes the key from any text that is about to be shown or logged. */
  private redact(text: string): string {
    if (this.options.apiKey.length === 0) return text;
    return text.split(this.options.apiKey).join("[redacted]");
  }

  /** One logical request, including retries. Every attempt costs one unit of budget. */
  async send(state: unknown, questions: Record<string, JevQuestion>): Promise<SendOutcome> {
    const body = JSON.stringify({ state, model: this.options.model, questions });
    let attempt = 0;
    let backoff = BACKOFF_START_MS;

    for (;;) {
      if (this.callsUsed >= this.options.maxCalls) {
        return { ok: false, failure: "budget", message: "call budget exhausted" };
      }
      this.callsUsed += 1;
      attempt += 1;

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
        if (attempt < MAX_ATTEMPTS) {
          this.options.note(`network error, retrying: ${message}`);
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
          continue;
        }
        this.options.note(`network error, giving up: ${message}`);
        return { ok: false, failure: "network", message: `network error: ${message}` };
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        const message = this.redact(error instanceof Error ? error.message : String(error));
        if (attempt < MAX_ATTEMPTS) {
          this.options.note(`could not read response body, retrying: ${message}`);
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
          continue;
        }
        return { ok: false, failure: "network", message: `unreadable response: ${message}` };
      }

      if (response.status === 200) {
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
        const answers = readAnswers(parsed);
        if (answers === null) {
          if (attempt < MAX_ATTEMPTS) {
            this.options.note("200 response without an answers object, retrying");
            await this.sleep(backoff);
            backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
            continue;
          }
          return { ok: false, failure: "server", message: "response had no answers object" };
        }
        const usage = readUsage(parsed);
        this.usage.inputTokens += usage.inputTokens;
        this.usage.outputTokens += usage.outputTokens;
        return { ok: true, answers, usage };
      }

      if (response.status === 429) {
        this.limit = 1;
        const wait = parseRetryAfter(response.headers.get("retry-after")) ?? backoff;
        if (attempt < MAX_ATTEMPTS) {
          this.options.note(`rate limited, waiting ${wait} ms`);
          await this.sleep(wait);
          backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
          continue;
        }
        return { ok: false, failure: "rate_limit", message: "rate limited by Jev" };
      }

      if (response.status === 400 && text.includes("max_tokens_exceeded")) {
        return { ok: false, failure: "too_large", message: "max_tokens_exceeded" };
      }

      if (response.status === 401 || response.status === 403) {
        return { ok: false, failure: "auth", message: AUTH_REJECTED };
      }

      if (response.status >= 500) {
        if (attempt < MAX_ATTEMPTS) {
          this.options.note(`Jev returned ${response.status}, retrying`);
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
          continue;
        }
        return { ok: false, failure: "server", message: `Jev returned ${response.status}` };
      }

      const snippet = this.redact(text.slice(0, 200).replace(/\s+/g, " ").trim());
      return {
        ok: false,
        failure: "client",
        message: `Jev returned ${response.status}: ${snippet}`,
      };
    }
  }

  /**
   * Runs nodes with bounded concurrency. A node the service calls too long is halved and
   * both halves are queued; a node that cannot halve is returned as a failure.
   */
  async askAll<T>(nodes: readonly AskNode<T>[]): Promise<NodeOutcome<T>[]> {
    const queue: AskNode<T>[] = [...nodes];
    const results: NodeOutcome<T>[] = [];
    let active = 0;
    let settled = false;

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
          this.send(node.state, node.questions)
            .then((outcome) => {
              if (!outcome.ok && outcome.failure === "too_large") {
                const halves = node.halve();
                if (halves !== null) {
                  this.options.note("request too long for Jev, resending as two halves");
                  queue.push(halves[0], halves[1]);
                  return;
                }
                results.push({
                  node,
                  outcome: {
                    ok: false,
                    failure: "client",
                    message: "too long for Jev and cannot be split further",
                  },
                });
                return;
              }
              results.push({ node, outcome });
            })
            .catch((error: unknown) => {
              const message = this.redact(error instanceof Error ? error.message : String(error));
              this.options.note(`unexpected error while asking Jev: ${message}`);
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
