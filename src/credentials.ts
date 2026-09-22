/**
 * Where the client sends its questions, and what it authenticates with.
 *
 * Team mode: one person deploys a stop-rules server that holds the judge's key, and every
 * developer's hook sends questions to that server with a team token. Local mode: the
 * developer's own key goes straight to the judge. Team mode wins when an endpoint is known.
 * Which judge is asked, Jev or OpenAI, is a separate setting, and either one works in either
 * mode.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { DEFAULT_ENDPOINT, DEFAULT_MODEL, JevClient, type FetchLike } from "./jev.js";
import { describeJudge, judgeInfo, type Judge } from "./judge.js";
import { JEV_KEY_SOURCE, keySourceSet, OPENAI_KEY_SOURCE, resolveApiKey } from "./key.js";
import { OPENAI_ENDPOINT, OpenAiClient, promptCacheKey, userInput } from "./openai.js";
import { readReview, reviewBody, reviewInput } from "./review.js";
import {
  chooseJudge,
  loadSettings,
  writeSettings,
  type JudgeChoice,
  type JudgeFlags,
  type LoadedSettings,
} from "./settings.js";

export const SYSTEMONE_PATH = "/v1/systemone";
/** The team server's route for the OpenAI judge, named after the API it forwards to. */
export const RESPONSES_PATH = "/v1/responses";
export const TOKEN_FILE = "token";
export const JEV_KEY_FILE = "jev-key";
export const OPENAI_KEY_FILE = "openai-key";
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

export function jevKeyPath(env: NodeJS.ProcessEnv): string {
  return path.join(configDir(env), JEV_KEY_FILE);
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
  const full = [SYSTEMONE_PATH, RESPONSES_PATH].find((route) => trimmed.endsWith(route));
  const base = full === undefined ? trimmed : trimmed.slice(0, -full.length);
  return { ok: true, base, post: `${base}${SYSTEMONE_PATH}` };
}

/** The team server route a judge's questions go to. */
export function teamRoute(base: string, judge: { kind: "jev" | "openai" }): string {
  return `${base}${judge.kind === "jev" ? SYSTEMONE_PATH : RESPONSES_PATH}`;
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

/** Fills in the Jev model, which comes from the environment rather than the settings file. */
function resolveJudge(choice: JudgeChoice, env: NodeJS.ProcessEnv): { ok: true; judge: Judge } | { ok: false; reason: string } {
  if (choice.kind === "openai") return { ok: true, judge: choice };
  const model = envValue(env, "STOP_RULES_JEV_MODEL");
  if (!model.ok) return { ok: false, reason: model.reason };
  return { ok: true, judge: { kind: "jev", model: model.value === null ? DEFAULT_MODEL : model.value } };
}

export async function resolveCredentials(
  loaded: LoadedSettings,
  env: NodeJS.ProcessEnv,
  choice: JudgeChoice,
): Promise<CredentialsResult> {
  // Checked here so a blank XDG_CONFIG_HOME is one plain message, not a thrown error from
  // deep inside a file read.
  const configHome = envValue(env, "XDG_CONFIG_HOME");
  if (!configHome.ok) return { ok: false, reason: configHome.reason };
  const resolved = resolveJudge(choice, env);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const judge = resolved.judge;

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
    // falls back to the Jev key or to the other judge.
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

  const override = envValue(env, "STOP_RULES_JEV_ENDPOINT");
  if (!override.ok) return { ok: false, reason: override.reason };
  const endpoint = override.value === null ? DEFAULT_ENDPOINT : override.value;

  if (keySourceSet(env, JEV_KEY_SOURCE)) {
    const key = await resolveApiKey(env, JEV_KEY_SOURCE);
    if (!key.ok) return { ok: false, reason: key.reason };
    return {
      ok: true,
      credentials: { mode: "local", endpoint, bearer: key.key, judge },
    };
  }
  const stored = await readTrimmed(jevKeyPath(env));
  if (stored.error !== undefined) return { ok: false, reason: stored.error };
  if (stored.value !== null) {
    return {
      ok: true,
      credentials: { mode: "local", endpoint, bearer: stored.value, judge },
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

export type LoginTarget = "token" | "jev-key" | "openai-key";

/** Writes one secret with mode 0600 in a directory only the user can read. */
export async function login(
  env: NodeJS.ProcessEnv,
  target: LoginTarget,
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
  const file =
    target === "token" ? tokenPath(env) : target === "jev-key" ? jevKeyPath(env) : openAiKeyPath(env);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  // writeFile only applies mode when it creates the file, so set it either way.
  await fs.chmod(file, 0o600);
  const what =
    target === "token"
      ? "That is the team token. The judge's key stays on your team's server."
      : target === "jev-key"
        ? "That is your own Jev key, used when this repo has no team endpoint."
        : "That is your own OpenAI key, used when this repo's judge is openai and it has no team endpoint.";
  return {
    ok: true,
    lines: [`wrote ${file} with mode 0600`, what, "Check it with: stop-rules login --check"],
  };
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

  const client = new JevClient({
    endpoint,
    model: judge.model,
    apiKey: bearer,
    maxCalls,
    fetchImpl,
    note,
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
