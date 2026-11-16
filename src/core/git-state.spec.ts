import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { specEnv } from "../../tests/fixtures/spec-env.ts";
import { classify } from "./destructive.ts";
import { GIT_ENV, type GitAnswer, gitQueries, gitVerdict } from "./git-state.ts";

const OFF = "Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing.";
const TRACKED = (count: string, operation: string, where = "") =>
  `Destructive git command blocked: it would discard uncommitted changes to tracked files: git status lists ${count}${where}, and ${operation} overwrites them. Commit or stash them first, or REPORT and STOP. ${OFF}`;
const UNTRACKED = (count: string) =>
  `Destructive git command blocked: it would delete untracked files: git clean --dry-run lists ${count}. Commit, move or ignore what should stay first, or REPORT and STOP. ${OFF}`;
const STASHED = (count: string, operation: string) =>
  `Destructive git command blocked: it would delete stashed changes: git stash list holds ${count}, and ${operation} deletes them. Apply or commit what should stay first, or REPORT and STOP. ${OFF}`;
const UNREADABLE = (operation: string, detail: string) =>
  `Destructive git command blocked: the guard could not read the repository state, so it cannot tell what ${operation} would discard: ${detail}. Run git status yourself, then REPORT and STOP. ${OFF}`;

let root: string;
// Git looks no higher than this, so a directory outside the fixtures is never part of a repository.
let env: Record<string, string>;

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
};

function repo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, "init", "--quiet", "--initial-branch", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  writeFileSync(join(dir, ".gitignore"), "*.log\n");
  git(dir, "add", ".");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "init");
  return dir;
}

