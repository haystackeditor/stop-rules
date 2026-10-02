/**
 * Where the client sends its questions, and what it authenticates with.
 *
 * Team mode: one person deploys a stop-rules server that holds the judge's key, and every
 * developer's hook sends questions to that server with a team token. Local mode: the
 * developer's own key goes straight to the judge. Team mode wins when an endpoint is known.
 * Which judge is asked, Clef or OpenAI, is a separate setting, and either one works in either
 * mode. Clef in local mode needs two values: the Cloudflare account it runs on and an API
 * token for that account.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { ClefClient, clefEndpoint, type FetchLike } from "./clef.js";
import { describeJudge, judgeInfo, type Judge } from "./judge.js";
import { CLOUDFLARE_TOKEN_SOURCE, keySourceSet, OPENAI_KEY_SOURCE, resolveApiKey } from "./key.js";
import { OPENAI_ENDPOINT, OpenAiClient, promptCacheKey, userInput } from "./openai.js";
import { readReview, reviewBody, reviewInput } from "./review.js";
import {
  chooseJudge,
  loadSettings,
  writeSettings,
  type JudgeFlags,
  type LoadedSettings,
} from "./settings.js";

/** The team server's route for Clef. */
export const CLEF_PATH = "/v1/clef";
/** The team server's route for the OpenAI judge, named after the API it forwards to. */
export const RESPONSES_PATH = "/v1/responses";
export const TOKEN_FILE = "token";
export const CLOUDFLARE_TOKEN_FILE = "cloudflare-token";
export const CLOUDFLARE_ACCOUNT_FILE = "cloudflare-account";
export const OPENAI_KEY_FILE = "openai-key";
/** The account id variable wrangler reads too. */
export const CLOUDFLARE_ACCOUNT_ENV = "CLOUDFLARE_ACCOUNT_ID";
/** A Cloudflare account id is 32 hex characters, so a token pasted in its place is caught. */
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
/** What a 401 from a team endpoint means for the developer reading it. */
export const TOKEN_REJECTED = "the team token is missing or wrong; run stop-rules login";

