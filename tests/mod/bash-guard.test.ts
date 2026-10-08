import type { On, ProcessRunResult } from "claude-code";
import { expect, test, type Engine } from "claude-code/testing";
import { hostSpelling, type Layout, WINDOWS, world as sessionWorld } from "./world.ts";

const ENGINE = { decision: "ask", reason: "Bash(rm:*) asks", rule: "Bash(rm:*)" } as const;
const RM_CATASTROPHIC =
  "Destructive rm -rf blocked: the target is the filesystem root, home, the working directory, or a directory directly under root or home. Name a deeper path explicitly.";
const REFUSED = "The user refused this command in OMCA's review. Do not retry it; ask the user how to proceed.";
const GIT =
  "Destructive git command blocked. If the working tree is dirty, REPORT and STOP. Never modify history. Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing.";
const FORCE_PUSH =
  "Force push to the default branch blocked: it rewrites history everyone else has pulled. Push to another branch, or ask the user to push. Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing.";
const NO_VERIFY =
  "git commit --no-verify blocked: it skips the repository's commit hooks. Fix what the hook reports and commit without the flag. Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing.";
const branches = (branch: string, originHead?: string): Record<string, Partial<ProcessRunResult>> => ({
  "git symbolic-ref --quiet --short HEAD": { stdout: `${branch}\n` },
  "git symbolic-ref --quiet --short refs/remotes/origin/HEAD":
    originHead === undefined ? { exitCode: 1 } : { stdout: `origin/${originHead}\n` },
});

type Node = { kind: "file" | "dir" | "other"; entries?: number; isLink?: boolean };
type World = {
  env?: Record<string, string>;
  surfaces?: ("terminal" | "desktop")[];
  files?: Record<string, Node>;
  git?: Record<string, Partial<ProcessRunResult>>;
  answer?: string;
  failExists?: string;
  failSurfaces?: string;
  cwd?: string;
  layout?: Layout;
  contents?: Record<string, string>;
};
type Question = { question: string; header: string; options: { label: string }[] };

function world(on: On, w: World = {}) {
  const asked: { question: string; header: string; options: string[] }[] = [];
  const checked: unknown[] = [];
  const env: Record<string, string> = { HOME: "/home/u", OMCA_GLYPHS: "unicode", ...w.env };
  const files = w.files ?? {};
  // The engine resolves a relative path against the session's folder before the hook sees it.
  const nodeAt = (raw: string) => {
    const path = hostSpelling(raw, "linux");
    return Object.entries(files).find(([name]) => path === name || path.endsWith(`/${name}`))?.[1];
  };
  if (w.layout !== undefined) {
    sessionWorld(on, w.contents ?? {}, {}, w.env ?? {}, w.layout).surfaces = w.surfaces ?? ["terminal"];
  } else {
    on("session.surfaces", () => (w.failSurfaces === undefined ? { value: w.surfaces ?? ["terminal"] } : { deny: w.failSurfaces }));
    on("ui.log", () => ({ value: undefined }));
    on("env.get", (_$, e) => ({ value: env[e.name] }));
    on("session.root", () => ({ value: "/work" }));
    on("fs.exists", (_$, e) => {
      if (w.failExists !== undefined && hostSpelling(e.path, "linux").endsWith(`/${w.failExists}`)) {
        return { deny: `EACCES: permission denied, access '${w.failExists}'` };
      }
      return { value: nodeAt(e.path) !== undefined };
    });
    on("fs.stat", (_$, e) => {
      const node = nodeAt(e.path);
      if (node === undefined) throw new Error(`ENOENT: ${hostSpelling(e.path, "linux")}`);
      return { value: { kind: node.kind, size: 0, mtimeMs: 0, isLink: node.isLink ?? false } };
    });
    on("fs.list", (_$, e) => ({
      value: Array.from({ length: nodeAt(e.path)?.entries ?? 0 }, (_, i) => ({
        name: `e${i}`,
        kind: "file" as const,
        size: 0,
        mtimeMs: 0,
        isLink: false,
      })),
    }));
  }
  on("session.cwd", () => ({ value: w.cwd ?? w.layout?.root ?? "/work/sub" }));
  on("process.run", (_$, e) => {
    const result = w.git?.[e.argv.join(" ")];
    if (result === undefined) throw new Error(`unexpected process.run ${e.argv.join(" ")}`);
    return {
      value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false, ...result },
    };
  });
  on("tool.call", { tool: "AskUserQuestion" }, (_$, e) => {
    const [q] = (e as unknown as { questions: Question[] }).questions;
    if (q === undefined) throw new Error("no question");
    asked.push({ question: q.question, header: q.header, options: q.options.map((o) => o.label) });
    if (w.answer === "fail") throw new Error("the dialog failed");
    if (w.answer === "dismiss") return { deny: "The user doesn't want to proceed with this tool use." };
    return { result: { questions: [], answers: { [q.question]: w.answer ?? "Refuse" } } };
  });
  on("tool.check", (_$, e) => (checked.push(e), ENGINE));
  return { asked, checked };
}

const check = ($: Engine, command: string, tool = "Bash") => $.tool.check({ tool, input: { command } });
const powershell = ($: Engine, command: string) => check($, command, "PowerShell");

const BUILD_WORLD: World = {
  files: {
    build: { kind: "dir", entries: 4 },
    "notes.txt": { kind: "file" },
    "/home/u/.cache/omca": { kind: "dir", isLink: true },
  },
};
const BUILD_COMMAND = "rm -rf build notes.txt ghost ~/.cache/omca *.o";
const BUILD_QUESTION = [
  "OMCA held this command for your review:",
  "  rm -rf build notes.txt ghost ~/.cache/omca *.o",
  "It would remove:",
  "  build          dir, 4 entries",
  "  notes.txt      file",
  "  ghost          not found",
  "  ~/.cache/omca  link",
  "  *.o            not expanded",
  "Run it?",
].join("\n");
const LONG_PATH = `src/${"deep/".repeat(14)}leaf.txt`;

