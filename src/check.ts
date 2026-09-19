/**
 * Node side orchestration: repository, rules file, lock, snapshot, baseline, cache file
 * and run log. The judging itself lives in the runtime free engine.
 */

import * as path from "node:path";
import {
  resolveCredentials,
  TEAM_CONFIG_FILE,
  TOKEN_REJECTED,
  type Credentials,
} from "./credentials.js";
import { chunkFile, parseDiff } from "./diff.js";
import { runEngine, type CacheLike } from "./engine.js";
import {
  diffTrees,
  emptyTree,
  findRepo,
  hasHead,
  objectExists,
  resolveTree,
  snapshotWorkingTree,
} from "./git.js";
import { AUTH_REJECTED, DEFAULT_MODEL, type FetchLike } from "./jev.js";
import { renderReport } from "./report.js";
import { loadRules } from "./rules.js";
import {
  acquireLock,
  appendRunLog,
  loadCache,
  loadState,
  reportedKey,
  saveCache,
  saveState,
  stateDirFor,
  type Cache,
  type StopRulesState,
} from "./state.js";
import type { CheckReport, Rule, RunStats } from "./types.js";

const LOOP_GUARD_ROUNDS = 3;
const MAX_SESSIONS_KEPT = 100;

export interface RunOptions {
  cwd: string;
  mode: "hook" | "check";
  threshold: number;
  maxCalls: number;
  rulesPath?: string;
  base?: string;
  sessionId?: string;
  stopHookActive?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  /** Verification hook so retry waits do not slow a scripted run down. */
  sleep?: (ms: number) => Promise<void>;
}

export type RunOutcome =
  | { kind: "cannot-run"; reason: string }
  | { kind: "clean"; report: CheckReport; text: string }
  | { kind: "violations"; report: CheckReport; text: string }
  | { kind: "handoff"; report: CheckReport; text: string };

function cannotRun(reason: string): RunOutcome {
  return { kind: "cannot-run", reason };
}

function fileCache(cache: Cache): CacheLike {
  return {
    get: (key) => cache.entries[key]?.noul,
    set: (key, noul) => {
      cache.entries[key] = { noul, at: Date.now() };
    },
  };
}

export async function run(options: RunOptions): Promise<RunOutcome> {
  const started = Date.now();
  const env = options.env ?? process.env;
  const notes: string[] = [];
  const note = (message: string): void => {
    notes.push(message);
  };

  const repo = await findRepo(options.cwd);
  if (repo === null) return cannotRun(`${options.cwd} is not inside a git repository.`);

  const rulesPath = options.rulesPath
    ? path.resolve(options.cwd, options.rulesPath)
    : path.join(repo.root, ".stop-rules.md");
  const rulesLoad = await loadRules(rulesPath);
  if (!rulesLoad.ok) return cannotRun(rulesLoad.reason ?? "no rules to check against.");

  // Team mode when this repo knows a stop-rules endpoint, the developer's own key if not.
  const credentials = await resolveCredentials(repo.root, env);
  if (!credentials.ok) return cannotRun(credentials.reason);

  const stateDir = stateDirFor(repo.gitDir);
  const release = await acquireLock(stateDir);
  if (release === null) {
    return cannotRun("another stop-rules run is still holding the lock after 60 seconds.");
  }
  try {
    return await runLocked({
      options,
      env,
      repo,
      rulesPath,
      rules: rulesLoad.rules,
      credentials: credentials.credentials,
      stateDir,
      notes,
      note,
      started,
    });
  } finally {
    await release();
  }
}

interface LockedArgs {
  options: RunOptions;
  env: NodeJS.ProcessEnv;
  repo: { root: string; gitDir: string };
  rulesPath: string;
  rules: Rule[];
  credentials: Credentials;
  stateDir: string;
  notes: string[];
  note: (message: string) => void;
  started: number;
}

