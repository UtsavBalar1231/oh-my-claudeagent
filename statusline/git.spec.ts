import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitInfo, type GitInfo, type GitOptions, NO_REPO, parsePorcelainV2, readBranchFromHead, resolveGitDir } from "./git.ts";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "f",
  GIT_AUTHOR_EMAIL: "f@x",
  GIT_COMMITTER_NAME: "f",
  GIT_COMMITTER_EMAIL: "f@x",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

let root = "";
let cacheDir = "";
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omca-statusline-git-")));
  cacheDir = join(root, "cache");
  mkdirSync(cacheDir);
  savedEnv = Object.fromEntries(Object.keys(GIT_ENV).map((key) => [key, process.env[key]]));
  Object.assign(process.env, GIT_ENV);
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const options = (overrides: Partial<GitOptions> = {}): GitOptions => ({ cacheDir, ttlSeconds: 5, timeoutMs: 3000, ...overrides });

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { env: process.env });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

function repo(name: string, remote?: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  if (remote) git(dir, "remote", "add", "origin", remote);
  return dir;
}

const cacheFile = (): string => {
  const [file] = readdirSync(cacheDir);
  if (file === undefined) throw new Error("no cache file written");
  return join(cacheDir, file);
};

const cached = (overrides: Partial<GitInfo>): GitInfo => ({ ...NO_REPO, repo: true, branch: "cached", remoteFetchedAt: Date.now() / 1000, ...overrides });

function seedCache(dir: string, info: GitInfo, ageSeconds = 0): void {
  const probe = Bun.spawnSync([process.execPath, "-e", `process.stdout.write(new Bun.CryptoHasher("md5").update(${JSON.stringify(dir)}).digest("hex").slice(0, 8))`], {
    env: process.env,
  });
  const path = join(cacheDir, `omca-statusline-git-${probe.stdout.toString()}`);
  writeFileSync(path, JSON.stringify(info));
  const stamp = Date.now() / 1000 - ageSeconds;
  utimesSync(path, stamp, stamp);
}

describe("porcelain v2 status", () => {
  const entry = (xy: string) => `1 ${xy} N... 100644 100644 100644 a b file.txt`;

  test.each([
    ["a clean repository", "# branch.oid abc123\n# branch.head main\n", { staged: 0, modified: 0, untracked: 0 }],
    ["a repository with no commits", "# branch.oid (initial)\n# branch.head main\n", { staged: 0, modified: 0, untracked: 0 }],
    ["a detached head", "# branch.oid abc123\n# branch.head (detached)\n", { staged: 0, modified: 0, untracked: 0 }],
    ["a staged file", `# branch.head main\n${entry("M.")}\n`, { staged: 1, modified: 0, untracked: 0 }],
    ["a modified file", `# branch.head main\n${entry(".M")}\n`, { staged: 0, modified: 1, untracked: 0 }],
    ["an untracked file", "# branch.head main\n? untracked.txt\n", { staged: 0, modified: 0, untracked: 1 }],
    ["a file both staged and modified", `${entry("MM")}\n`, { staged: 1, modified: 1, untracked: 0 }],
    ["an unmerged entry", "u UU N... 100644 100644 100644 100644 a b c file.txt\n", { staged: 0, modified: 1, untracked: 0 }],
    ["a rename", "2 R. N... 100644 100644 100644 a b R100 new.txt\told.txt\n", { staged: 1, modified: 0, untracked: 0 }],
    ["mixed entries", `${entry("MM")}\n${entry(".M")}\n? new.txt\n`, { staged: 1, modified: 2, untracked: 1 }],
  ])("%s", (_, output, expected) => {
    expect(parsePorcelainV2(output)).toEqual(expected);
  });
});

describe("branch from HEAD", () => {
  let gitDir = "";

  beforeEach(() => {
    gitDir = join(root, "dotgit");
    mkdirSync(gitDir);
  });

  test.each([
    ["ref: refs/heads/main\n", "main"],
    ["ref: refs/heads/feature/my-feature\n", "feature/my-feature"],
    ["ref: refs/tags/v1.0\n", "refs/tags/v1.0"],
    ["abc1234def5678901234567890abcdef01234567\n", "(detached:abc1234)"],
  ])("%j reads %s", (head, expected) => {
    writeFileSync(join(gitDir, "HEAD"), head);
    expect(readBranchFromHead(gitDir)).toBe(expected);
  });

  test("a missing HEAD reads empty", () => {
    expect(readBranchFromHead(gitDir)).toBe("");
  });
});