test("rm -rf ~ is denied with no dialog", async ($, on) => {
  const { asked, checked } = world(on);

  expect(await check($, "rm -rf ~")).toEqual({ decision: "deny", reason: RM_CATASTROPHIC });
  expect(asked).toEqual([]);
  expect(checked).toEqual([]);
});

test("a catastrophic removal is denied with no dialog, even with OMCA_DISABLED_HOOKS set to all", async ($, on) => {
  const { asked, checked } = world(on, { env: { OMCA_DISABLED_HOOKS: "all" } });

  expect(await check($, "cd /x && sudo rm -rf /usr")).toEqual({ decision: "deny", reason: RM_CATASTROPHIC });
  expect(asked).toEqual([]);
  expect(checked).toEqual([]);
});

test("a reviewable removal asks with every target's kind and entry count, Refuse first", async ($, on) => {
  const { asked, checked } = world(on, BUILD_WORLD);

  expect(await check($, BUILD_COMMAND)).toEqual({ decision: "deny", reason: REFUSED });
  expect(asked).toEqual([{ question: BUILD_QUESTION, header: "OMCA guard", options: ["Refuse", "Run it"] }]);
  expect(checked).toEqual([]);
});

test("Run it passes the call to the engine and returns its decision unchanged", async ($, on) => {
  const { asked, checked } = world(on, { ...BUILD_WORLD, answer: "Run it" });

  expect(await check($, BUILD_COMMAND)).toEqual(ENGINE);
  expect(asked.map((a) => a.question)).toEqual([BUILD_QUESTION]);
  expect(checked).toEqual([{ tool: "Bash", input: { command: BUILD_COMMAND } }]);
});

test("a Run it is never reused: the same command asks again on its next call", async ($, on) => {
  const { asked, checked } = world(on, { ...BUILD_WORLD, answer: "Run it" });

  await check($, BUILD_COMMAND);
  await check($, BUILD_COMMAND);

  expect(asked).toHaveLength(2);
  expect(checked).toHaveLength(2);
});

test("a dismissed dialog denies", async ($, on) => {
  const { asked, checked } = world(on, { ...BUILD_WORLD, answer: "dismiss" });

  expect(await check($, BUILD_COMMAND)).toEqual({ decision: "deny", reason: REFUSED });
  expect(asked).toHaveLength(1);
  expect(checked).toEqual([]);
});

test("a dialog that fails denies", async ($, on) => {
  const { asked, checked } = world(on, { ...BUILD_WORLD, answer: "fail" });

  expect(await check($, BUILD_COMMAND)).toEqual({ decision: "deny", reason: REFUSED });
  expect(asked).toHaveLength(1);
  expect(checked).toEqual([]);
});

test("an answer typed under Other denies", async ($, on) => {
  const { checked } = world(on, { ...BUILD_WORLD, answer: "run it please" });

  expect(await check($, BUILD_COMMAND)).toEqual({ decision: "deny", reason: REFUSED });
  expect(checked).toEqual([]);
});

test("with no surface to draw on, nothing asks: a blocking match denies and an advisory one runs", async ($, on) => {
  const { asked, checked } = world(on, { ...BUILD_WORLD, surfaces: [], git: branches("dev") });

  expect(await check($, "rm -rf build")).toEqual(ENGINE);
  expect(await check($, "git push --force origin dev")).toEqual(ENGINE);
  expect(await check($, "git reset --hard")).toEqual({ decision: "deny", reason: GIT });
  expect(await check($, "rm -rf build; git stash")).toEqual({ decision: "deny", reason: GIT });
  expect(await check($, "git push --force origin main")).toEqual({ decision: "deny", reason: FORCE_PUSH });
  expect(await check($, "git commit --no-verify -m x")).toEqual({ decision: "deny", reason: NO_VERIFY });
  expect(asked).toEqual([]);
  expect(checked).toEqual([
    { tool: "Bash", input: { command: "rm -rf build" } },
    { tool: "Bash", input: { command: "git push --force origin dev" } },
  ]);
});

test("guardMode deny decides without asking: blocking and catastrophic matches deny, advisory ones run", { options: { guardMode: "deny" } }, async ($, on) => {
  const { asked, checked } = world(on, { ...BUILD_WORLD, git: branches("dev") });

  expect(await check($, "rm -rf build")).toEqual(ENGINE);
  expect(await check($, "git push --force origin dev")).toEqual(ENGINE);
  expect(await check($, "rm -rf build; git stash")).toEqual({ decision: "deny", reason: GIT });
  expect(await check($, "rm -rf ~")).toEqual({ decision: "deny", reason: RM_CATASTROPHIC });
  expect(await check($, "git push --force origin main")).toEqual({ decision: "deny", reason: FORCE_PUSH });
  expect(await check($, "git commit -n -m x")).toEqual({ decision: "deny", reason: NO_VERIFY });
  expect(asked).toEqual([]);
  expect(checked).toHaveLength(2);
});

test("a gatherer that throws still asks, with a one-line reason in place of the targets", async ($, on) => {
  const { asked } = world(on, { ...BUILD_WORLD, failExists: "notes.txt" });

  expect(await check($, "rm -rf build notes.txt")).toEqual({ decision: "deny", reason: REFUSED });
  expect(asked.map((a) => a.question)).toEqual([
    [
      "OMCA held this command for your review:",
      "  rm -rf build notes.txt",
      "! Could not check what it would touch: EACCES: permission denied, access 'not…",
      "Run it?",
    ].join("\n"),
  ]);
});