const run = (argv: readonly string[], cwd: string): GitAnswer => {
  const result = Bun.spawnSync([...argv], { cwd, env: { ...env, ...GIT_ENV }, stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
};

/** What the guard decides for a git command run in `cwd`, as both adapters wire it. */
function decide(command: string, cwd: string): string | undefined {
  const finding = classify(command, { shell: "bash", cwd });
  if (finding?.kind === "catastrophic") return finding.reason;
  if (finding?.kind !== "git") return undefined;
  if (finding.reason !== undefined) return finding.reason;
  const queries = gitQueries(finding.checks);
  return gitVerdict(
    queries,
    queries.map((query) => (query.argv === undefined ? undefined : run(query.argv, cwd))),
  );
}

let clean: string;
let dirty: string;
let staged: string;
let untracked: string;
let stashed: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "omca-git-state-"));
  env = specEnv({ GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_GLOBAL: join(root, "no-config"), GIT_CONFIG_NOSYSTEM: "1", OMCA_DISABLED_HOOKS: undefined });
  clean = repo("clean");
  dirty = repo("dirty");
  writeFileSync(join(dirty, "a.txt"), "changed\n");
  staged = repo("staged");
  writeFileSync(join(staged, "a.txt"), "staged\n");
  git(staged, "add", "a.txt");
  untracked = repo("untracked");
  writeFileSync(join(untracked, "new.txt"), "new\n");
  writeFileSync(join(untracked, "build.log"), "log\n");
  stashed = repo("stashed");
  writeFileSync(join(stashed, "a.txt"), "wip\n");
  git(stashed, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "stash", "push", "--quiet");
  outside = join(root, "outside");
  mkdirSync(outside);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("a whole-tree git operation against a real repository", () => {
  test.each([
    ["git reset --hard", "git reset --hard"],
    ["git reset --hard HEAD~0", "git reset --hard"],
    ["git checkout .", "git checkout ."],
    ["git checkout -- .", "git checkout ."],
    ["git restore .", "git restore ."],
  ])("%s runs on a clean tree and is denied on a dirty one", (command, operation) => {
    expect(decide(command, clean)).toBeUndefined();
    expect(decide(command, untracked)).toBeUndefined();
    expect(decide(command, dirty)).toBe(TRACKED("1 changed file", operation));
    expect(decide(command, staged)).toBe(TRACKED("1 changed file", operation));
  });

  test("a named-path revert runs on a dirty tree", () => {
    expect(decide("git checkout -- a.txt", dirty)).toBeUndefined();
    expect(decide("git restore a.txt", dirty)).toBeUndefined();
    expect(decide("git restore --worktree a.txt", dirty)).toBeUndefined();
    expect(decide("git restore --staged .", staged)).toBeUndefined();
  });

  test("git clean is denied only when its dry run lists something", () => {
    expect(decide("git clean -fd", clean)).toBeUndefined();
    expect(decide("git clean -fd", dirty)).toBeUndefined();
    expect(decide("git clean -fd", untracked)).toBe(UNTRACKED("1 path"));
    expect(decide("git clean -fdx", untracked)).toBe(UNTRACKED("2 paths"));
    expect(decide("git clean -fd -- other", untracked)).toBeUndefined();
    expect(decide("git clean -n", untracked)).toBeUndefined();
    expect(existsSync(join(untracked, "new.txt"))).toBe(true);
  });

  test("git stash drop and clear are denied only while a stash entry exists", () => {
    expect(decide("git stash drop", clean)).toBeUndefined();
    expect(decide("git stash clear", clean)).toBeUndefined();
    expect(decide("git stash drop", stashed)).toBe(STASHED("1 entry", "git stash drop"));
    expect(decide("git stash clear", stashed)).toBe(STASHED("1 entry", "git stash clear"));
    expect(decide("git stash", dirty)).toBeUndefined();
    expect(decide("git stash pop", stashed)).toBeUndefined();
  });

  test("the repository is the one -C or a cd names, read from where the command runs", () => {
    expect(decide(`git -C ${dirty} reset --hard`, clean)).toBe(TRACKED("1 changed file", "git reset --hard", ` in ${dirty}`));
    expect(decide("git -C ../dirty reset --hard", clean)).toBe(TRACKED("1 changed file", "git reset --hard", " in ../dirty"));
    expect(decide(`cd ${dirty} && git reset --hard`, clean)).toBe(TRACKED("1 changed file", "git reset --hard", ` in ${dirty}`));
    expect(decide(`git -C ${clean} reset --hard`, dirty)).toBeUndefined();
  });

  test("outside a repository, or with a -C that does not exist, git fails on its own, so the command runs", () => {
    expect(decide("git reset --hard", outside)).toBeUndefined();
    expect(decide("git clean -fdx", outside)).toBeUndefined();
    expect(decide("git -C missing stash drop", clean)).toBeUndefined();
  });

  test("a directory the guard cannot resolve, or a query that cannot run, is denied", () => {
    expect(decide("git -C $UNSET reset --hard", dirty)).toBe(
      UNREADABLE("git reset --hard", "the directory it runs git in is only known when the command runs"),
    );
    const queries = gitQueries([{ operation: "git clean", query: "untracked", clean: [], at: [{ dir: "" }] }]);
    expect(gitVerdict(queries, [{ error: "spawn git ENOENT" }])).toBe(UNREADABLE("git clean", "spawn git ENOENT"));
    expect(gitVerdict(queries, [{ exitCode: 1, stdout: "", stderr: "error: index.lock exists\nmore" }])).toBe(
      UNREADABLE("git clean", "error: index.lock exists"),
    );
  });

  test("the queries keep a repository's fsmonitor hook from running", () => {
    const hooked = repo("hooked");
    writeFileSync(join(hooked, "a.txt"), "changed\n");
    const marker = join(root, "fsmonitor-ran");
    git(hooked, "config", "core.fsmonitor", `touch ${marker}; false`);
    expect(decide("git reset --hard", hooked)).toBe(TRACKED("1 changed file", "git reset --hard"));
    expect(decide("git clean -fd", hooked)).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });

  test("each query is the read-only form of the operation it checks", () => {
    const finding = classify("git -C /srv/repo --git-dir=/srv/repo/.git clean -ffdx -e keep -- build; git stash clear; git checkout .");
    expect(finding?.kind === "git" ? gitQueries(finding.checks).map((query) => query.argv) : finding).toEqual([
      ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", "/srv/repo", "--git-dir=/srv/repo/.git", "clean", "--dry-run", "-d", "-x", "-f", "-f", "--", "build"],
      ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "stash", "list"],
      ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=no"],
    ]);
  });
});