export interface Credentials {
  mode: "team" | "local";
  /** Where questions are posted. */
  endpoint: string;
  /** Bearer value: the team token in team mode, the judge's key in local mode. */
  bearer: string;
  /** The judge to ask, with every value filled in. The one place it is resolved. */
  judge: Judge;
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

export function cloudflareTokenPath(env: NodeJS.ProcessEnv): string {
  return path.join(configDir(env), CLOUDFLARE_TOKEN_FILE);
}

export function cloudflareAccountPath(env: NodeJS.ProcessEnv): string {
  return path.join(configDir(env), CLOUDFLARE_ACCOUNT_FILE);
}

export function openAiKeyPath(env: NodeJS.ProcessEnv): string {
  return path.join(configDir(env), OPENAI_KEY_FILE);
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
  const full = [CLEF_PATH, RESPONSES_PATH].find((route) => trimmed.endsWith(route));
  const base = full === undefined ? trimmed : trimmed.slice(0, -full.length);
  return { ok: true, base, post: `${base}${CLEF_PATH}` };
}

/** The team server route a judge's questions go to. */
export function teamRoute(base: string, judge: { kind: "clef" | "openai" }): string {
  return `${base}${judge.kind === "clef" ? CLEF_PATH : RESPONSES_PATH}`;
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
  // No endpoint means local mode: this machine's own key.
  if (endpoint === undefined) return { ok: true, endpoint: null, source: "none" };
  return { ok: true, endpoint, source: loaded.file };
}

export type AccountLookup = { ok: true; value: string | null } | { ok: false; reason: string };

/** Checks an account id where it was found, so the message can say where to fix it. */
function accountId(raw: string, from: string): { ok: true; value: string } | { ok: false; reason: string } {
  if (!ACCOUNT_ID.test(raw)) {
    return {
      ok: false,
      reason: `${from} does not hold a Cloudflare account id, which is 32 hex characters. The dashboard shows it on the account's home page.`,
    };
  }
  return { ok: true, value: raw.toLowerCase() };
}

/** The Cloudflare account Clef runs on: the environment, then the file login wrote. */
async function readCloudflareAccount(env: NodeJS.ProcessEnv): Promise<AccountLookup> {
  const fromEnv = envValue(env, CLOUDFLARE_ACCOUNT_ENV);
  if (!fromEnv.ok) return { ok: false, reason: fromEnv.reason };
  if (fromEnv.value !== null) return accountId(fromEnv.value, CLOUDFLARE_ACCOUNT_ENV);
  const file = cloudflareAccountPath(env);
  const stored = await readTrimmed(file);
  if (stored.error !== undefined) return { ok: false, reason: stored.error };
  if (stored.value === null) return { ok: true, value: null };
  return accountId(stored.value, file);
}

/** The Cloudflare API token: the environment, then the file login wrote. */
async function readCloudflareToken(env: NodeJS.ProcessEnv): Promise<AccountLookup> {
  if (keySourceSet(env, CLOUDFLARE_TOKEN_SOURCE)) {
    const key = await resolveApiKey(env, CLOUDFLARE_TOKEN_SOURCE);
    return key.ok ? { ok: true, value: key.key } : { ok: false, reason: key.reason };
  }
  const stored = await readTrimmed(cloudflareTokenPath(env));
  if (stored.error !== undefined) return { ok: false, reason: stored.error };
  return { ok: true, value: stored.value };
}

const STORE_CLOUDFLARE =
  'printf %s "$CLOUDFLARE_API_TOKEN" | stop-rules login --cloudflare-token-stdin --cloudflare-account <account id>';

export async function resolveCredentials(
  loaded: LoadedSettings,
  env: NodeJS.ProcessEnv,
  judge: Judge,
): Promise<CredentialsResult> {
  // Checked here so a blank XDG_CONFIG_HOME is one plain message, not a thrown error from
  // deep inside a file read.
  const configHome = envValue(env, "XDG_CONFIG_HOME");
  if (!configHome.ok) return { ok: false, reason: configHome.reason };

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
        endpoint: teamRoute(parsed.base, judge),
        bearer: token,
        judge,
        teamBase: parsed.base,
      },
    };
  }

  if (judge.kind === "openai") {
    // The OpenAI key comes from the environment, then from the file login wrote. Nothing
    // falls back to the Cloudflare token or to the other judge.
    if (keySourceSet(env, OPENAI_KEY_SOURCE)) {
      const key = await resolveApiKey(env, OPENAI_KEY_SOURCE);
      if (!key.ok) return { ok: false, reason: key.reason };
      return { ok: true, credentials: { mode: "local", endpoint: OPENAI_ENDPOINT, bearer: key.key, judge } };
    }
    const stored = await readTrimmed(openAiKeyPath(env));
    if (stored.error !== undefined) return { ok: false, reason: stored.error };
    if (stored.value !== null) {
      return { ok: true, credentials: { mode: "local", endpoint: OPENAI_ENDPOINT, bearer: stored.value, judge } };
    }
    return {
      ok: false,
      reason:
        "no OpenAI API key and no team endpoint, and this repo's judge is openai. Set OPENAI_API_KEY, or store a key with stop-rules login --openai-key-stdin, or point this repo at your team server with stop-rules team <url>.",
    };
  }

  // Clef runs on the developer's own Cloudflare account: its id and a token for it, each from
  // the environment first, then from the file login wrote.
  const account = await readCloudflareAccount(env);
  if (!account.ok) return { ok: false, reason: account.reason };
  const token = await readCloudflareToken(env);
  if (!token.ok) return { ok: false, reason: token.reason };
  if (account.value === null && token.value === null) {
    return {
      ok: false,
      reason: `no Cloudflare account id or API token for Clef, and no team endpoint. Set ${CLOUDFLARE_ACCOUNT_ENV} and ${CLOUDFLARE_TOKEN_SOURCE.direct}, or store them with ${STORE_CLOUDFLARE}, or point this repo at your team server with stop-rules team <url>.`,
    };
  }
  if (account.value === null) {
    return {
      ok: false,
      reason: `no Cloudflare account id for Clef. Set ${CLOUDFLARE_ACCOUNT_ENV}, or store it with stop-rules login --cloudflare-account <account id>.`,
    };
  }
  if (token.value === null) {
    return {
      ok: false,
      reason: `no Cloudflare API token for Clef. Set ${CLOUDFLARE_TOKEN_SOURCE.direct}, or store one with printf %s "$CLOUDFLARE_API_TOKEN" | stop-rules login --cloudflare-token-stdin. It needs the Workers AI permission.`,
    };
  }
  return {
    ok: true,
    credentials: {
      mode: "local",
      endpoint: clefEndpoint(account.value, judge.model),
      bearer: token.value,
      judge,
    },
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

export type LoginTarget = "token" | "cloudflare-token" | "cloudflare-account" | "openai-key";

function loginPath(env: NodeJS.ProcessEnv, target: LoginTarget): string {
  switch (target) {
    case "token":
      return tokenPath(env);
    case "cloudflare-token":
      return cloudflareTokenPath(env);
    case "cloudflare-account":
      return cloudflareAccountPath(env);
    case "openai-key":
      return openAiKeyPath(env);
  }
}

const LOGIN_WHAT: Record<LoginTarget, string> = {
  token: "That is the team token. The judge's key stays on your team's server.",
  "cloudflare-token":
    "That is your own Cloudflare API token for Clef, used when this repo has no team endpoint. It needs the Workers AI permission.",
  "cloudflare-account":
    "That is the Cloudflare account Clef runs on, used when this repo has no team endpoint.",
  "openai-key":
    "That is your own OpenAI key, used when this repo's judge is openai and it has no team endpoint.",
};

export interface LoginValue {
  target: LoginTarget;
  /** As given, untrimmed: stdin for a secret, the flag value for the account id. */
  secret: string;
}

/** One value made ready to write, or the lines that say why it cannot be. */
function checkLoginValue(entry: LoginValue): { ok: true; value: string } | { ok: false; lines: string[] } {
  const value = entry.secret.trim();
  if (value.length === 0) {
    return {
      ok: false,
      lines:
        entry.target === "cloudflare-account"
          ? ["stop-rules: --cloudflare-account needs your Cloudflare account id."]
          : ["stop-rules: nothing arrived on stdin.", 'Use: printf %s "$SECRET" | stop-rules login --token-stdin'],
    };
  }
  if (entry.target !== "cloudflare-account") return { ok: true, value };
  const checked = accountId(value, "--cloudflare-account");
  return checked.ok ? checked : { ok: false, lines: [`stop-rules: ${checked.reason}`] };
}

/**
 * Writes each value with mode 0600 in a directory only the user can read. Every value is checked
 * before any is written, so a token and account id given together are stored together or not at
 * all: a mistyped id, or a token that never arrived, never leaves a new id beside an old token.
 * The account id is not a secret, but it lives beside the token it belongs to and is kept the
 * same way.
 */
export async function login(env: NodeJS.ProcessEnv, entries: readonly LoginValue[]): Promise<WriteResult> {
  const ready: { target: LoginTarget; value: string }[] = [];
  for (const entry of entries) {
    const checked = checkLoginValue(entry);
    if (!checked.ok) return { ok: false, lines: [...checked.lines, "Nothing was stored."] };
    ready.push({ target: entry.target, value: checked.value });
  }
  const dir = configDir(env);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const lines: string[] = [];
  for (const { target, value } of ready) {
    const file = loginPath(env, target);
    await fs.writeFile(file, `${value}\n`, { encoding: "utf8", mode: 0o600 });
    // writeFile only applies mode when it creates the file, so set it either way.
    await fs.chmod(file, 0o600);
    lines.push(`wrote ${file} with mode 0600`, LOGIN_WHAT[target]);
  }
  return { ok: true, lines: [...lines, "Check it with: stop-rules login --check"] };
}

/** The rule and piece login --check asks about. Small, and plainly not a break. */
const PROBE_RULE = { id: "probe", text: "Do not leave a TODO comment in the code." };
const PROBE_VIEW = {
  file: "probe.ts",
  diff: "@@ -0,0 +1 @@\n+export const answer = 42;",
};

/**
 * One health call in team mode and one real question to the judge this repo is set to, so a
 * developer can see the whole path working.
 */
export async function loginCheck(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  flags: JudgeFlags = {},
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Promise<WriteResult> {
  const load = await loadSettings(repoRoot);
  if (!load.ok) return { ok: false, lines: [`stop-rules: ${load.reason}`] };
  const chosen = chooseJudge(load.loaded.settings.judge, flags);
  if (!chosen.ok) return { ok: false, lines: [`stop-rules: ${chosen.reason}`] };
  const resolved = await resolveCredentials(load.loaded, env, chosen.choice);
  if (!resolved.ok) return { ok: false, lines: [`stop-rules: ${resolved.reason}`] };
  const { mode, endpoint, bearer, judge, teamBase } = resolved.credentials;
  const lines = [`mode: ${mode}`, `judge: ${describeJudge(judgeInfo(judge))}`, `endpoint: ${endpoint}`];
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

  const note = (message: string): void => {
    lines.push(`  note: ${message}`);
  };
  // Room for the transport's own three attempts, so a network failure reports itself as one
  // rather than as an exhausted budget.
  const maxCalls = 4;

  if (judge.kind === "openai" && judge.form === "review") {
    const client = new OpenAiClient({
      endpoint,
      model: judge.model,
      effort: judge.effort,
      apiKey: bearer,
      maxCalls,
      fetchImpl,
      concurrency: 1,
      note,
    });
    const outcome = await client.request({
      body: reviewBody(judge.model, judge.effort, reviewInput([{ file: PROBE_VIEW.file, views: [PROBE_VIEW] }], [PROBE_RULE])),
      read: readReview,
    });
    if (outcome.ok) {
      const count = outcome.answer.length;
      lines.push(
        `openai: pass (${judge.model} at effort ${judge.effort}, review form, answered with ${count === 1 ? "1 finding" : `${count} findings`}, ${outcome.usage.inputTokens} input and ${outcome.usage.outputTokens} output tokens)`,
      );
    } else {
      const message =
        outcome.failure === "auth" && mode === "team" ? TOKEN_REJECTED : outcome.message;
      lines.push(`openai: fail (${message})`);
      ok = false;
    }
    return { ok, lines };
  }

  if (judge.kind === "openai") {
    const client = new OpenAiClient({
      endpoint,
      model: judge.model,
      effort: judge.effort,
      apiKey: bearer,
      maxCalls,
      fetchImpl,
      concurrency: 1,
      note,
    });
    const outcome = await client.send({
      input: userInput(PROBE_VIEW, [PROBE_RULE]),
      promptCacheKey: await promptCacheKey([PROBE_RULE]),
      ids: ["q0"],
    });
    if (outcome.ok) {
      const answer = outcome.answers["q0"];
      lines.push(
        answer === undefined
          ? "openai: fail (the answer for q0 was missing)"
          : `openai: pass (${judge.model} at effort ${judge.effort} answered ${answer.toFixed(2)}, ${outcome.usage.inputTokens} input and ${outcome.usage.outputTokens} output tokens)`,
      );
      if (answer === undefined) ok = false;
    } else {
      const message =
        outcome.failure === "auth" && mode === "team" ? TOKEN_REJECTED : outcome.message;
      lines.push(`openai: fail (${message})`);
      ok = false;
    }
    return { ok, lines };
  }

  const client = new ClefClient({
    endpoint,
    model: judge.model,
    apiKey: bearer,
    maxCalls,
    fetchImpl,
    note,
  });
  const outcome = await client.send(
    { probe: "stop-rules connectivity check" },
    { q0: { type: "noul", instructions: "This request reached Clef." } },
  );
  if (outcome.ok) {
    const answer = outcome.answers["q0"];
    lines.push(
      answer === undefined
        ? "clef: fail (the answer for q0 was missing)"
        : `clef: pass (${judge.model} answered ${answer.toFixed(2)}, ${outcome.usage.inputTokens} input tokens)`,
    );
    if (answer === undefined) ok = false;
  } else {
    const message =
      outcome.failure === "auth" && mode === "team" ? TOKEN_REJECTED : outcome.message;
    lines.push(`clef: fail (${message})`);
    ok = false;
  }
  return { ok, lines };
}
