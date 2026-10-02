import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GitInfo } from "./git.ts";
import { NO_REPO } from "./git.ts";
import { type Payload, render } from "./render.ts";

process.env.TZ = "UTC";

const FIXTURES = join(import.meta.dir, "..", "tests", "fixtures", "statusline");
const MAIN = join(import.meta.dir, "main.ts");
const NOW = new Date("2026-10-02T12:00:00Z");

const GIT_ENV = {
  GIT_AUTHOR_NAME: "f",
  GIT_AUTHOR_EMAIL: "f@x",
  GIT_COMMITTER_NAME: "f",
  GIT_COMMITTER_EMAIL: "f@x",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

interface Fixture {
  env?: Record<string, string>;
  git?: Partial<GitInfo>;
  files?: Record<string, unknown>;
  repo?: string;
  payload: Payload;
}

let root = "";

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omca-statusline-fixture-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { env: { ...process.env, ...GIT_ENV } });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

function committedRepo(name: string, remote?: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\nb\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  if (remote) git(dir, "remote", "add", "origin", remote);
  return dir;
}

const REPOS: Record<string, () => void> = {
  clean: () => void committedRepo("clean", "git@github.com:acme/clean.git"),
  dirty: () => {
    const dir = committedRepo("dirty", "https://gitlab.com/acme/dirty.git");
    writeFileSync(join(dir, "a.txt"), "a\nb\nchanged\n");
    writeFileSync(join(dir, "b.txt"), "new\n");
    git(dir, "add", "b.txt");
    for (const name of ["u1", "u2", "u3"]) writeFileSync(join(dir, name), "x\n");
  },
  initial: () => {
    const dir = join(root, "initial");
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "new.txt"), "x\n");
  },
  detached: () => git(committedRepo("detached"), "checkout", "-q", "--detach", "HEAD"),
  worktree: () => git(committedRepo("clean", "git@github.com:acme/clean.git"), "worktree", "add", "-q", "-b", "feature/wt", join(root, "wt")),
};

function load(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8").replaceAll("@ROOT@", root));
}

function writeFiles(files: Record<string, unknown>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path.replaceAll("@ROOT@", root));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content));
  }
}

function runMain(payload: Payload, env: Record<string, string>): string {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["COLUMNS", "NERD_FONT", "CLAUDE_STATUSLINE_NERD_FONT"].includes(key)));
  const result = Bun.spawnSync([process.execPath, MAIN], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    env: { ...inherited, ...GIT_ENV, ...env, TMPDIR: root },
  });
  return result.stdout.toString();
}

for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort()) {
  const name = file.slice(0, -".json".length);
  test(`${name} renders the recorded bytes`, () => {
    const fixture = load(name);
    const expected = readFileSync(join(FIXTURES, `${name}.txt`), "utf8");
    if (fixture.repo) {
      REPOS[fixture.repo]?.();
      expect(runMain(fixture.payload, fixture.env ?? {})).toBe(expected);
      return;
    }
    writeFiles(fixture.files ?? {});
    expect(`${render(fixture.payload, { ...NO_REPO, ...fixture.git }, fixture.env ?? {}, NOW)}\n`).toBe(expected);
  });
}
