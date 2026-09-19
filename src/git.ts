import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/** Result of running git. Never throws on a non-zero exit; the caller decides. */
export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_BUFFER = 256 * 1024 * 1024;

export function runGit(
  cwd: string,
  args: readonly string[],
  extraEnv?: Record<string, string>,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args as string[],
      {
        cwd,
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const withCode = error as NodeJS.ErrnoException & { code?: number | string };
        if (typeof withCode.code === "number") {
          resolve({ code: withCode.code, stdout, stderr });
          return;
        }
        // Spawn failure (git missing, cwd gone). Surface it, never swallow it.
        reject(new Error(`could not run git ${args.join(" ")}: ${error.message}`));
      },
    );
  });
}

async function gitOrThrow(
  cwd: string,
  args: readonly string[],
  extraEnv?: Record<string, string>,
): Promise<string> {
  const result = await runGit(cwd, args, extraEnv);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export interface RepoPaths {
  /** Absolute path to the working tree root. */
  root: string;
  /** Absolute path to the git dir for this worktree. */
  gitDir: string;
}

/** Returns null when cwd is not inside a git repository. */
export async function findRepo(cwd: string): Promise<RepoPaths | null> {
  const root = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (root.code !== 0) return null;
  const gitDir = await runGit(cwd, ["rev-parse", "--absolute-git-dir"]);
  if (gitDir.code !== 0) return null;
  return { root: root.stdout.trim(), gitDir: gitDir.stdout.trim() };
}

export async function hasHead(root: string): Promise<boolean> {
  const result = await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return result.code === 0;
}

export async function objectExists(root: string, rev: string): Promise<boolean> {
  const result = await runGit(root, ["cat-file", "-e", `${rev}^{object}`]);
  return result.code === 0;
}

/** Resolves a user supplied revision to a tree id, or null when it does not exist. */
export async function resolveTree(root: string, rev: string): Promise<string | null> {
  const result = await runGit(root, ["rev-parse", "--verify", "--quiet", `${rev}^{tree}`]);
  if (result.code !== 0) return null;
  const tree = result.stdout.trim();
  return tree.length > 0 ? tree : null;
}

/** The empty tree object for this repository's hash algorithm, written so diff can use it. */
export async function emptyTree(root: string): Promise<string> {
  const out = await gitOrThrow(root, ["hash-object", "-w", "-t", "tree", "--stdin"]);
  return out.trim();
}

/**
 * Writes a tree object for the current working tree without touching the user's index.
 * Honours .gitignore and includes untracked files.
 */
export async function snapshotWorkingTree(repo: RepoPaths, stateDir: string): Promise<string> {
  await fs.mkdir(stateDir, { recursive: true });
  const indexPath = path.join(stateDir, `index-${process.pid}-${randomBytes(4).toString("hex")}`);
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    if (await hasHead(repo.root)) {
      await gitOrThrow(repo.root, ["read-tree", "HEAD"], env);
    }
    await gitOrThrow(repo.root, ["add", "-A", "--", "."], env);
    const tree = await gitOrThrow(repo.root, ["write-tree"], env);
    return tree.trim();
  } finally {
    await fs.rm(indexPath, { force: true });
    await fs.rm(`${indexPath}.lock`, { force: true });
  }
}

export async function diffTrees(root: string, base: string, head: string): Promise<string> {
  return gitOrThrow(root, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    "-U8",
    base,
    head,
  ]);
}