async function runLocked(args: LockedArgs): Promise<RunOutcome> {
  const { options, env, repo, rulesPath, rules, credentials, stateDir, notes, note, started } = args;
  const model = env["STOP_RULES_JEV_MODEL"] ?? DEFAULT_MODEL;

  const state = await loadState(stateDir, note);
  const cache = await loadCache(stateDir, note);

  // Taken under the lock, so a second firing checks the newest tree.
  const snapshot = await snapshotWorkingTree(repo, stateDir);

  let baseline: string;
  if (options.base !== undefined) {
    const resolved = await resolveTree(repo.root, options.base);
    if (resolved === null) return cannotRun(`unknown revision ${options.base}.`);
    baseline = resolved;
  } else if (state.lastTree !== undefined && (await objectExists(repo.root, state.lastTree))) {
    baseline = state.lastTree;
  } else if (await hasHead(repo.root)) {
    baseline = (await resolveTree(repo.root, "HEAD")) ?? (await emptyTree(repo.root));
  } else {
    baseline = await emptyTree(repo.root);
  }

  const rulesRelative = path.relative(repo.root, rulesPath).split(path.sep).join("/");
  // The rules file and the team endpoint file are configuration, not code a rule is about.
  const files = parseDiff(await diffTrees(repo.root, baseline, snapshot), [
    rulesRelative,
    TEAM_CONFIG_FILE,
  ]);
  const chunks = files.flatMap(chunkFile);

  const alreadyReported = state.reported;
  const engineResult = await runEngine({
    chunks,
    rules,
    threshold: options.threshold,
    maxCalls: options.maxCalls,
    model,
    endpoint: credentials.endpoint,
    apiKey: credentials.bearer,
    fetchImpl: options.fetchImpl ?? ((url, init) => fetch(url, init)),
    cache: fileCache(cache),
    note,
    ...(options.mode === "hook"
      ? {
          skipFinding: (ruleId: string, chunkText: string) =>
            alreadyReported[reportedKey(ruleId, chunkText)] !== undefined,
        }
      : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  // A rejected credential is the user's problem, not the agent's, so it can never exit 2.
  if (engineResult.notChecked.some((entry) => entry.reason === AUTH_REJECTED)) {
    await saveCache(stateDir, cache);
    return cannotRun(credentials.mode === "team" ? TOKEN_REJECTED : `${AUTH_REJECTED}.`);
  }

  if (chunks.length > 0 && engineResult.answered === 0 && engineResult.transportFailed) {
    await saveCache(stateDir, cache);
    return cannotRun("could not reach Jev for any chunk of this diff.");
  }

  const stats: RunStats = {
    files: files.length,
    chunks: chunks.length,
    calls: engineResult.calls,
    cacheHits: engineResult.cacheHits,
    violations: engineResult.violations.length,
    notChecked: engineResult.notChecked.length,
    inputTokens: engineResult.usage.inputTokens,
    outputTokens: engineResult.usage.outputTokens,
    durationMs: Date.now() - started,
  };
  const report: CheckReport = {
    violations: engineResult.violations,
    notChecked: engineResult.notChecked,
    stats,
  };

  const outcome = decide(options, report, state, engineResult.findings, snapshot, engineResult.holdBaseline);
  if (options.mode === "hook") await saveState(stateDir, state);
  await saveCache(stateDir, cache);
  await appendRunLog(stateDir, {
    at: new Date().toISOString(),
    mode: options.mode + (options.stopHookActive === true ? " (stop_hook_active)" : ""),
    files: stats.files,
    chunks: stats.chunks,
    calls: stats.calls,
    cacheHits: stats.cacheHits,
    violations: stats.violations,
    notChecked: stats.notChecked,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    durationMs: stats.durationMs,
    exitCode: outcome.kind === "violations" ? 2 : outcome.kind === "clean" ? 0 : 1,
    notes,
  });
  return outcome;
}

/** Applies the hook's session policy and mutates state accordingly. */
function decide(
  options: RunOptions,
  report: CheckReport,
  state: StopRulesState,
  findings: readonly { ruleId: string; chunkText: string }[],
  snapshot: string,
  holdBaseline: boolean,
): RunOutcome {
  const text = renderReport(report);
  const hasViolations = report.violations.length > 0;

  if (options.mode !== "hook") {
    // check is read only: it advances nothing and remembers nothing.
    return hasViolations ? { kind: "violations", report, text } : { kind: "clean", report, text };
  }

  const sessionId = options.sessionId ?? "unknown";
  const session = state.sessions[sessionId] ?? { violationRuns: 0, at: Date.now() };
  let handoff = false;

  if (hasViolations) {
    if (session.violationRuns >= LOOP_GUARD_ROUNDS) handoff = true;
    else session.violationRuns += 1;
  } else {
    session.violationRuns = 0;
  }
  session.at = Date.now();
  state.sessions[sessionId] = session;

  const ids = Object.keys(state.sessions);
  if (ids.length > MAX_SESSIONS_KEPT) {
    ids
      .sort((a, b) => (state.sessions[a]?.at ?? 0) - (state.sessions[b]?.at ?? 0))
      .slice(0, ids.length - MAX_SESSIONS_KEPT)
      .forEach((id) => {
        delete state.sessions[id];
      });
  }

  if (handoff) {
    // Leave the findings unreported and the baseline where it is, so the user still sees
    // them and a later run picks the same changes up again.
    const headline = `stop-rules: still ${report.violations.length} violations after ${LOOP_GUARD_ROUNDS} rounds, leaving them for the user`;
    return { kind: "handoff", report, text: `${headline}\n\n${text}` };
  }

  for (const finding of findings) {
    state.reported[reportedKey(finding.ruleId, finding.chunkText)] = Date.now();
  }
  if (!holdBaseline) state.lastTree = snapshot;

  return hasViolations ? { kind: "violations", report, text } : { kind: "clean", report, text };
}
