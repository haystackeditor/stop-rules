/**
 * Node side orchestration: repository, settings, rules file, lock, snapshot, baseline, cache
 * file and run log. The judging itself lives in the runtime free engine.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { CONTEXT_LINES } from "./context.js";
import { resolveCredentials, TOKEN_REJECTED, type Credentials } from "./credentials.js";
import { cutFiles } from "./cut.js";
import { parseDiff, type FileDiff } from "./diff.js";
import { defaultMaxCalls, DEFAULT_THRESHOLD, runEngine, type CacheLike } from "./engine.js";
import {
  diffTrees,
  emptyTree,
  hasHead,
  objectExists,
  readBlob,
  resolveTree,
  snapshotWorkingTree,
  type RepoPaths,
} from "./git.js";
import { AUTH_REJECTED, BILLING_EXHAUSTED, type FetchLike } from "./jev.js";
import { judgeInfo, judgeName, type Effort, type JudgeKind } from "./judge.js";
import { OPENAI_AUTH_REJECTED, OPENAI_BILLING_EXHAUSTED } from "./openai.js";
import { coverage, cutWords, noneCheckedReason, renderReport, renderScores } from "./report.js";
import { loadRules } from "./rules.js";
import { chooseJudge, DEFAULT_CUT, loadSettings } from "./settings.js";
import { acquireSlot, machineBusy, slotsDir } from "./slots.js";
import {
  acquireLock,
  appendRunLog,
  loadCache,
  loadState,
  reportedKey,
  resetState,
  saveCache,
  saveState,
  stateDirFor,
  type Cache,
  type StopRulesState,
} from "./state.js";
import type {
  CheckReport,
  CutMode,
  NotChecked,
  Rule,
  RunStats,
  ScoreReport,
  SkippedFile,
} from "./types.js";

const LOOP_GUARD_ROUNDS = 3;
const MAX_SESSIONS_KEPT = 100;

export interface RunOptions {
  /** The repository to work on, already resolved by the one rule in repo.ts. */
  repo: RepoPaths;
  /** Where the command was run. Only relative paths the user typed resolve against it. */
  cwd: string;
  mode: "hook" | "check" | "score";
  /** A flag value. It beats the settings file, which beats the default. */
  threshold?: number;
  maxCalls?: number;
  cut?: CutMode;
  /** Which judge to ask, and the OpenAI judge's model and effort. Flags beat the file. */
  judge?: JudgeKind;
  model?: string;
  effort?: Effort;
  rulesPath?: string;
  base?: string;
  /** score mode only: score this unified diff file instead of the working tree. */
  diffFile?: string;
  /** score mode only: put exactly what Jev saw for each piece in the output. */
  showContext?: boolean;
  sessionId?: string;
  stopHookActive?: boolean;
  /** Rounds the agent itself reports having already looped, when it tracks that. */
  loopCount?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  /** Verification hook so retry waits do not slow a scripted run down. */
  sleep?: (ms: number) => Promise<void>;
}

export type RunOutcome =
  | { kind: "cannot-run"; reason: string }
  | { kind: "clean"; report: CheckReport; text: string }
  | { kind: "violations"; report: CheckReport; text: string }
  | { kind: "handoff"; report: CheckReport; text: string }
  | { kind: "scored"; report: ScoreReport; text: string };

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

export interface CommandResult {
  ok: boolean;
  lines: string[];
}

/** `stop-rules baseline --reset`: forget the baseline so the next run starts from HEAD. */
export async function resetBaseline(repo: RepoPaths): Promise<CommandResult> {
  const stateDir = stateDirFor(repo.gitDir);
  await resetState(stateDir);
  return {
    ok: true,
    lines: [
      `cleared the saved baseline in ${stateDir}`,
      "The next check starts from HEAD and reports everything it finds.",
    ],
  };
}

/** The knobs, after the flags, the settings file and the defaults have had their say. */
interface Knobs {
  threshold: number;
  maxCalls: number;
  cut: CutMode;
}

