/**
 * Where the client sends its Jev questions, and what it authenticates with.
 *
 * Team mode: one person deploys a stop-rules server that holds the Jev key, and every
 * developer's hook sends questions to that server with a team token. Local mode: the
 * developer's own Jev key goes straight to Jev. Team mode wins when an endpoint is known.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { DEFAULT_ENDPOINT, DEFAULT_MODEL, JevClient, type FetchLike } from "./jev.js";
import { resolveApiKey } from "./key.js";

export const TEAM_CONFIG_FILE = ".stop-rules.json";
export const SYSTEMONE_PATH = "/v1/systemone";
export const TOKEN_FILE = "token";
export const JEV_KEY_FILE = "jev-key";
/** What a 401 from a team endpoint means for the developer reading it. */
export const TOKEN_REJECTED = "the team token is missing or wrong; run stop-rules login";

export interface Credentials {
  mode: "team" | "local";
  /** Where questions are posted. */
  endpoint: string;
  /** Bearer value: the team token in team mode, the Jev key in local mode. */
  bearer: string;
  /** The team server root, so login --check can also call its health route. */
  teamBase?: string;
}

export type CredentialsResult =
  | { ok: true; credentials: Credentials }
  | { ok: false; reason: string };

export function configDir(env: NodeJS.ProcessEnv): string {
  const xdg = (env["XDG_CONFIG_HOME"] ?? "").trim();
  const base = xdg.length > 0 ? xdg : path.join(homedir(), ".config");
  return path.join(base, "stop-rules");
}

export function tokenPath(env: NodeJS.ProcessEnv): string {
  return path.join(configDir(env), TOKEN_FILE);
}

export function jevKeyPath(env: NodeJS.ProcessEnv): string {
  return path.join(configDir(env), JEV_KEY_FILE);
}

interface FileRead {
  /** The trimmed contents, or null when the file is absent or empty. */
  value: string | null;
  /** Set when the file exists but could not be read, so the caller can report it. */
  error?: string;
}

async function readTrimmed(file: string): Promise<FileRead> {
  try {
    const text = (await fs.readFile(file, "utf8")).trim();
    return { value: text.length > 0 ? text : null };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { value: null };
    return { value: null, error: `could not read ${file}: ${err.code ?? err.message}` };
  }
}

export type EndpointParse =
  | { ok: true; base: string; post: string }
  | { ok: false; reason: string };

/** Accepts the server root and also the full questions URL, so both can be pasted. */
export function parseEndpoint(raw: string): EndpointParse {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return { ok: false, reason: "the team endpoint is empty" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: `${raw} is not a URL` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `the team endpoint must start with http:// or https://, not ${parsed.protocol}` };
  }
  const isFull = trimmed.endsWith(SYSTEMONE_PATH);
  return {
    ok: true,
    base: isFull ? trimmed.slice(0, -SYSTEMONE_PATH.length) : trimmed,
    post: isFull ? trimmed : `${trimmed}${SYSTEMONE_PATH}`,
  };
}

export type TeamEndpointLookup =
  | { ok: true; endpoint: string | null; source: string }
  | { ok: false; reason: string };

