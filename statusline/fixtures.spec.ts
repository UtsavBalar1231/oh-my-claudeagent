import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitInfo } from "./git.ts";
import { NO_REPO } from "./git.ts";
import { displayWidth } from "../src/core/ui-kit.ts";
import { specEnv, tmpEnv } from "../tests/fixtures/spec-env.ts";
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
  lastResortCut?: boolean;
  git?: Partial<GitInfo>;
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
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8").replaceAll("@ROOT@", JSON.stringify(root).slice(1, -1)));
}

function runMain(payload: Payload, env: Record<string, string>): string {
  const result = Bun.spawnSync([process.execPath, MAIN], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    env: specEnv({ COLUMNS: undefined, LINES: undefined, OMCA_GLYPHS: undefined, ...GIT_ENV, ...env, ...tmpEnv(root) }),
  });
  return result.stdout.toString();
}

// Claude Code keeps 3 cells free on each side, so no line may be wider than COLUMNS minus 6.
const INSET = 6;
const RST = "\x1b[0m";
const SEPARATOR = ` \x1b[90m·${RST} `;
const ESCAPES = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g;
const BAR_RUN = /(?:\x1b\[[0-9;]*m[━─\u{f0766}\u{f0a9e}-\u{f0aa5}]\x1b\[0m)+|\x1b\[90m─+\x1b\[0m/gu;

// White and bright white vanish on a light background; text that needs to stand out uses the default foreground.
const NEAR_WHITE = /\x1b\[(?:[0-9;]*;)?(?:37|97|38;5;(?:7|15|25[0-5]))(?:;[0-9;]*)?m/;

const outputLines = (output: string): string[] => output.split("\n").filter(Boolean);

const pieces = (output: string): string[] =>
  outputLines(output).flatMap((line) => line.slice(0, -RST.length).split(SEPARATOR).map((piece) => piece.replace(BAR_RUN, "━")));

// A bar draws to the room its line has (a ring where a short row needs one), so bars compare by
// shape; any other piece must equal the one the roomiest terminal of its layout draws (the compact
// layout ends at 59 columns, the full one has no upper end).
function cutPieces(output: string, wide: string): string[] {
  const whole = new Set(pieces(wide));
  return pieces(output).filter((piece) => !whole.has(piece));
}

test("the whole-segment check flags a segment cut mid-text", () => {
  const row = (...parts: string[]): string => `${parts.join(SEPARATOR)}${RST}\n`;
  const wide = row("alpha", "omega");
  expect(cutPieces(row("alpha", "omega"), wide)).toEqual([]);
  expect(cutPieces(row("alpha", "ome"), wide)).toEqual(["ome"]);
});

function produce(fixture: Fixture, env: Record<string, string>): string {
  if (fixture.repo) return runMain(fixture.payload, env);
  return `${render(fixture.payload, { ...NO_REPO, ...fixture.git }, env, NOW)}\n`;
}

for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort()) {
  const name = file.slice(0, -".json".length);
  test(`${name} renders the recorded bytes, within its terminal, with every segment whole`, () => {
    const fixture = load(name);
    const env = fixture.env ?? {};
    const expected = readFileSync(join(FIXTURES, `${name}.txt`), "utf8");
    if (fixture.repo) REPOS[fixture.repo]?.();
    const output = produce(fixture, env);
    expect(output).toBe(expected);
    expect(output).not.toMatch(NEAR_WHITE);

    const columns = Number(env["COLUMNS"] ?? 80);
    for (const line of outputLines(output)) expect(displayWidth(line.replace(ESCAPES, ""))).toBeLessThanOrEqual(Math.max(1, columns - INSET));

    if (fixture.lastResortCut) return;
    const roomiest = columns < 60 ? "59" : "1000";
    const wideEnv = Object.fromEntries(Object.entries({ ...env, COLUMNS: roomiest }).filter(([key]) => key !== "LINES"));
    expect(cutPieces(output, produce(fixture, wideEnv))).toEqual([]);
  });
}
