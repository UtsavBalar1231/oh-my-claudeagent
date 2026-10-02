import type { On, ProcessRunResult } from "claude-code";
import { expect, test, type Engine } from "claude-code/testing";
import { type Layout, WINDOWS, world as sessionWorld } from "./world.ts";

const ENGINE = { decision: "ask", reason: "Bash(rm:*) asks", rule: "Bash(rm:*)" } as const;
const RM_CATASTROPHIC =
  "Destructive rm -rf blocked: the target is the filesystem root, home, the working directory, or a directory directly under root or home. Name a deeper path explicitly.";
const REFUSED = "The user refused this command in OMCA's review. Do not retry it; ask the user how to proceed.";
const GIT =
  "Destructive git command blocked. If working tree is dirty, REPORT and STOP — never modify history. Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing.";

type Node = { kind: "file" | "dir" | "other"; entries?: number; isLink?: boolean };
type World = {
  env?: Record<string, string>;
  surfaces?: ("terminal" | "desktop")[];
  files?: Record<string, Node>;
  git?: Record<string, Partial<ProcessRunResult>>;
  answer?: string;
  failExists?: string;
  cwd?: string;
  layout?: Layout;
  contents?: Record<string, string>;
};
type Question = { question: string; header: string; options: { label: string }[] };