test("a hard reset shows its tracked change count and the diff stat", async ($, on) => {
  const { asked } = world(on, {
    git: {
      "git status --porcelain": { stdout: " M src/a.ts\nM  src/b.ts\n?? scratch.txt\n" },
      "git diff --stat=76 HEAD": {
        stdout: " src/a.ts | 4 ++--\n src/b.ts | 1 +\n 2 files changed, 3 insertions(+), 2 deletions(-)\n",
      },
    },
  });

  expect(await check($, "git reset --hard")).toEqual({ decision: "deny", reason: GIT });
  expect(asked.map((a) => a.question)).toEqual([
    [
      "OMCA held this command for your review:",
      "  git reset --hard",
      "git reset --hard discards 2 uncommitted changes:",
      "   src/a.ts | 4 ++--",
      "   src/b.ts | 1 +",
      "   2 files changed, 3 insertions(+), 2 deletions(-)",
      "Run it?",
    ].join("\n"),
  ]);
});

test("a guard that fails while it decides denies the command and names why", async ($, on) => {
  const { asked, checked } = world(on, { ...BUILD_WORLD, failSurfaces: "x" });

  expect(await check($, "rm -rf build")).toEqual({ decision: "deny", reason: "OMCA's Bash guard failed, so the command was refused: x" });
  expect(asked).toEqual([]);
  expect(checked).toEqual([]);
});

test("a multi-line command shows its first four rows and counts the characters left", async ($, on) => {
  const { asked } = world(on, BUILD_WORLD);

  await check($, "rm -rf build\necho a\necho b\necho c\necho d\necho e");
  expect(asked.map((a) => a.question)).toEqual([
    [
      "OMCA held this command for your review:",
      "  rm -rf build",
      "  echo a",
      "  echo b",
      "  echo c",
      "  … 13 more characters",
      "It would remove:",
      "  build  dir, 4 entries",
      "Run it?",
    ].join("\n"),
  ]);
});

test("a long command wraps at spaces onto continuation rows and keeps every path", async ($, on) => {
  const first = `packages/feature-module-with-a-really-long-descriptive-name-01/dist`;
  const second = `packages/feature-module-with-a-really-long-descriptive-name-02/dist`;
  const { asked } = world(on, { files: { [first]: { kind: "dir", entries: 1 }, [second]: { kind: "dir", entries: 1 } } });

  await check($, `rm -rf ${first} ${second} && echo removed-the-two-build-outputs-and-now-rebuilding`);
  expect(asked.map((a) => a.question.split("\n").slice(0, 5))).toEqual([
    [
      "OMCA held this command for your review:",
      `  rm -rf ${first}`,
      `  ${second} && echo`,
      "  removed-the-two-build-outputs-and-now-rebuilding",
      "It would remove:",
    ],
  ]);
});

test("a word longer than the row breaks mid-word, and a command past four rows counts what is left", async ($, on) => {
  const { asked } = world(on, BUILD_WORLD);

  await check($, `rm -rf build ${"x".repeat(300)}`);
  expect(asked[0]?.question.split("\n").slice(0, 7)).toEqual([
    "OMCA held this command for your review:",
    "  rm -rf build",
    `  ${"x".repeat(76)}`,
    `  ${"x".repeat(76)}`,
    `  ${"x".repeat(76)}`,
    "  … 72 more characters",
    "It would remove:",
  ]);
});

test("a hard reset shows the first 6 files of its diff stat with a count of the rest, then the summary", async ($, on) => {
  const files = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
  const { asked } = world(on, {
    git: {
      "git status --porcelain": { stdout: `${files.map((file) => ` M ${file}`).join("\n")}\n` },
      "git diff --stat=76 HEAD": { stdout: `${files.map((file) => ` ${file} | 1 +`).join("\n")}\n 25 files changed, 25 insertions(+)\n` },
    },
  });

  await check($, "git reset --hard");
  expect(asked.map((a) => a.question)).toEqual([
    [
      "OMCA held this command for your review:",
      "  git reset --hard",
      "git reset --hard discards 25 uncommitted changes:",
      ...files.slice(0, 6).map((file) => `   ${file} | 1 +`),
      "  and 19 more files",
      "   25 files changed, 25 insertions(+)",
      "Run it?",
    ].join("\n"),
  ]);
});

test("a force push that names a remote and no branch reads the checked-out branch for its ref", async ($, on) => {
  const { asked } = world(on, {
    git: { ...branches("dev"), "git rev-parse --abbrev-ref HEAD": { stdout: "feature\n" }, "git log --oneline origin/feature --not HEAD": { stdout: "c000001 lost\n" } },
  });

  await check($, "git push --force origin");
  expect(asked.map((a) => a.question)).toEqual([
    [
      "OMCA held this command for your review:",
      "  git push --force origin",
      "git push --force drops 1 commit from origin/feature:",
      "  c000001 lost",
      "Run it?",
    ].join("\n"),
  ]);
});

test("a command that removes and resets shows both sections", async ($, on) => {
  const { asked } = world(on, {
    ...BUILD_WORLD,
    git: { "git status --porcelain": { stdout: "" } },
  });

  await check($, "rm -rf build && git reset --hard");
  expect(asked.map((a) => a.question)).toEqual([
    [
      "OMCA held this command for your review:",
      "  rm -rf build && git reset --hard",
      "It would remove:",
      "  build  dir, 4 entries",
      "git reset --hard: no uncommitted changes to tracked files.",
      "Run it?",
    ].join("\n"),
  ]);
});

