// The one place this project talks HTTP. Every request gets the auth header,
// a timeout, and a retry on network errors and 5xx answers.

const TIMEOUT_MS = 5_000;
const ATTEMPTS = 3;

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

let apiToken: string | null = null;

export function setApiToken(token: string): void {
  apiToken = token;
}

function authHeader(): Record<string, string> {
  if (apiToken === null) throw new Error("setApiToken was not called before the first request");
  return { Authorization: `Bearer ${apiToken}` };
}

async function once<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    throw new HttpError(url, response.status, `${init.method ?? "GET"} ${url} answered ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function withRetry<T>(url: string, init: RequestInit): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await once<T>(url, init);
    } catch (error) {
      const retryable = !(error instanceof HttpError) || error.status >= 500;
      if (!retryable || attempt === ATTEMPTS) throw error;
    }
  }
}

export function httpGet<T>(url: string): Promise<T> {
  return withRetry<T>(url, { method: "GET", headers: authHeader() });
}

export function httpDelete(url: string): Promise<void> {
  return withRetry<void>(url, { method: "DELETE", headers: authHeader() });
}
