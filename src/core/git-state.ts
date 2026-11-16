/** A git command that discards work only when the repository holds some. */
export type DiscardOperation = "git reset --hard" | "git checkout ." | "git restore ." | "git clean" | "git stash drop" | "git stash clear";

/**
 * Where a git command runs: `dir` is the directory it runs git in, relative to the session's
 * working directory (`""` is that directory) or absolute, and undefined when the guard cannot
 * resolve it before the command runs. `gitDir` and `workTree` carry `--git-dir` and `--work-tree`.
 */
export type Repository = { dir: string | undefined; gitDir?: string; workTree?: string };

/**
 * A whole-tree git operation and what to read to tell whether it discards anything: `tracked` is
 * an uncommitted change to a tracked file, `untracked` a file `git clean` would delete (`clean`
 * holds its options for the dry run) and `stash` a stash entry. `at` lists every directory the
 * command can run git in.
 */
export type RepoCheck = { operation: DiscardOperation; query: "tracked" | "untracked" | "stash"; at: Repository[]; clean?: string[] };

export type GitQuery = { operation: DiscardOperation; query: RepoCheck["query"]; dir: string | undefined; argv: readonly string[] | undefined };

/** What running a query gave: git's exit and output, or the error that kept it from running. */
export type GitAnswer = { exitCode: number; stdout: string; stderr: string } | { error: string };

/** Git reads its messages in English under this environment, so a missing repository reads the same everywhere. */
export const GIT_ENV: Readonly<Record<string, string>> = { LC_ALL: "C" };

const GIT_HEAD = "Destructive git command blocked:";
const OFF_SWITCH = "Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing.";
export const GIT_TRACKED_HEAD = `${GIT_HEAD} it would discard uncommitted changes to tracked files`;
export const GIT_UNTRACKED_HEAD = `${GIT_HEAD} it would delete untracked files`;
export const GIT_STASH_HEAD = `${GIT_HEAD} it would delete stashed changes`;
export const GIT_UNREADABLE_HEAD = `${GIT_HEAD} the guard could not read the repository state`;

// `--no-optional-locks` keeps the status read from rewriting the index, and the fsmonitor
// override keeps a repository's configured hook from running before the user's permission check.
const READ_ONLY = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const QUERIES: Readonly<Record<RepoCheck["query"], (check: RepoCheck) => readonly string[]>> = {
  tracked: () => ["status", "--porcelain", "--untracked-files=no"],
  untracked: (check) => ["clean", "--dry-run", ...(check.clean ?? [])],
  stash: () => ["stash", "list"],
};

/** The git commands that read what each check needs, one per directory; a directory the guard cannot resolve has no command. */
export function gitQueries(checks: readonly RepoCheck[]): GitQuery[] {
  return checks.flatMap((check) =>
    check.at.map((repo) => ({
      operation: check.operation,
      query: check.query,
      dir: repo.dir,
      argv:
        repo.dir === undefined
          ? undefined
          : [
              "git",
              ...READ_ONLY,
              ...(repo.dir === "" ? [] : ["-C", repo.dir]),
              ...(repo.gitDir === undefined ? [] : [`--git-dir=${repo.gitDir}`]),
              ...(repo.workTree === undefined ? [] : [`--work-tree=${repo.workTree}`]),
              ...QUERIES[check.query](check),
            ],
    })),
  );
}

// Git fails on its own here, so the command it guards fails too and discards nothing.
const FAILS_ON_ITS_OWN = /not a git repository|cannot change to/i;

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
const where = (dir: string | undefined): string => (dir === undefined || dir === "" ? "" : ` in ${dir}`);

function unreadable(query: GitQuery, detail: string): string {
  return `${GIT_UNREADABLE_HEAD}, so it cannot tell what ${query.operation} would discard${where(query.dir)}: ${detail}. Run git status yourself, then REPORT and STOP. ${OFF_SWITCH}`;
}

function discards(query: GitQuery, count: number): string {
  switch (query.query) {
    case "tracked":
      return `${GIT_TRACKED_HEAD}: git status lists ${plural(count, "changed file", "changed files")}${where(query.dir)}, and ${query.operation} overwrites them. Commit or stash them first, or REPORT and STOP. ${OFF_SWITCH}`;
    case "untracked":
      return `${GIT_UNTRACKED_HEAD}: git clean --dry-run lists ${plural(count, "path", "paths")}${where(query.dir)}. Commit, move or ignore what should stay first, or REPORT and STOP. ${OFF_SWITCH}`;
    case "stash":
      return `${GIT_STASH_HEAD}: git stash list holds ${plural(count, "entry", "entries")}${where(query.dir)}, and ${query.operation} deletes them. Apply or commit what should stay first, or REPORT and STOP. ${OFF_SWITCH}`;
  }
}

/**
 * The deny reason for the first query whose answer says the command discards work, or that the
 * guard could not read. A repository git cannot open is no reason: the command fails there too.
 */
export function gitVerdict(queries: readonly GitQuery[], answers: readonly (GitAnswer | undefined)[]): string | undefined {
  for (const [i, query] of queries.entries()) {
    const answer = answers[i];
    if (query.argv === undefined || answer === undefined) {
      return unreadable(query, "the directory it runs git in is only known when the command runs");
    }
    if ("error" in answer) return unreadable(query, answer.error);
    if (answer.exitCode !== 0) {
      if (FAILS_ON_ITS_OWN.test(answer.stderr)) continue;
      return unreadable(query, answer.stderr.split("\n")[0]?.trim() || `git exited ${answer.exitCode}`);
    }
    const count = answer.stdout.split("\n").filter((line) => line.trim() !== "").length;
    if (count > 0) return discards(query, count);
  }
  return undefined;
}