test("a removal and a hard reset share the rows left, each keeping its heading and at least one entry", async ($, on) => {
  const targets = FILES(10);
  const files = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`);
  const { asked } = world(on, {
    files: filesOf(targets),
    git: {
      "git status --porcelain": { stdout: `${files.map((file) => ` M ${file}`).join("\n")}\n` },
      "git diff --stat=76 HEAD": { stdout: `${files.map((file) => ` ${file} | 1 +`).join("\n")}\n 30 files changed, 30 insertions(+)\n` },
    },
  });

  await check($, `rm -rf ${targets.join(" ")} && git reset --hard`);

  const lines = asked[0]?.question.split("\n") ?? [];
  expect(lines.slice(2)).toEqual([
    "It would remove:",
    "  a  file",
    "  and 9 more",
    "git reset --hard discards 30 uncommitted changes:",
    "   src/f0.ts | 1 +",
    "   src/f1.ts | 1 +",
    "   src/f2.ts | 1 +",
    "  and 27 more files",
    "   30 files changed, 30 insertions(+)",
    "Run it?",
  ]);
  expect(lines).toHaveLength(12);
});

test("a hard reset outside a repository asks with git's first error line", async ($, on) => {
  const { asked } = world(on, {
    git: { "git status --porcelain": { exitCode: 128, stderr: "fatal: not a git repository: .git\nmore\n" } },
  });

  await check($, "git reset --hard");

  expect(asked.map((a) => a.question)).toEqual([
    [
      "OMCA held this command for your review:",
      "  git reset --hard",
      "! Could not check what it would touch: fatal: not a git repository: .git",
      "Run it?",
    ].join("\n"),
  ]);
});

test("a force push lists the first 7 commits it drops with a count of the rest", async ($, on) => {
  const commits = Array.from({ length: 22 }, (_, i) => `c${String(i).padStart(6, "0")} commit ${i}`);
  const { asked } = world(on, {
    git: { ...branches("dev"), "git log --oneline origin/dev --not HEAD": { stdout: `${commits.join("\n")}\n` } },
  });

  expect(await check($, "git push --force origin dev")).toEqual({ decision: "deny", reason: REFUSED });
  expect(asked.map((a) => a.question)).toEqual([
    [
      "OMCA held this command for your review:",
      "  git push --force origin dev",
      "git push --force drops 22 commits from origin/dev:",
      ...commits.slice(0, 7).map((line) => `  ${line}`),
      "  and 15 more commits",
      "Run it?",
    ].join("\n"),
  ]);
});

test("a force push to the default branch asks the same way, and a refusal names the force push", async ($, on) => {
  const { asked } = world(on, {
    git: { ...branches("dev"), "git log --oneline origin/main --not HEAD": { stdout: "c000001 lost\n" } },
  });

  expect(await check($, "git push --force origin main")).toEqual({ decision: "deny", reason: FORCE_PUSH });
  expect(asked.map((a) => a.question)).toEqual([
    [
      "OMCA held this command for your review:",
      "  git push --force origin main",
      "git push --force drops 1 commit from origin/main:",
      "  c000001 lost",
      "Run it?",
    ].join("\n"),
  ]);
});

test("a push that names no branch is judged by the checked-out one, read from local refs", async ($, on) => {
  world(on, { surfaces: [], git: branches("main") });
  expect(await check($, "git push -f")).toEqual({ decision: "deny", reason: FORCE_PUSH });
  expect(await check($, "git push --force origin")).toEqual({ decision: "deny", reason: FORCE_PUSH });
  expect(await check($, "git push -f origin HEAD")).toEqual({ decision: "deny", reason: FORCE_PUSH });
});

test("origin/HEAD names the default branch, and a push to main is then an ordinary force push", async ($, on) => {
  const { checked } = world(on, { surfaces: [], git: branches("develop", "develop") });
  expect(await check($, "git push -f")).toEqual({ decision: "deny", reason: FORCE_PUSH });
  expect(await check($, "git push -f origin develop")).toEqual({ decision: "deny", reason: FORCE_PUSH });
  expect(await check($, "git push -f origin main")).toEqual(ENGINE);
  expect(checked).toEqual([{ tool: "Bash", input: { command: "git push -f origin main" } }]);
});

test("when git cannot read the branches, main and master are the default by name", async ($, on) => {
  world(on, {
    surfaces: [],
    git: {
      "git symbolic-ref --quiet --short HEAD": { exitCode: 128, stderr: "fatal: not a git repository\n" },
      "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": { exitCode: 128, stderr: "fatal: not a git repository\n" },
    },
  });
  expect(await check($, "git push -f origin master")).toEqual({ decision: "deny", reason: FORCE_PUSH });
  expect(await check($, "git push -f")).toEqual(ENGINE);
});

test("a commit that skips its hooks asks with its effect, and a refusal names the skipped hooks", async ($, on) => {
  const { asked } = world(on);

  expect(await check($, "git commit --no-verify -m wip")).toEqual({ decision: "deny", reason: NO_VERIFY });
  expect(asked.map((a) => a.question)).toEqual([
    [
      "OMCA held this command for your review:",
      "  git commit --no-verify -m wip",
      "git commit --no-verify skips the repository's pre-commit and commit-msg hooks.",
      "Run it?",
    ].join("\n"),
  ]);
});

test("a removal handed to a shell, eval or a heredoc, or behind timeout, is judged as the command it runs", async ($, on) => {
  const { asked, checked } = world(on, { surfaces: [] });
  const denied = { decision: "deny", reason: RM_CATASTROPHIC };

  expect(await check($, "bash -c 'rm -rf ~'")).toEqual(denied);
  expect(await check($, `sh -c 'rm -rf "$HOME"'`)).toEqual(denied);
  expect(await check($, "sudo bash -lc 'rm -rf /'")).toEqual(denied);
  expect(await check($, 'eval "rm -rf /"')).toEqual(denied);
  expect(await check($, "bash <<EOF\nrm -rf /\nEOF")).toEqual(denied);
  expect(await check($, "timeout 5 rm -rf ~")).toEqual(denied);
  expect(await powershell($, "pwsh -Command \"Remove-Item -Recurse $HOME\"")).toEqual(denied);
  expect(await powershell($, 'cmd /c "cd x && rd /s /q C:\\"')).toEqual(denied);
  expect(await check($, 'env bash -c "git reset --hard"')).toEqual({ decision: "deny", reason: GIT });
  expect(await check($, "xargs rm -rf")).toEqual(ENGINE);
  expect(await check($, "echo \"bash -c 'rm -rf ~'\"")).toEqual(ENGINE);
  expect(asked).toEqual([]);
  expect(checked).toHaveLength(2);
});

test("a force push with no remote named compares against the push target", async ($, on) => {
  const { asked } = world(on, { git: { "git log --oneline @{push} --not HEAD": { stdout: "" } } });

  await check($, "git push -f");

  expect(asked.map((a) => a.question)).toEqual([
    [
      "OMCA held this command for your review:",
      "  git push -f",
      "git push --force: @{push} has no commits missing from HEAD.",
      "Run it?",
    ].join("\n"),
  ]);
});

test("a git operation with nothing to gather names its effect", async ($, on) => {
  const { asked } = world(on);

  await check($, "git clean -fdx");

  expect(asked.map((a) => a.question)).toEqual([
    ["OMCA held this command for your review:", "  git clean -fdx", "git clean deletes untracked files.", "Run it?"].join(
      "\n",
    ),
  ]);
});

const FILES = (count: number) => Array.from({ length: count }, (_, i) => String.fromCharCode(97 + i));
const filesOf = (names: string[]) => Object.fromEntries(names.map((t) => [t, { kind: "file" as const }]));

test("more than 8 targets list the first 7 and count the rest, so the dialog fits 24 rows", async ($, on) => {
  const targets = FILES(23);
  const { asked } = world(on, { files: filesOf(targets) });

  await check($, `rm -rf ${targets.join(" ")}`);

  const lines = asked[0]?.question.split("\n") ?? [];
  expect(lines.slice(3, 5)).toEqual(["  a  file", "  b  file"]);
  expect(lines.slice(9)).toEqual(["  g  file", "  and 16 more", "Run it?"]);
  expect(lines).toHaveLength(12);
});

test("exactly 8 targets are all listed", async ($, on) => {
  const targets = FILES(8);
  const { asked } = world(on, { files: filesOf(targets) });

  await check($, `rm -rf ${targets.join(" ")}`);

  const lines = asked[0]?.question.split("\n") ?? [];
  expect(lines.slice(10)).toEqual(["  h  file", "Run it?"]);
  expect(lines).toHaveLength(12);
});

test("a command that wraps onto more rows leaves fewer rows for the targets", async ($, on) => {
  const targets = FILES(12);
  const { asked } = world(on, { files: filesOf(targets) });

  await check($, `rm -rf ${targets.join(" ")} && echo ${"x".repeat(150)}`);

  const lines = asked[0]?.question.split("\n") ?? [];
  expect(lines.slice(-4)).toEqual(["  d  file", "  e  file", "  and 7 more", "Run it?"]);
  expect(lines).toHaveLength(12);
});

test("a long path is middle-truncated to the dialog width, with an ASCII ellipsis under OMCA_GLYPHS=ascii", async ($, on) => {
  const { asked } = world(on, { env: { OMCA_GLYPHS: "ascii" }, files: { [LONG_PATH]: { kind: "file" } } });

  await check($, `rm -r ${LONG_PATH}`);

  expect(asked[0]?.question.split("\n").slice(1, 6)).toEqual([
    "  rm -r",
    "  src/deep/deep/deep/deep/deep/deep/deep/deep/deep/deep/deep/deep/deep/deep/le",
    "  af.txt",
    "It would remove:",
    "  src/deep/deep/deep/deep/deep/deep/...deep/deep/deep/deep/deep/leaf.txt  file",
  ]);
});

test("a long path uses the Unicode ellipsis by default", async ($, on) => {
  const { asked } = world(on, { files: { [LONG_PATH]: { kind: "file" } } });

  await check($, `rm -r ${LONG_PATH}`);

  expect(asked[0]?.question.split("\n").slice(4, 6)).toEqual([
    "It would remove:",
    "  src/deep/deep/deep/deep/deep/deep/d…/deep/deep/deep/deep/deep/leaf.txt  file",
  ]);
});

test("a quoted mention of a destructive command passes through untouched", async ($, on) => {
  const { asked, checked } = world(on);

  expect(await check($, 'echo "rm -rf /"')).toEqual(ENGINE);
  expect(await check($, 'git commit -m "drop git reset --hard"')).toEqual(ENGINE);
  expect(asked).toEqual([]);
  expect(checked).toHaveLength(2);
});

for (const command of ["jq . file.json", "npm run build", "uv run pytest", "git status", "git log", "git config --local core.hooksPath /tmp/evil", "git fetch"]) {
  test(`an unmatched command gets the engine's verdict unchanged: ${command}`, async ($, on) => {
    const { asked, checked } = world(on);
    expect(await check($, command)).toEqual(ENGINE);
    expect(asked).toEqual([]);
    expect(checked).toHaveLength(1);
  });
}