/** Env first, then the committed .stop-rules.json, which holds no secret. */
export async function readTeamEndpoint(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<TeamEndpointLookup> {
  const fromEnv = (env["STOP_RULES_ENDPOINT"] ?? "").trim();
  if (fromEnv.length > 0) return { ok: true, endpoint: fromEnv, source: "STOP_RULES_ENDPOINT" };

  const file = path.join(repoRoot, TEAM_CONFIG_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { ok: true, endpoint: null, source: "none" };
    return { ok: false, reason: `could not read ${file}: ${err.code ?? err.message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      reason: `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `${file} does not hold a JSON object.` };
  }
  const endpoint = (parsed as { endpoint?: unknown }).endpoint;
  if (endpoint === undefined) return { ok: true, endpoint: null, source: file };
  if (typeof endpoint !== "string") {
    return { ok: false, reason: `the endpoint in ${file} is not a string.` };
  }
  return { ok: true, endpoint, source: file };
}

export async function resolveCredentials(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<CredentialsResult> {
  const team = await readTeamEndpoint(repoRoot, env);
  if (!team.ok) return { ok: false, reason: team.reason };

  if (team.endpoint !== null) {
    const parsed = parseEndpoint(team.endpoint);
    if (!parsed.ok) return { ok: false, reason: `${parsed.reason} (from ${team.source})` };
    let token = (env["STOP_RULES_TOKEN"] ?? "").trim();
    if (token.length === 0) {
      const file = await readTrimmed(tokenPath(env));
      if (file.error !== undefined) return { ok: false, reason: file.error };
      token = file.value ?? "";
    }
    if (token.length === 0) {
      return {
        ok: false,
        reason: `no team token for ${parsed.base}. Store one with: printf %s "$TOKEN" | stop-rules login --token-stdin`,
      };
    }
    return {
      ok: true,
      credentials: { mode: "team", endpoint: parsed.post, bearer: token, teamBase: parsed.base },
    };
  }

  const endpoint = (env["STOP_RULES_JEV_ENDPOINT"] ?? "").trim() || DEFAULT_ENDPOINT;
  const envKeySet =
    (env["TYPESAFE_API_KEY"] ?? "").trim().length > 0 ||
    (env["TYPESAFE_API_KEY_FILE"] ?? "").trim().length > 0;
  if (envKeySet) {
    const key = await resolveApiKey(env);
    if (!key.ok) return { ok: false, reason: key.reason ?? "no Jev API key." };
    return { ok: true, credentials: { mode: "local", endpoint, bearer: key.key } };
  }
  const stored = await readTrimmed(jevKeyPath(env));
  if (stored.error !== undefined) return { ok: false, reason: stored.error };
  if (stored.value !== null) {
    return { ok: true, credentials: { mode: "local", endpoint, bearer: stored.value } };
  }
  return {
    ok: false,
    reason:
      "no Jev API key and no team endpoint. Set TYPESAFE_API_KEY, or store a key with stop-rules login --jev-key-stdin, or point this repo at your team server with stop-rules team <url>.",
  };
}

export interface WriteResult {
  ok: boolean;
  lines: string[];
}

/**
 * Writes the endpoint into <repoRoot>/.stop-rules.json, keeping every other key. Job A's
 * init command calls this for `init --team <endpoint>`.
 */
export async function writeTeamConfig(repoRoot: string, endpoint: string): Promise<WriteResult> {
  const parsed = parseEndpoint(endpoint);
  if (!parsed.ok) return { ok: false, lines: [`stop-rules: ${parsed.reason}`] };

  const file = path.join(repoRoot, TEAM_CONFIG_FILE);
  let settings: Record<string, unknown> = {};
  let existed = false;
  try {
    const raw = await fs.readFile(file, "utf8");
    existed = true;
    const parsedFile: unknown = JSON.parse(raw);
    if (typeof parsedFile !== "object" || parsedFile === null || Array.isArray(parsedFile)) {
      return {
        ok: false,
        lines: [`stop-rules: ${file} does not hold a JSON object. Nothing was changed.`],
      };
    }
    settings = parsedFile as Record<string, unknown>;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      return {
        ok: false,
        lines: [
          `stop-rules: could not use ${file}: ${err.message}`,
          "Nothing was changed. Fix the file and try again.",
        ],
      };
    }
  }

  settings["endpoint"] = parsed.base;
  await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return {
    ok: true,
    lines: [
      existed ? `updated ${file}` : `wrote ${file}`,
      `  endpoint: ${parsed.base}`,
      "Commit that file: it holds no secret. Every developer then only needs the team token:",
      '  printf %s "$TOKEN" | stop-rules login --token-stdin',
    ],
  };
}

/** Writes one secret with mode 0600 in a directory only the user can read. */
export async function login(
  env: NodeJS.ProcessEnv,
  target: "token" | "jev-key",
  secret: string,
): Promise<WriteResult> {
  const value = secret.trim();
  if (value.length === 0) {
    return {
      ok: false,
      lines: [
        "stop-rules: nothing arrived on stdin.",
        'Use: printf %s "$SECRET" | stop-rules login --token-stdin',
      ],
    };
  }
  const dir = configDir(env);
  const file = target === "token" ? tokenPath(env) : jevKeyPath(env);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  // writeFile only applies mode when it creates the file, so set it either way.
  await fs.chmod(file, 0o600);
  return {
    ok: true,
    lines: [
      `wrote ${file} with mode 0600`,
      target === "token"
        ? "That is the team token. The Jev key stays on your team's server."
        : "That is your own Jev key, used when this repo has no team endpoint.",
      "Check it with: stop-rules login --check",
    ],
  };
}

/** One health call and one real question, so a developer can see team mode working. */
export async function loginCheck(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Promise<WriteResult> {
  const resolved = await resolveCredentials(repoRoot, env);
  if (!resolved.ok) return { ok: false, lines: [`stop-rules: ${resolved.reason}`] };
  const { mode, endpoint, bearer, teamBase } = resolved.credentials;
  const lines = [`mode: ${mode}`, `endpoint: ${endpoint}`];
  let ok = true;

  if (teamBase !== undefined) {
    try {
      const response = await fetch(`${teamBase}/health`, { headers: { accept: "application/json" } });
      const text = (await response.text()).slice(0, 300).replace(/\s+/g, " ").trim();
      lines.push(`health: ${response.status === 200 ? "pass" : "fail"} (${response.status}) ${text}`);
      if (response.status !== 200) ok = false;
    } catch (error) {
      lines.push(`health: fail (${error instanceof Error ? error.message : String(error)})`);
      ok = false;
    }
  }

  const client = new JevClient({
    endpoint,
    model: (env["STOP_RULES_JEV_MODEL"] ?? "").trim() || DEFAULT_MODEL,
    apiKey: bearer,
    // Room for the transport's own three attempts, so a network failure reports itself as
    // one rather than as an exhausted budget.
    maxCalls: 4,
    fetchImpl,
    note: (message) => {
      lines.push(`  note: ${message}`);
    },
  });
  const outcome = await client.send(
    { probe: "stop-rules connectivity check" },
    { q0: { type: "noul", instructions: "This request reached Jev." } },
  );
  if (outcome.ok) {
    const answer = outcome.answers["q0"];
    lines.push(
      answer === undefined
        ? "jev: fail (the answer for q0 was missing)"
        : `jev: pass (answered ${answer.toFixed(2)})`,
    );
    if (answer === undefined) ok = false;
  } else {
    const message =
      outcome.failure === "auth" && mode === "team" ? TOKEN_REJECTED : outcome.message;
    lines.push(`jev: fail (${message})`);
    ok = false;
  }
  return { ok, lines };
}
