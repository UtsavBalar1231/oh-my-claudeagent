import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The stamp runs on every evidence_log, so a repository that hashes slowly costs a bounded wait and no stamp.
const GIT_TIMEOUT_MS = 3000;
// Claude Code keeps subagent worktrees here, and a repository that tracks .claude/ would read one as a change.
const NOT_THE_PROJECT = ":(top,exclude).claude/worktrees";

async function git(cwd: string, args: readonly string[], env: Record<string, string> = {}): Promise<string | null> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? stdout.trim() : null;
}

async function stampWith(root: string, scratch: string): Promise<string | null> {
  const paths = await git(root, ["rev-parse", "--git-path", "index", "--git-path", "objects"]);
  if (paths === null) return null;
  const [index, objects] = paths.split(/\r?\n/);
  if (index === undefined || objects === undefined) return null;
  mkdirSync(join(scratch, "objects"));
  const realIndex = resolve(root, index);
  if (existsSync(realIndex)) copyFileSync(realIndex, join(scratch, "index"));
  const env = {
    GIT_INDEX_FILE: join(scratch, "index"),
    GIT_OBJECT_DIRECTORY: join(scratch, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: resolve(root, objects),
  };
  if ((await git(root, ["add", "-A", "--", ":/", NOT_THE_PROJECT], env)) === null) return null;
  return git(root, ["write-tree"], env);
}

/**
 * The tree hash of `root` as `git add -A` would record it, so uncommitted and untracked work counts
 * and ignored files do not. A scratch index and object directory leave the user's staging area and
 * object store untouched. Null outside a repository, or when git is missing, fails or runs out of
 * time, because evidence must log whether or not a stamp can be made.
 */
export async function workingTreeStamp(root: string): Promise<string | null> {
  try {
    const scratch = mkdtempSync(join(tmpdir(), "omca-stamp-"));
    try {
      return await stampWith(root, scratch);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  } catch {
    return null;
  }
}