test("a force push the user lets run gets the engine's verdict unchanged", async ($, on) => {
  world(on, { answer: "Run it", git: { "git log --oneline @{push} --not HEAD": { stdout: "" } } });
  expect(await check($, "git push --force")).toEqual(ENGINE);
});

test("bash-guard in OMCA_DISABLED_HOOKS turns off every match but the catastrophic one, with no dialog", async ($, on) => {
  const { asked } = world(on, { env: { OMCA_DISABLED_HOOKS: "verification-recorder,bash-guard" } });

  expect(await check($, "git reset --hard")).toEqual(ENGINE);
  expect(await check($, "rm -rf build; git push -f")).toEqual(ENGINE);
  expect(await check($, "rm -rf /")).toEqual({ decision: "deny", reason: RM_CATASTROPHIC });
  expect(asked).toEqual([]);
});

test("OMCA_DISABLED_HOOKS listing a different hook still denies reset --hard", async ($, on) => {
  world(on, { surfaces: [], env: { OMCA_DISABLED_HOOKS: "other-hook" } });

  expect(await check($, "git reset --hard")).toEqual({ decision: "deny", reason: GIT });
});

const silentWithoutDialog = async ($: Engine, on: On, command: string) => {
  const { asked, checked } = world(on, { surfaces: [] });
  expect(await check($, command)).toEqual(ENGINE);
  expect(asked).toEqual([]);
  expect(checked).toEqual([{ tool: "Bash", input: { command } }]);
};

