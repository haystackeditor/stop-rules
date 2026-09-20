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
import { loadSettings, writeSettings, type LoadedSettings } from "./settings.js";

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
  /** The model to ask for. The one place it is resolved. */
  model: string;
  /** The team server root, so login --check can also call its health route. */
  teamBase?: string;
}

export type EnvRead = { ok: true; value: string | null } | { ok: false; reason: string };

/**
 * Reads one environment variable. Absent means "not configured here", which lets the next
 * source or a documented default take over. Set but blank is a mistake, and says so.
 */
export function envValue(env: NodeJS.ProcessEnv, name: string): EnvRead {
  const raw = env[name];
  if (raw === undefined) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: `${name} is set but empty. Unset it or give it a value.` };
  }
  return { ok: true, value: trimmed };
}

export type CredentialsResult =
  | { ok: true; credentials: Credentials }
  | { ok: false; reason: string };

/** Throws when XDG_CONFIG_HOME is set but blank. Absent means the usual ~/.config. */
export function configDir(env: NodeJS.ProcessEnv): string {
  const xdg = envValue(env, "XDG_CONFIG_HOME");
  if (!xdg.ok) throw new Error(xdg.reason);
  const base = xdg.value === null ? path.join(homedir(), ".config") : xdg.value;
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
  let text: string;
  try {
    text = (await fs.readFile(file, "utf8")).trim();
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { value: null };
    return { value: null, error: `could not read ${file}: ${err.code ?? err.message}` };
  }
  // A file that is there but empty is a mistake, not an absent file.
  if (text.length === 0) return { value: null, error: `${file} is empty. Store the secret again.` };
  return { value: text };
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

/** Env first, then the committed settings file, which holds no secret. */
export function readTeamEndpoint(
  loaded: LoadedSettings,
  env: NodeJS.ProcessEnv,
): TeamEndpointLookup {
  const fromEnv = envValue(env, "STOP_RULES_ENDPOINT");
  if (!fromEnv.ok) return { ok: false, reason: fromEnv.reason };
  if (fromEnv.value !== null) {
    return { ok: true, endpoint: fromEnv.value, source: "STOP_RULES_ENDPOINT" };
  }
  const endpoint = loaded.settings.endpoint;
  // No endpoint means local mode: this machine's own Jev key.
  if (endpoint === undefined) return { ok: true, endpoint: null, source: "none" };
  return { ok: true, endpoint, source: loaded.file };
}

export async function resolveCredentials(
  loaded: LoadedSettings,
  env: NodeJS.ProcessEnv,
): Promise<CredentialsResult> {
  // Checked here so a blank XDG_CONFIG_HOME is one plain message, not a thrown error from
  // deep inside a file read.
  const configHome = envValue(env, "XDG_CONFIG_HOME");
  if (!configHome.ok) return { ok: false, reason: configHome.reason };
  const model = envValue(env, "STOP_RULES_JEV_MODEL");
  if (!model.ok) return { ok: false, reason: model.reason };
  const chosenModel = model.value === null ? DEFAULT_MODEL : model.value;

  const team = readTeamEndpoint(loaded, env);
  if (!team.ok) return { ok: false, reason: team.reason };

  if (team.endpoint !== null) {
    const parsed = parseEndpoint(team.endpoint);
    if (!parsed.ok) return { ok: false, reason: `${parsed.reason} (from ${team.source})` };
    // An endpoint with no token is a broken team setup. It never quietly becomes local mode,
    // which would send the developer's own key or fail with the wrong message.
    const fromEnv = envValue(env, "STOP_RULES_TOKEN");
    if (!fromEnv.ok) return { ok: false, reason: fromEnv.reason };
    let token = fromEnv.value;
    if (token === null) {
      const file = await readTrimmed(tokenPath(env));
      if (file.error !== undefined) return { ok: false, reason: file.error };
      token = file.value;
    }
    if (token === null) {
      return {
        ok: false,
        reason: `no team token for ${parsed.base}. Store one with: printf %s "$TOKEN" | stop-rules login --token-stdin`,
      };
    }
    return {
      ok: true,
      credentials: {
        mode: "team",
        endpoint: parsed.post,
        bearer: token,
        model: chosenModel,
        teamBase: parsed.base,
      },
    };
  }

  const override = envValue(env, "STOP_RULES_JEV_ENDPOINT");
  if (!override.ok) return { ok: false, reason: override.reason };
  const endpoint = override.value === null ? DEFAULT_ENDPOINT : override.value;

  if (env["TYPESAFE_API_KEY"] !== undefined || env["TYPESAFE_API_KEY_FILE"] !== undefined) {
    const key = await resolveApiKey(env);
    if (!key.ok) return { ok: false, reason: key.reason };
    return {
      ok: true,
      credentials: { mode: "local", endpoint, bearer: key.key, model: chosenModel },
    };
  }
  const stored = await readTrimmed(jevKeyPath(env));
  if (stored.error !== undefined) return { ok: false, reason: stored.error };
  if (stored.value !== null) {
    return {
      ok: true,
      credentials: { mode: "local", endpoint, bearer: stored.value, model: chosenModel },
    };
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
 * Writes the endpoint into the repository's settings file, keeping every other key. This is
 * what `stop-rules team <url>` and `init --team <url>` call.
 */
export async function writeTeamConfig(repoRoot: string, endpoint: string): Promise<WriteResult> {
  const parsed = parseEndpoint(endpoint);
  if (!parsed.ok) return { ok: false, lines: [`stop-rules: ${parsed.reason}`] };

  const written = await writeSettings(repoRoot, { endpoint: parsed.base });
  if (!written.ok) {
    return {
      ok: false,
      lines: [
        `stop-rules: ${written.reason ?? `could not write ${written.file}`}`,
        "Nothing was changed.",
      ],
    };
  }
  return {
    ok: true,
    lines: [
      written.existed ? `updated ${written.file}` : `wrote ${written.file}`,
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
  const load = await loadSettings(repoRoot);
  if (!load.ok) return { ok: false, lines: [`stop-rules: ${load.reason}`] };
  const resolved = await resolveCredentials(load.loaded, env);
  if (!resolved.ok) return { ok: false, lines: [`stop-rules: ${resolved.reason}`] };
  const { mode, endpoint, bearer, model, teamBase } = resolved.credentials;
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
    model,
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