function world(on: On, w: World = {}) {
  const asked: { question: string; header: string; options: string[] }[] = [];
  const checked: unknown[] = [];
  const env: Record<string, string> = { HOME: "/home/u", ...w.env };
  const files = w.files ?? {};
  // The engine resolves a relative path against the session's folder before the hook sees it.
  const nodeAt = (path: string) =>
    Object.entries(files).find(([name]) => path === name || path.endsWith(`/${name}`))?.[1];
  if (w.layout !== undefined) {
    sessionWorld(on, w.contents ?? {}, {}, w.env ?? {}, w.layout);
  } else {
    on("ui.log", () => ({ value: undefined }));
    on("env.get", (_$, e) => ({ value: env[e.name] }));
    on("session.root", () => ({ value: "/work" }));
    on("fs.exists", (_$, e) => {
      if (w.failExists !== undefined && e.path.endsWith(`/${w.failExists}`)) {
        return { deny: `EACCES: permission denied, access '${w.failExists}'` };
      }
      return { value: nodeAt(e.path) !== undefined };
    });
    on("fs.stat", (_$, e) => {
      const node = nodeAt(e.path);
      if (node === undefined) throw new Error(`ENOENT: ${e.path}`);
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
  on("session.surfaces", () => ({ value: w.surfaces ?? ["terminal"] }));
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
  const { asked, checked } = world(on, { ...BUILD_WORLD, surfaces: [] });

  expect(await check($, "rm -rf build")).toEqual(ENGINE);
  expect(await check($, "git push --force origin main")).toEqual(ENGINE);
  expect(await check($, "git reset --hard")).toEqual({ decision: "deny", reason: GIT });
  expect(await check($, "rm -rf build; git stash")).toEqual({ decision: "deny", reason: GIT });
  expect(asked).toEqual([]);
  expect(checked).toEqual([
    { tool: "Bash", input: { command: "rm -rf build" } },
    { tool: "Bash", input: { command: "git push --force origin main" } },
  ]);
});

test("guardMode deny decides without asking: blocking and catastrophic matches deny, advisory ones run", { options: { guardMode: "deny" } }, async ($, on) => {
  const { asked, checked } = world(on, BUILD_WORLD);

  expect(await check($, "rm -rf build")).toEqual(ENGINE);
  expect(await check($, "git push --force origin main")).toEqual(ENGINE);
  expect(await check($, "rm -rf build; git stash")).toEqual({ decision: "deny", reason: GIT });
  expect(await check($, "rm -rf ~")).toEqual({ decision: "deny", reason: RM_CATASTROPHIC });
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

test("a force push lists the commits it drops, capped at 20 with a count of the rest", async ($, on) => {
  const commits = Array.from({ length: 22 }, (_, i) => `c${String(i).padStart(6, "0")} commit ${i}`);
  const { asked } = world(on, {
    git: { "git log --oneline origin/main --not HEAD": { stdout: `${commits.join("\n")}\n` } },
  });

  expect(await check($, "git push --force origin main")).toEqual({ decision: "deny", reason: REFUSED });
  expect(asked.map((a) => a.question)).toEqual([
    [
      "OMCA held this command for your review:",
      "  git push --force origin main",
      "git push --force drops 22 commits from origin/main:",
      ...commits.slice(0, 20).map((line) => `  ${line}`),
      "  and 2 more commits",
      "Run it?",
    ].join("\n"),
  ]);
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

test("more than 20 targets list the first 20 and count the rest", async ($, on) => {
  const targets = Array.from({ length: 23 }, (_, i) => `t${String(i).padStart(2, "0")}`);
  const { asked } = world(on, { files: Object.fromEntries(targets.map((t) => [t, { kind: "file" as const }])) });

  await check($, `rm -rf ${targets.join(" ")}`);

  const lines = asked[0]?.question.split("\n") ?? [];
  expect(lines.slice(3, 5)).toEqual(["  t00  file", "  t01  file"]);
  expect(lines.slice(22)).toEqual(["  t19  file", "  and 3 more", "Run it?"]);
  expect(lines).toHaveLength(25);
});

test("a long path is middle-truncated to the dialog width, with an ASCII ellipsis under OMCA_ASCII", async ($, on) => {
  const { asked } = world(on, { env: { OMCA_ASCII: "1" }, files: { [LONG_PATH]: { kind: "file" } } });

  await check($, `rm -r ${LONG_PATH}`);

  expect(asked[0]?.question.split("\n").slice(1, 4)).toEqual([
    "  rm -r src/deep/deep/deep/deep/deep/deep/deep/deep/deep/deep/deep/deep/dee...",
    "It would remove:",
    "  src/deep/deep/deep/deep/deep/deep/...deep/deep/deep/deep/deep/leaf.txt  file",
  ]);
});

test("a long path uses the Unicode ellipsis by default", async ($, on) => {
  const { asked } = world(on, { files: { [LONG_PATH]: { kind: "file" } } });

  await check($, `rm -r ${LONG_PATH}`);

  expect(asked[0]?.question.split("\n").slice(1, 4)).toEqual([
    "  rm -r src/deep/deep/deep/deep/deep/deep/deep/deep/deep/deep/deep/deep/deep/…",
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

test("jq gets no allow on PreToolUse", async ($, on) => {
  world(on);
  expect(await check($, "jq . file.json")).toEqual(ENGINE);
});

test("npm run gets no allow on PreToolUse", async ($, on) => {
  world(on);
  expect(await check($, "npm run build")).toEqual(ENGINE);
});

test("uv run gets no allow on PreToolUse", async ($, on) => {
  world(on);
  expect(await check($, "uv run pytest")).toEqual(ENGINE);
});

test("git status gets no allow on PreToolUse", async ($, on) => {
  world(on);
  expect(await check($, "git status")).toEqual(ENGINE);
});

test("no non-deny path emits behavior allow", async ($, on) => {
  world(on, { answer: "Run it", git: { "git log --oneline @{push} --not HEAD": { stdout: "" } } });
  const commands = ["git status", "git log", "git config --local core.hooksPath /tmp/evil", "git push --force", "git fetch"];

  for (const command of commands) expect(await check($, command)).toEqual(ENGINE);
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
  const { asked, checked } = world(on, { surfaces: [] });

  expect(await powershell($, "Remove-Item -Recurse -Force build")).toEqual(ENGINE);
  expect(await powershell($, "git.exe push --force origin main")).toEqual(ENGINE);
  expect(await powershell($, "Remove-Item -Recurse build; git clean -fd")).toEqual({ decision: "deny", reason: GIT });
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

test("no PowerShell path emits behavior allow", async ($, on) => {
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

test("a variable that is always set no longer makes a removal catastrophic", async ($, on) => {
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