test("rm -rf of a nested temp path is silent", ($, on) =>
  silentWithoutDialog($, on, "rm -rf /tmp/omca-canary"));

test("a loop cleaning a pid-suffixed scratch dir is silent", ($, on) =>
  silentWithoutDialog(
    $,
    on,
    'for d in a b; do mkdir -p /tmp/x$$; dpkg-deb -x $d/p.deb /tmp/x$$; md5sum $(find /tmp/x$$ -name "*.so"); rm -rf /tmp/x$$; done',
  ));

test("rm -rf of a relative build dir is silent", ($, on) =>
  silentWithoutDialog($, on, "cd /x && rm -rf build dist/out"));

test("rm -rf two levels under home is silent", ($, on) => silentWithoutDialog($, on, "rm -rf ~/.cache/foo"));

test("a deeper variable-led path is silent", ($, on) => silentWithoutDialog($, on, "rm -rf $DIR/build/out"));

test("a PowerShell recursive removal of a drive root is denied with no dialog", async ($, on) => {
  const { asked, checked } = world(on);

  expect(await powershell($, "Remove-Item -Recurse -Force C:\\")).toEqual({ decision: "deny", reason: RM_CATASTROPHIC });
  expect(await powershell($, "cmd /c rd /s /q C:\\")).toEqual({ decision: "deny", reason: RM_CATASTROPHIC });
  expect(asked).toEqual([]);
  expect(checked).toEqual([]);
});

test("a catastrophic PowerShell removal is denied even with the guard switched off", async ($, on) => {
  const { asked, checked } = world(on, { env: { OMCA_DISABLED_HOOKS: "all" }, surfaces: [] });

  expect(await powershell($, "ri -r -fo $env:USERPROFILE")).toEqual({ decision: "deny", reason: RM_CATASTROPHIC });
  expect(asked).toEqual([]);
  expect(checked).toEqual([]);
});

test("a PowerShell hard reset is denied where no dialog can show it", async ($, on) => {
  const quiet = world(on, { surfaces: [] });
  expect(await powershell($, "git.exe reset --hard")).toEqual({ decision: "deny", reason: GIT });
  expect(await powershell($, '& "C:\\Program Files\\Git\\cmd\\git.exe" stash')).toEqual({ decision: "deny", reason: GIT });
  expect(quiet.asked).toEqual([]);
  expect(quiet.checked).toEqual([]);
});

test("a PowerShell advisory removal asks with its targets, and the engine's verdict follows a Run it", async ($, on) => {
  const { asked, checked } = world(on, { ...BUILD_WORLD, answer: "Run it" });
  const command = "Remove-Item -Recurse -Force build, notes.txt, ghost";

  expect(await powershell($, command)).toEqual(ENGINE);
  expect(asked).toEqual([
    {
      question: [
        "OMCA held this command for your review:",
        `  ${command}`,
        "It would remove:",
        "  build      dir, 4 entries",
        "  notes.txt  file",
        "  ghost      not found",
        "Run it?",
      ].join("\n"),
      header: "OMCA guard",
      options: ["Refuse", "Run it"],
    },
  ]);
  expect(checked).toEqual([{ tool: "PowerShell", input: { command } }]);
});

test("a refused PowerShell removal is denied", async ($, on) => {
  const refusing = world(on, BUILD_WORLD);
  expect(await powershell($, "Remove-Item -Recurse build")).toEqual({ decision: "deny", reason: REFUSED });
  expect(refusing.checked).toEqual([]);
});

test("with no surface a PowerShell advisory match runs and a blocking one is denied", async ($, on) => {
  const { asked, checked } = world(on, { surfaces: [], git: branches("dev") });

  expect(await powershell($, "Remove-Item -Recurse -Force build")).toEqual(ENGINE);
  expect(await powershell($, "git.exe push --force origin dev")).toEqual(ENGINE);
  expect(await powershell($, "Remove-Item -Recurse build; git clean -fd")).toEqual({ decision: "deny", reason: GIT });
  expect(await powershell($, "git.exe push --force origin main")).toEqual({ decision: "deny", reason: FORCE_PUSH });
  expect(await powershell($, "git commit --no-verify -m 'x'")).toEqual({ decision: "deny", reason: NO_VERIFY });
  expect(asked).toEqual([]);
  expect(checked).toHaveLength(2);
});

test("a PowerShell mention of a destructive command passes through untouched", async ($, on) => {
  const { asked, checked } = world(on);

  expect(await powershell($, "Write-Host 'Remove-Item -Recurse C:\\'")).toEqual(ENGINE);
  expect(await powershell($, "# Remove-Item -Recurse C:\\")).toEqual(ENGINE);
  expect(await powershell($, 'git commit -m "never git.exe reset --hard"')).toEqual(ENGINE);
  expect(await powershell($, "@'\nRemove-Item -Recurse C:\\\n'@ | Set-Content clean.ps1")).toEqual(ENGINE);
  expect(asked).toEqual([]);
  expect(checked).toHaveLength(4);
});