describe("git directory", () => {
  test("a regular repository has a .git directory", () => {
    mkdirSync(join(root, ".git"));
    expect(resolveGitDir(root)).toBe(join(root, ".git"));
  });

  test("a directory without .git is not a repository", () => {
    expect(resolveGitDir(root)).toBeNull();
  });

  test("a worktree's .git file points at its git directory", () => {
    const worktree = join(root, "worktree");
    mkdirSync(worktree);
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(root, "main", ".git", "worktrees", "wt")}\n`);
    expect(resolveGitDir(worktree)).toBe(join(root, "main", ".git", "worktrees", "wt"));
  });

  test("a relative gitdir is resolved against the worktree", () => {
    const worktree = join(root, "worktree");
    mkdirSync(worktree);
    writeFileSync(join(worktree, ".git"), "gitdir: ../main/.git/worktrees/wt\n");
    expect(resolveGitDir(worktree)).toBe(join(root, "main", ".git", "worktrees", "wt"));
  });

  test("a .git file without a gitdir line is not a repository", () => {
    writeFileSync(join(root, ".git"), "not a gitdir line\n");
    expect(resolveGitDir(root)).toBeNull();
  });
});

describe("git info", () => {
  test("a clean repository reports its branch and remote", async () => {
    const dir = repo("clean", "git@github.com:acme/clean.git");
    expect(await getGitInfo(dir, options())).toEqual({
      repo: true,
      branch: "main",
      staged: 0,
      modified: 0,
      untracked: 0,
      remote: "git@github.com:acme/clean.git",
      remoteFetchedAt: expect.any(Number),
    });
  });

  test("changes are counted as staged, modified and untracked", async () => {
    const dir = repo("dirty");
    writeFileSync(join(dir, "a.txt"), "a\nchanged\n");
    writeFileSync(join(dir, "b.txt"), "new\n");
    git(dir, "add", "b.txt");
    for (const name of ["u1", "u2", "u3"]) writeFileSync(join(dir, name), "x\n");
    expect(await getGitInfo(dir, options())).toMatchObject({ branch: "main", staged: 1, modified: 1, untracked: 3, remote: "" });
  });

  test("a repository with no commits reads its unborn branch", async () => {
    const dir = join(root, "fresh");
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "new.txt"), "x\n");
    expect(await getGitInfo(dir, options())).toMatchObject({ branch: "main", untracked: 1 });
  });

  test("a detached head reads its short hash", async () => {
    const dir = repo("detached");
    git(dir, "checkout", "-q", "--detach", "HEAD");
    const head = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--short=7", "HEAD"], { env: process.env }).stdout.toString().trim();
    expect((await getGitInfo(dir, options())).branch).toBe(`(detached:${head})`);
  });

  test("a linked worktree reports its own branch", async () => {
    const dir = repo("main-repo");
    git(dir, "worktree", "add", "-q", "-b", "feature/wt", join(root, "wt"));
    expect(await getGitInfo(join(root, "wt"), options())).toMatchObject({ repo: true, branch: "feature/wt" });
  });

  test("a directory that is not a repository reads as none", async () => {
    expect(await getGitInfo(root, options())).toEqual(NO_REPO);
  });

  test.skipIf(process.platform === "win32")("a status that outlives the timeout leaves zero counts (skipped on Windows: the fsmonitor hook is a #!/bin/sh script)", async () => {
    const dir = repo("slow");
    const hook = join(root, "slow-hook.sh");
    writeFileSync(hook, "#!/bin/sh\nexec sleep 5\n", { mode: 0o755 });
    git(dir, "config", "core.fsmonitor", hook);
    writeFileSync(join(dir, "new.txt"), "x\n");
    expect(await getGitInfo(dir, options({ timeoutMs: 300 }))).toMatchObject({ branch: "main", staged: 0, modified: 0, untracked: 0 });
  });
});

describe("git cache", () => {
  test("a fresh cache is returned without asking git", async () => {
    const dir = join(root, "not-a-repo");
    mkdirSync(dir);
    const info = cached({ branch: "cached-branch" });
    seedCache(dir, info);
    expect(await getGitInfo(dir, options())).toEqual(info);
  });

  test("a stale cache is replaced by a fresh read, which is written back", async () => {
    const dir = repo("stale");
    seedCache(dir, cached({ branch: "stale-branch" }), 3600);
    expect((await getGitInfo(dir, options())).branch).toBe("main");
    expect(JSON.parse(readFileSync(cacheFile(), "utf8")).branch).toBe("main");
  });

  test("a zero lifetime always reads git", async () => {
    const dir = repo("always");
    seedCache(dir, cached({ branch: "cached-branch" }));
    expect((await getGitInfo(dir, options({ ttlSeconds: 0 }))).branch).toBe("main");
  });

  test("the remote of a stale cache is reused while it is under a minute old, keeping its timestamp", async () => {
    const dir = repo("remote-young", "git@github.com:acme/real.git");
    const info = cached({ remote: "git@github.com:acme/cached.git", remoteFetchedAt: Date.now() / 1000 - 30 });
    seedCache(dir, info, 3600);
    const result = await getGitInfo(dir, options());
    expect(result.remote).toBe("git@github.com:acme/cached.git");
    expect(result.remoteFetchedAt).toBe(info.remoteFetchedAt);
  });

  test("the remote of a stale cache is read again once it is a minute old", async () => {
    const dir = repo("remote-old", "git@github.com:acme/real.git");
    const before = Date.now() / 1000;
    seedCache(dir, cached({ remote: "git@github.com:acme/cached.git", remoteFetchedAt: before - 61 }), 3600);
    const result = await getGitInfo(dir, options());
    expect(result.remote).toBe("git@github.com:acme/real.git");
    expect(result.remoteFetchedAt).toBeGreaterThanOrEqual(before);
  });

  test("an unwritable cache directory does not fail the read", async () => {
    const dir = repo("nowrite");
    expect((await getGitInfo(dir, options({ cacheDir: join(root, "missing") }))).branch).toBe("main");
    expect(existsSync(join(root, "missing"))).toBe(false);
  });
});
