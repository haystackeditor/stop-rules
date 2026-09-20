/**
 * Which repository a command works on.
 *
 * One rule, the same for every command: the repository is `--dir <path>` when that flag is
 * given, and otherwise the repository that holds the current directory. Nothing else decides
 * it, so a command can never quietly work on a repository the user did not name.
 *
 * On top of that one guard. A vendored copy belongs to the repository it sits in, so when
 * the running file is `<repo>/.stop-rules/stop-rules.mjs` and the resolved repository is a
 * different one, the command stops and names both. Calling repo A's vendored copy from a
 * shell in repo B used to check repo B, and `baseline --reset` once wrote its state there.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { findRepo, type RepoPaths } from "./git.js";

/**
 * The tail of a vendored copy's path. `init.ts` holds the same two names as the repo
 * relative path it writes into agent configs, which is always spelled with forward slashes.
 */
const VENDORED_TAIL = path.join(".stop-rules", "stop-rules.mjs");

export type RepoResolution =
  | { ok: true; repo: RepoPaths }
  | { ok: false; kind: "no-repo" | "other-repo"; reason: string };

export interface RepoRequest {
  /** The `--dir` value, when the user gave one. */
  dir?: string;
  /** Where the command was run, or the directory the agent named in its hook payload. */
  cwd: string;
  /** The file running right now, so a vendored copy knows which repository it belongs to. */
  selfPath: string;
}

/** The repository a vendored copy belongs to, or null when the running file is not one. */
async function vendoredIn(selfPath: string): Promise<string | null> {
  if (!selfPath.endsWith(VENDORED_TAIL)) return null;
  const repo = await findRepo(path.dirname(selfPath));
  return repo === null ? null : repo.root;
}

export async function resolveRepo(request: RepoRequest): Promise<RepoResolution> {
  const from =
    request.dir === undefined ? request.cwd : path.resolve(request.cwd, request.dir);
  // git cannot even start in a directory that is not there, and its spawn failure is not a
  // sentence anyone should have to read. A path is checked before git sees it.
  try {
    const info = await fs.stat(from);
    if (!info.isDirectory()) return { ok: false, kind: "no-repo", reason: `${from} is not a directory.` };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return {
      ok: false,
      kind: "no-repo",
      reason:
        err.code === "ENOENT"
          ? `there is no directory at ${from}.`
          : `could not look at ${from}: ${err.code ?? err.message}`,
    };
  }
  const repo = await findRepo(from);
  if (repo === null) {
    return { ok: false, kind: "no-repo", reason: `${from} is not inside a git repository.` };
  }
  const home = await vendoredIn(request.selfPath);
  if (home !== null && home !== repo.root) {
    return {
      ok: false,
      kind: "other-repo",
      reason:
        `this is the copy of stop-rules vendored in ${home}, and it was about to work on ${repo.root}. ` +
        `Pass --dir ${home} to work on the repository this copy belongs to, or change to a folder inside the repository you mean.`,
    };
  }
  return { ok: true, repo };
}