test("every PowerShell path that does not deny gets the engine's verdict unchanged", async ($, on) => {
  world(on, { answer: "Run it", git: { "git log --oneline @{push} --not HEAD": { stdout: "" } } });
  const commands = ["git status", "Get-ChildItem", "git.exe push --force", "Remove-Item -Recurse build", "Write-Host 'hi'"];

  for (const command of commands) expect(await powershell($, command)).toEqual(ENGINE);
});

test("a tool that only looks like a shell never reaches the guard", async ($, on) => {
  const { asked } = world(on);

  await expect($.tool.check({ tool: "PowerShellX", input: { command: "rm -rf /" } })).resolves.toEqual(ENGINE);
  await expect($.tool.check({ tool: "NotBash", input: { command: "rm -rf /" } })).resolves.toEqual(ENGINE);
  expect(asked).toEqual([]);
});

test("home, the working directory and their parents are denied in any spelling, with no dialog", async ($, on) => {
  const { asked, checked } = world(on, { cwd: "/work/sub" });
  const denied = { decision: "deny", reason: RM_CATASTROPHIC };

  expect(await check($, "rm -rf /home/u")).toEqual(denied);
  expect(await check($, "rm -rf /home/u/*")).toEqual(denied);
  expect(await check($, "rm -rf /home/u/dev")).toEqual(denied);
  expect(await check($, "rm -rf /work")).toEqual(denied);
  expect(await check($, "rm -rf /work/sub/")).toEqual(denied);
  expect(await check($, "rm -rf /work/other/../sub")).toEqual(denied);
  expect(await powershell($, "Remove-Item -Recurse /work/sub")).toEqual(denied);
  expect(asked).toEqual([]);
  expect(checked).toEqual([]);
});

test("a path below home or the working directory is still held for review", async ($, on) => {
  const { asked, checked } = world(on, { cwd: "/work/sub", surfaces: [] });

  expect(await check($, "rm -rf /home/u/dev/build")).toEqual(ENGINE);
  expect(await check($, "rm -rf /work/sub/build")).toEqual(ENGINE);
  expect(await check($, "rm -rf /home/user2")).toEqual(ENGINE);
  expect(asked).toEqual([]);
  expect(checked).toHaveLength(3);
});

test("drive roots, Git Bash mounts and share roots are denied under a POSIX layout too", async ($, on) => {
  world(on);

  for (const command of ["rm -rf C:\\", "rm -rf /c", "rm -rf /mnt/c", "rm -rf //srv/share", "rm -rf $USERPROFILE/*"]) {
    expect(await check($, command)).toEqual({ decision: "deny", reason: RM_CATASTROPHIC });
  }
});

test("under a POSIX layout a one-letter top directory is an ordinary path, not a Git Bash drive", async ($, on) => {
  const { asked, checked } = world(on, { surfaces: [] });

  expect(await check($, "rm -rf /c/Users")).toEqual(ENGINE);
  expect(await check($, "rm -rf /d/build")).toEqual(ENGINE);
  expect(asked).toEqual([]);
  expect(checked).toHaveLength(2);
});

test("a variable that is always set does not make a removal catastrophic", async ($, on) => {
  const { asked, checked } = world(on, { surfaces: [] });

  expect(await check($, 'rm -rf "$TMPDIR/foo"')).toEqual(ENGINE);
  expect(await check($, "rm -rf $XDG_CACHE_HOME/omca")).toEqual(ENGINE);
  expect(await powershell($, "Remove-Item -Recurse -Force $env:TEMP\\x")).toEqual(ENGINE);
  expect(await check($, "rm -rf $DIR/*")).toEqual({ decision: "deny", reason: RM_CATASTROPHIC });
  expect(asked).toEqual([]);
  expect(checked).toHaveLength(3);
});

test("a quoted heredoc body is not a command, and a command after it still is", async ($, on) => {
  const { asked, checked } = world(on);

  expect(await check($, "cat <<'EOF'\nrm -rf /\ngit reset --hard\nEOF")).toEqual(ENGINE);
  expect(await check($, "cat <<'EOF'\nnotes\nEOF\nrm -rf /")).toEqual({ decision: "deny", reason: RM_CATASTROPHIC });
  expect(asked).toEqual([]);
  expect(checked).toHaveLength(1);
});

test("a substitution inside double quotes is a command and a single-quoted one is a mention", async ($, on) => {
  const { asked, checked } = world(on);
  const denied = { decision: "deny", reason: RM_CATASTROPHIC };

  expect(await check($, 'echo "$(rm -rf ~)"')).toEqual(denied);
  expect(await check($, 'echo "`rm -rf ~`"')).toEqual(denied);
  expect(await powershell($, 'Write-Host "$(Remove-Item -Recurse $HOME)"')).toEqual(denied);
  expect(await check($, "echo '$(rm -rf ~)'")).toEqual(ENGINE);
  expect(await check($, 'echo "$(date)" "; rm -rf ~"')).toEqual(ENGINE);
  expect(await powershell($, "Write-Host '$(Remove-Item -Recurse $HOME)'")).toEqual(ENGINE);
  expect(await powershell($, 'Write-Host "`$(Remove-Item -Recurse $HOME)"')).toEqual(ENGINE);
  expect(asked).toEqual([]);
  expect(checked).toHaveLength(4);
});