export async function run(options: RunOptions): Promise<RunOutcome> {
  const started = Date.now();
  const env = options.env ?? process.env;
  const notes: string[] = [];
  const note = (message: string): void => {
    notes.push(message);
  };

  const repo = options.repo;

  const rulesPath = options.rulesPath
    ? path.resolve(options.cwd, options.rulesPath)
    : path.join(repo.root, ".stop-rules.md");
  const rulesLoad = await loadRules(rulesPath);
  if (!rulesLoad.ok) return cannotRun(rulesLoad.reason);

  // The one settings file. A flag beats it, and it beats the defaults.
  const settingsLoad = await loadSettings(repo.root);
  if (!settingsLoad.ok) return cannotRun(settingsLoad.reason);
  const settings = settingsLoad.loaded.settings;
  const chosen = chooseJudge(settings.judge, {
    ...(options.judge !== undefined ? { judge: options.judge } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
  });
  if (!chosen.ok) return cannotRun(chosen.reason);
  const knobs: Knobs = {
    threshold: options.threshold ?? settings.threshold ?? DEFAULT_THRESHOLD,
    maxCalls: options.maxCalls ?? settings.maxCalls ?? defaultMaxCalls(chosen.choice),
    cut: options.cut ?? settings.cut ?? DEFAULT_CUT,
  };

  // Team mode when this repo knows a stop-rules endpoint, the developer's own key if not.
  const credentials = await resolveCredentials(settingsLoad.loaded, env, chosen.choice);
  if (!credentials.ok) return cannotRun(credentials.reason);

  // Reads the environment, so a bad value is reported before any work.
  let slotDir: string;
  try {
    slotDir = slotsDir(env, chosen.choice.kind);
  } catch (error) {
    return cannotRun(error instanceof Error ? error.message : String(error));
  }

  const stateDir = stateDirFor(repo.gitDir);
  const release = await acquireLock(stateDir);
  if (release === null) {
    return cannotRun("another stop-rules run is still holding the lock after 60 seconds.");
  }
  try {
    return await runLocked({
      options,
      repo,
      rulesPath,
      rules: rulesLoad.rules,
      credentials: credentials.credentials,
      knobs,
      stateDir,
      slotDir,
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
  repo: { root: string; gitDir: string };
  rulesPath: string;
  rules: Rule[];
  credentials: Credentials;
  knobs: Knobs;
  stateDir: string;
  /** Where the machine wide slots of this run's judge live. */
  slotDir: string;
  notes: string[];
  note: (message: string) => void;
  started: number;
}

/** The diff to judge, and where it came from. */
interface Work {
  files: FileDiff[];
  skipped: SkippedFile[];
  failures: NotChecked[];
  /**
   * The new content of a changed file: what a piece is parsed from and what the code around
   * it is taken from. Null when there is no file content at all, which is `score --diff`.
   */
  readSource: ((file: string) => Promise<string | null>) | null;
  /** The snapshot tree the baseline moves to, or null when nothing was snapshotted. */
  snapshot: string | null;
  cut: CutMode;
  /** What was scored or checked, in plain words, for the score report. */
  source: string;
  /** What the change was compared with, for the check report's headline. */
  against: string;
}

type WorkResult = { ok: true; work: Work } | { ok: false; reason: string };

/** score --diff: a unified diff file. There is no file content, so nothing can be parsed. */
async function diffFileWork(args: LockedArgs, diffFile: string): Promise<WorkResult> {
  const full = path.resolve(args.options.cwd, diffFile);
  let text: string;
  try {
    text = await fs.readFile(full, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return { ok: false, reason: `could not read the diff file ${full}: ${err.code ?? err.message}` };
  }
  const parsed = parseDiff(text, []);
  if (parsed.files.length === 0 && parsed.failures.length === 0) {
    return { ok: false, reason: `${full} holds no diff with added lines.` };
  }
  // A diff file cannot be cut into functions: there is no file to parse. The other two modes
  // need no file, so a repo that asked for one of them still gets it, and the output says
  // which one was used either way.
  const asked = args.knobs.cut;
  const cut: CutMode = asked === "functions" ? "hunks" : asked;
  const why =
    asked === "functions"
      ? " (a diff file has no file content, so it cannot be cut into functions)"
      : "";
  return {
    ok: true,
    work: {
      files: parsed.files,
      skipped: parsed.skipped,
      failures: parsed.failures.map((failure) => ({ file: failure.file, reason: failure.reason })),
      readSource: null,
      snapshot: null,
      cut,
      // A diff file has no file content, so there is no code around a piece to send either.
      source: `${diffFile}, cut into ${cutWords(cut)}${why}, with ${judgeName(args.credentials.judge)} shown the diff alone (a diff file has no file content, so the code around a change cannot be read)`,
      against: diffFile,
    },
  };
}

/** The usual case: the working tree against the baseline, or against --base. */
async function workingTreeWork(args: LockedArgs, state: StopRulesState): Promise<WorkResult> {
  const { options, repo, rulesPath, stateDir, knobs } = args;
  // Taken under the lock, so a second firing checks the newest tree.
  const snapshot = await snapshotWorkingTree(repo, stateDir);

  let baseline: string;
  if (options.base !== undefined) {
    const resolved = await resolveTree(repo.root, options.base);
    if (resolved === null) return { ok: false, reason: `unknown revision ${options.base}.` };
    baseline = resolved;
  } else if (state.lastTree !== undefined) {
    // A baseline we recorded but git has since removed. Turning that into HEAD silently
    // would re-check work the user has already been told about, or skip work in between.
    if (!(await objectExists(repo.root, state.lastTree))) {
      return {
        ok: false,
        reason:
          "the saved baseline is gone (git cleaned it up). Run stop-rules baseline --reset to start again from HEAD.",
      };
    }
    baseline = state.lastTree;
  } else if (await hasHead(repo.root)) {
    // First run in this repository: HEAD is the defined starting point.
    const head = await resolveTree(repo.root, "HEAD");
    if (head === null) {
      return { ok: false, reason: "git could not resolve HEAD to a tree in this repository." };
    }
    baseline = head;
  } else {
    // First run in a repository with no commit yet: everything is new.
    baseline = await emptyTree(repo.root);
  }

  const rulesRelative = path.relative(repo.root, rulesPath).split(path.sep).join("/");
  // .stop-rules.md and .stop-rules.json are skipped by name inside parseDiff. The extra
  // name here is for a rules file the user pointed somewhere else with --rules.
  const parsed = parseDiff(await diffTrees(repo.root, baseline, snapshot), [rulesRelative]);
  const against =
    options.base === undefined ? "the last check" : `${options.base}`;
  return {
    ok: true,
    work: {
      files: parsed.files,
      skipped: parsed.skipped,
      failures: parsed.failures.map((failure) => ({ file: failure.file, reason: failure.reason })),
      readSource: (file) => readBlob(repo.root, snapshot, file),
      snapshot,
      cut: knobs.cut,
      source: `the working tree against ${against}, cut into ${cutWords(knobs.cut)}`,
      against,
    },
  };
}

async function runLocked(args: LockedArgs): Promise<RunOutcome> {
  const { options, rules, credentials, knobs, stateDir, notes, note, started } = args;
  const judge = credentials.judge;
  const name = judgeName(judge);

  let state: StopRulesState;
  let cache: Cache;
  try {
    state = await loadState(stateDir);
    cache = await loadCache(stateDir);
  } catch (error) {
    // A file of ours that is there but unreadable. Say so; never start over silently.
    return cannotRun(error instanceof Error ? error.message : String(error));
  }

  const prepared =
    options.diffFile === undefined
      ? await workingTreeWork(args, state)
      : await diffFileWork(args, options.diffFile);
  if (!prepared.ok) return cannotRun(prepared.reason);
  const work = prepared.work;

  // Cut each file into pieces: whole syntactic units, or diff hunks.
  let cut;
  try {
    cut = await cutFiles(work.files, { cut: work.cut, readSource: work.readSource });
  } catch (error) {
    // A broken install, or the "every added line lands in exactly one piece" check failing.
    return cannotRun(error instanceof Error ? error.message : String(error));
  }
  const pieces = cut.pieces;

  const alreadyReported = state.reported;
  const engineResult = await runEngine({
    pieces,
    rules,
    slot: () => acquireSlot(args.slotDir),
    threshold: knobs.threshold,
    maxCalls: knobs.maxCalls,
    judge,
    endpoint: credentials.endpoint,
    apiKey: credentials.bearer,
    fetchImpl: options.fetchImpl ?? ((url, init) => fetch(url, init)),
    cache: fileCache(cache),
    note,
    ...(options.showContext === true ? { showContext: true } : {}),
    ...(options.mode === "hook"
      ? {
          skipFinding: (ruleId: string, pieceText: string) =>
            alreadyReported[reportedKey(ruleId, pieceText)] !== undefined,
        }
      : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  // A rejected credential or an empty account is the user's problem, not the agent's, so it
  // can never exit 2. Returning here also leaves the baseline and the reported list alone,
  // so the same change is checked again once the human has fixed it.
  if (engineResult.blocked !== null) {
    await saveCache(stateDir, cache);
    if (engineResult.blocked === "billing") {
      return cannotRun(judge.kind === "jev" ? BILLING_EXHAUSTED : OPENAI_BILLING_EXHAUSTED);
    }
    if (engineResult.blocked === "busy") return cannotRun(machineBusy(name));
    if (engineResult.blocked === "model") {
      const said = engineResult.blockedMessage ?? `${name} cannot be used with this key`;
      return cannotRun(`${said.replace(/\.+$/, "")}.`);
    }
    if (credentials.mode === "team") return cannotRun(TOKEN_REJECTED);
    return cannotRun(`${judge.kind === "jev" ? AUTH_REJECTED : OPENAI_AUTH_REJECTED}.`);
  }

  if (pieces.length > 0 && engineResult.answered === 0 && engineResult.transportFailed) {
    await saveCache(stateDir, cache);
    const reasons = [...new Set(engineResult.notChecked.map((entry) => entry.reason))];
    return cannotRun(
      `could not reach ${name} for any piece of this diff${reasons.length === 0 ? "" : ` (${reasons.join("; ")})`}.`,
    );
  }

  const notChecked = [...work.failures, ...cut.notChecked, ...engineResult.notChecked];
  const stats: RunStats = {
    cut: work.cut,
    files: work.files.length,
    pieces: pieces.length,
    checked: engineResult.scores.length,
    skipped: work.skipped.length,
    calls: engineResult.calls,
    piecesPerCall: engineResult.piecesPerCall,
    cacheHits: engineResult.cacheHits,
    violations: engineResult.pieces.reduce((total, piece) => total + piece.rules.length, 0),
    places: engineResult.pieces.length,
    notChecked: notChecked.length,
    cutByHunk: cut.cutByHunk,
    contextLines: CONTEXT_LINES,
    widened: engineResult.widened,
    withFunction: engineResult.withFunction,
    tooBigToWiden: engineResult.tooBigToWiden,
    inputTokens: engineResult.usage.inputTokens,
    outputTokens: engineResult.usage.outputTokens,
    ...(engineResult.usage.cachedInputTokens !== undefined
      ? { cachedInputTokens: engineResult.usage.cachedInputTokens }
      : {}),
    ...(engineResult.usage.reasoningTokens !== undefined
      ? { reasoningTokens: engineResult.usage.reasoningTokens }
      : {}),
    durationMs: Date.now() - started,
  };

  let outcome: RunOutcome;
  if (options.mode === "score") {
    const report: ScoreReport = {
      judge: judgeInfo(judge),
      pieces: engineResult.scores,
      notChecked,
      skipped: work.skipped,
      stats,
      source: work.source,
    };
    outcome = { kind: "scored", report, text: renderScores(report) };
  } else {
    const report: CheckReport = {
      judge: judgeInfo(judge),
      pieces: engineResult.pieces,
      against: work.against,
      notChecked,
      skipped: work.skipped,
      stats,
    };
    outcome = decide(
      options,
      report,
      state,
      engineResult.findings,
      work.snapshot,
      engineResult.holdBaseline,
    );
    // A hook run that could not check anything leaves the baseline and the reported list
    // alone, so the next turn tries the same change again.
    if (options.mode === "hook" && outcome.kind !== "cannot-run") {
      await saveState(stateDir, state);
    }
  }

  await saveCache(stateDir, cache);
  await appendRunLog(stateDir, {
    at: new Date().toISOString(),
    mode: options.mode + (options.stopHookActive === true ? " (stop_hook_active)" : ""),
    judge: judgeInfo(judge),
    cut: stats.cut,
    files: stats.files,
    pieces: stats.pieces,
    checked: stats.checked,
    piecesPerCall: stats.piecesPerCall,
    cutByHunk: stats.cutByHunk.length,
    widened: stats.widened,
    withFunction: stats.withFunction,
    tooBigToWiden: stats.tooBigToWiden.length,
    skipped: stats.skipped,
    calls: stats.calls,
    cacheHits: stats.cacheHits,
    violations: stats.violations,
    notChecked: stats.notChecked,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    ...(stats.cachedInputTokens !== undefined ? { cachedInputTokens: stats.cachedInputTokens } : {}),
    ...(stats.reasoningTokens !== undefined ? { reasoningTokens: stats.reasoningTokens } : {}),
    durationMs: stats.durationMs,
    exitCode: outcome.kind === "violations" ? 2 : outcome.kind === "cannot-run" ? 1 : 0,
    notes,
  });
  return outcome;
}

/** Applies the hook's session policy and mutates state accordingly. */
function decide(
  options: RunOptions,
  report: CheckReport,
  state: StopRulesState,
  findings: readonly { ruleId: string; pieceText: string }[],
  snapshot: string | null,
  holdBaseline: boolean,
): RunOutcome {
  const text = renderReport(report);
  const hasViolations = report.pieces.length > 0;

  if (options.mode !== "hook") {
    // check is read only: it advances nothing and remembers nothing.
    return hasViolations ? { kind: "violations", report, text } : { kind: "clean", report, text };
  }
  if (snapshot === null) {
    throw new Error("internal error: hook mode ran without a working tree snapshot");
  }
  // A change nothing could be checked in is a could not run, not a clean turn. Staying
  // quiet here is what makes a missing grammar look like a passing check.
  if (coverage(report) === "none-checked") return cannotRun(noneCheckedReason(report));

  const sessionId = options.sessionId;
  if (sessionId === undefined) {
    throw new Error("internal error: hook mode ran without a session id");
  }
  const session = state.sessions[sessionId] ?? { violationRuns: 0, at: Date.now() };
  let handoff = false;

  if (hasViolations) {
    // Some agents count their own automatic follow-ups. Take whichever count is higher.
    const rounds = Math.max(session.violationRuns, options.loopCount ?? 0);
    if (rounds >= LOOP_GUARD_ROUNDS) handoff = true;
    else session.violationRuns = rounds + 1;
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
    const headline = `stop-rules: still ${report.stats.violations} violations after ${LOOP_GUARD_ROUNDS} rounds, leaving them for the user`;
    return { kind: "handoff", report, text: `${headline}\n\n${text}` };
  }

  for (const finding of findings) {
    state.reported[reportedKey(finding.ruleId, finding.pieceText)] = Date.now();
  }
  if (!holdBaseline) state.lastTree = snapshot;

  return hasViolations ? { kind: "violations", report, text } : { kind: "clean", report, text };
}