test("a relative target is resolved against the session's folder before it is judged", async ($, on) => {
  const { asked, checked } = world(on, { cwd: "/work/sub", surfaces: [] });
  const denied = { decision: "deny", reason: RM_CATASTROPHIC };

  expect(await check($, "rm -rf ..")).toEqual(denied);
  expect(await check($, "rm -rf ../sub")).toEqual(denied);
  expect(await check($, "rm -rf ../../work/sub/")).toEqual(denied);
  expect(await powershell($, "Remove-Item -Recurse ..\\sub")).toEqual(denied);
  expect(await check($, "rm -rf ./build")).toEqual(ENGINE);
  expect(await check($, "rm -rf build/out")).toEqual(ENGINE);
  expect(await check($, "rm -rf ../other")).toEqual(ENGINE);
  expect(await powershell($, "Remove-Item -Recurse .\\build")).toEqual(ENGINE);
  expect(asked).toEqual([]);
  expect(checked).toHaveLength(4);
});

test("the working directory named by variable or substitution: below it is held for review, it and its parents are denied", async ($, on) => {
  const { asked, checked } = world(on, { cwd: "/work/sub", surfaces: [] });
  const denied = { decision: "deny", reason: RM_CATASTROPHIC };

  expect(await check($, 'rm -rf "$(pwd)/build"')).toEqual(ENGINE);
  expect(await check($, 'rm -rf "$PWD/build"')).toEqual(ENGINE);
  expect(await powershell($, "Remove-Item -Recurse $PWD\\build")).toEqual(ENGINE);
  expect(await powershell($, "Remove-Item -Recurse (Get-Location)\\build")).toEqual(ENGINE);
  expect(await check($, 'rm -rf "$PWD"')).toEqual(denied);
  expect(await check($, "rm -rf $(pwd)/..")).toEqual(denied);
  expect(await powershell($, "Remove-Item -Recurse $PWD")).toEqual(denied);
  expect(await check($, 'rm -rf "$(echo ~)/build"')).toEqual(denied);
  expect(asked).toEqual([]);
  expect(checked).toHaveLength(4);
});

test("git behind a path or an .exe suffix is guarded", async ($, on) => {
  world(on, { surfaces: [] });

  expect(await check($, "/usr/bin/git reset --hard")).toEqual({ decision: "deny", reason: GIT });
  expect(await check($, "git.exe stash")).toEqual({ decision: "deny", reason: GIT });
  expect(await check($, 'git -C "C:\\My Repo" clean -fd')).toEqual({ decision: "deny", reason: GIT });
  expect(await check($, "command rm -rf ~")).toEqual({ decision: "deny", reason: RM_CATASTROPHIC });
});

const WINDOWS_WORLD: World = {
  layout: WINDOWS,
  contents: { "c:\\work\\notes.txt": "", "C:\\work\\other.txt": "", "C:\\Users\\u\\sub\\old.txt": "" },
};

test("on Windows the home from USERPROFILE and the working directory are denied in any spelling", async ($, on) => {
  const { asked, checked } = world(on, WINDOWS_WORLD);
  const denied = { decision: "deny", reason: RM_CATASTROPHIC };

  expect(await powershell($, "Remove-Item -Recurse -Force C:\\Users\\u")).toEqual(denied);
  expect(await powershell($, "Remove-Item -Recurse -Force c:/users/U/*")).toEqual(denied);
  expect(await powershell($, "Remove-Item -Recurse -Force $env:USERPROFILE\\Documents")).toEqual(denied);
  expect(await powershell($, "Remove-Item -Recurse C:\\work")).toEqual(denied);
  expect(await powershell($, "rd /s /q C:\\work\\")).toEqual(denied);
  expect(await check($, "rm -rf /c/Users/u")).toEqual(denied);
  expect(await check($, "rm -rf /c/work")).toEqual(denied);
  expect(asked).toEqual([]);
  expect(checked).toEqual([]);
});

test("on Windows a Git Bash path and a tilde are read as the files they name", async ($, on) => {
  const { asked } = world(on, WINDOWS_WORLD);

  await check($, "rm -rf /c/work/notes.txt C:\\work\\other.txt ~/sub/old.txt ghost.txt");

  expect(asked.map((a) => a.question)).toEqual([
    [
      "OMCA held this command for your review:",
      "  rm -rf /c/work/notes.txt C:\\work\\other.txt ~/sub/old.txt ghost.txt",
      "It would remove:",
      "  /c/work/notes.txt  file",
      "  C:\\work\\other.txt  file",
      "  ~/sub/old.txt      file",
      "  ghost.txt          not found",
      "Run it?",
    ].join("\n"),
  ]);
});

test("on Windows a PowerShell removal lists its drive-spelled targets", async ($, on) => {
  const { asked, checked } = world(on, { ...WINDOWS_WORLD, answer: "Run it" });
  const command = "ri -r C:\\work\\other.txt, ~\\sub\\old.txt, $env:TEMP\\x, missing.txt";

  expect(await powershell($, command)).toEqual(ENGINE);
  expect(asked.map((a) => a.question)).toEqual([
    [
      "OMCA held this command for your review:",
      `  ${command}`,
      "It would remove:",
      "  C:\\work\\other.txt  file",
      "  ~\\sub\\old.txt      file",
      "  $env:TEMP\\x        not expanded",
      "  missing.txt        not found",
      "Run it?",
    ].join("\n"),
  ]);
  expect(checked).toEqual([{ tool: "PowerShell", input: { command } }]);
});

test("the dialog asks when the session draws on Desktop only", async ($, on) => {
  const { asked, checked } = world(on, { ...BUILD_WORLD, surfaces: ["desktop"] });

  expect(await check($, BUILD_COMMAND)).toEqual({ decision: "deny", reason: REFUSED });
  expect(asked).toEqual([{ question: BUILD_QUESTION, header: "OMCA guard", options: ["Refuse", "Run it"] }]);
  expect(checked).toEqual([]);
});
