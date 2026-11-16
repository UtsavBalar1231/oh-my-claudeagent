import type { On, ProcessRunResult } from "claude-code";
import { expect, test, type Engine } from "claude-code/testing";
import { type Layout, WINDOWS, world as sessionWorld } from "./world.ts";

const ENGINE = { decision: "ask", reason: "Bash(rm:*) asks", rule: "Bash(rm:*)" } as const;
const OFF = "Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing.";
const RM_CATASTROPHIC =
  "Destructive rm -rf blocked: the target is the filesystem root, home, the working directory, or a directory directly under root or home. Name a deeper path explicitly.";
const VARIABLE = (name: string, rest: string) =>
  `Destructive rm -rf blocked: the target starts with a variable that can be unset or empty when the rm runs: $${name}. Then $${name}${rest} is ${rest}. Assign ${name} in a statement of its own that always runs before the rm (${name}=/path/to/dir; cd dir && rm -rf "$${name}/..."), or write \${${name}:?} so the shell stops when ${name} is unset or empty.`;
const CD_FAILED = (target: string) =>
  `Destructive rm -rf blocked: the rm can run after its cd failed: a cd joined to it by ; or a newline leaves the rm in the original directory when the cd fails, and there ${target} is protected. Join them with && (cd dir && rm -rf ...) so the rm runs only after the cd succeeds.`;
const TRACKED = (operation: string, where = "") =>
  `Destructive git command blocked: it would discard uncommitted changes to tracked files: git status lists 2 changed files${where}, and ${operation} overwrites them. Commit or stash them first, or REPORT and STOP. ${OFF}`;
const UNTRACKED = `Destructive git command blocked: it would delete untracked files: git clean --dry-run lists 1 path. Commit, move or ignore what should stay first, or REPORT and STOP. ${OFF}`;
const STASHED = `Destructive git command blocked: it would delete stashed changes: git stash list holds 1 entry, and git stash drop deletes them. Apply or commit what should stay first, or REPORT and STOP. ${OFF}`;
const UNREADABLE = (operation: string, detail: string, where = "") =>
  `Destructive git command blocked: the guard could not read the repository state, so it cannot tell what ${operation} would discard${where}: ${detail}. Run git status yourself, then REPORT and STOP. ${OFF}`;
const FORCE_PUSH =
  "Force push to the default branch blocked: it rewrites history everyone else has pulled. Push to another branch, or ask the user to push. Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing.";
const NO_VERIFY =
  "git commit --no-verify blocked: it skips the repository's commit hooks. Fix what the hook reports and commit without the flag. Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing.";

const READ_ONLY = "git --no-optional-locks -c core.fsmonitor=false";
const STATUS = `${READ_ONLY} status --porcelain --untracked-files=no`;
const DIRTY = { stdout: " M src/a.ts\nM  src/b.ts\n" };
const branches = (branch: string, originHead?: string): Record<string, Partial<ProcessRunResult>> => ({
  "git symbolic-ref --quiet --short HEAD": { stdout: `${branch}\n` },
  "git symbolic-ref --quiet --short refs/remotes/origin/HEAD":
    originHead === undefined ? { exitCode: 1 } : { stdout: `origin/${originHead}\n` },
});

type World = {
  env?: Record<string, string>;
  git?: Record<string, Partial<ProcessRunResult> | "reject">;
  failEnv?: string;
  cwd?: string;
  layout?: Layout;
};

function world(on: On, w: World = {}) {
  const checked: unknown[] = [];
  const ran: { argv: string; env: Record<string, string> | undefined }[] = [];
  const env: Record<string, string> = { HOME: "/home/u", ...w.env };
  if (w.layout !== undefined) {
    sessionWorld(on, {}, {}, w.env ?? {}, w.layout);
  } else {
    on("ui.log", () => ({ value: undefined }));
    on("env.get", (_$, e) => (w.failEnv !== undefined && e.name === "OMCA_DISABLED_HOOKS" ? { deny: w.failEnv } : { value: env[e.name] }));
    on("session.root", () => ({ value: "/work" }));
  }
  on("session.cwd", () => ({ value: w.cwd ?? w.layout?.root ?? "/work/sub" }));
  on("process.run", (_$, e) => {
    const argv = e.argv.join(" ");
    if (argv === "git rev-parse --show-toplevel") return { value: { exitCode: 0, stdout: "/work\n", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
    ran.push({ argv, env: e.init?.env });
    const result = w.git?.[argv];
    if (result === undefined) throw new Error(`unexpected process.run ${argv}`);
    if (result === "reject") return { deny: "git timed out" };
    return { value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false, ...result } };
  });
  on("tool.check", (_$, e) => (checked.push(e), ENGINE));
  return { checked, ran };
}

const check = ($: Engine, command: string, tool = "Bash") => $.tool.check({ tool, input: { command } });
const powershell = ($: Engine, command: string) => check($, command, "PowerShell");
const deny = (reason: string) => ({ decision: "deny", reason });

test("rm -rf ~ is denied before the engine decides", async ($, on) => {
  const { checked } = world(on);

  expect(await check($, "rm -rf ~")).toEqual(deny(RM_CATASTROPHIC));
  expect(checked).toEqual([]);
});

test("a catastrophic removal is denied even with OMCA_DISABLED_HOOKS set to all", async ($, on) => {
  const { checked } = world(on, { env: { OMCA_DISABLED_HOOKS: "all" } });

  expect(await check($, "cd /x && sudo rm -rf /usr")).toEqual(deny(RM_CATASTROPHIC));
  expect(checked).toEqual([]);
});

test("any other recursive removal and a force push to another branch get the engine's verdict unchanged", async ($, on) => {
  const { checked } = world(on, { git: branches("dev") });

  expect(await check($, "rm -rf build notes.txt ~/.cache/omca *.o")).toEqual(ENGINE);
  expect(await check($, "git push --force origin dev")).toEqual(ENGINE);
  expect(await check($, "rm -rf /tmp/omca-canary")).toEqual(ENGINE);
  expect(checked).toEqual([
    { tool: "Bash", input: { command: "rm -rf build notes.txt ~/.cache/omca *.o" } },
    { tool: "Bash", input: { command: "git push --force origin dev" } },
    { tool: "Bash", input: { command: "rm -rf /tmp/omca-canary" } },
  ]);
});

test("a variable the command assigns is read before the target is judged", async ($, on) => {
  world(on);

  expect(await check($, "S=/home/user/.cache/tmp/x/scratchpad; rm -rf $S/root")).toEqual(ENGINE);
  expect(await check($, 'S=/home/user/.cache/x && rm -rf "$S/smoke"')).toEqual(ENGINE);
  expect(await check($, 'T=$(mktemp -d); rm -rf "$T"')).toEqual(ENGINE);
  expect(await check($, 'rm -rf "${BUILD:?}/out"')).toEqual(ENGINE);
  expect(await check($, "rm -rf -- < $S/file")).toEqual(ENGINE);
  expect(await check($, "S=/tmp/x rm -rf $S/y")).toEqual(deny(VARIABLE("S", "/y")));
  expect(await check($, "rm -rf $UNSET/usr")).toEqual(deny(VARIABLE("UNSET", "/usr")));
  expect(await check($, "S=; rm -rf $S/x")).toEqual(deny(RM_CATASTROPHIC));
});

test("a glob after a cd is judged in the directory the cd enters, and a cd that can fail first is named", async ($, on) => {
  world(on);

  expect(await check($, "cd /tmp/x && rm -rf *")).toEqual(ENGINE);
  expect(await check($, "cd /tmp/x; rm -rf *")).toEqual(deny(CD_FAILED("*")));
  expect(await check($, "cd /tmp/x\nrm -rf ./*")).toEqual(deny(CD_FAILED("./*")));
  expect(await check($, "rm -rf *")).toEqual(deny(RM_CATASTROPHIC));
  expect(await check($, "rm -rf .")).toEqual(deny(RM_CATASTROPHIC));
});

test("a whole-tree git operation reads the repository and is denied only when it would discard work", async ($, on) => {
  const { ran } = world(on, {
    git: {
      [STATUS]: DIRTY,
      [`${READ_ONLY} -C /srv/clean status --porcelain --untracked-files=no`]: { stdout: "" },
      [`${READ_ONLY} clean --dry-run -d -f`]: { stdout: "Would remove scratch.txt\n" },
      [`${READ_ONLY} stash list`]: { stdout: "stash@{0}: WIP on main\n" },
    },
  });

  expect(await check($, "git reset --hard")).toEqual(deny(TRACKED("git reset --hard")));
  expect(await check($, "git checkout -- .")).toEqual(deny(TRACKED("git checkout .")));
  expect(await check($, "git restore .")).toEqual(deny(TRACKED("git restore .")));
  expect(await check($, "git -C /srv/clean reset --hard")).toEqual(ENGINE);
  expect(await check($, "cd /srv/clean && git reset --hard")).toEqual(ENGINE);
  expect(await check($, "git clean -fd")).toEqual(deny(UNTRACKED));
  expect(await check($, "git stash drop")).toEqual(deny(STASHED));
  expect(ran.every((call) => call.env?.["LC_ALL"] === "C")).toBe(true);
});

test("a named-path revert, a stash, a git rm and a dry run run without reading the repository", async ($, on) => {
  const { ran, checked } = world(on);

  for (const command of ["git checkout -- src/a.ts", "git restore src/a.ts", "git stash", "git stash pop", "git rm -r vendor", "git clean -n"]) {
    expect(await check($, command)).toEqual(ENGINE);
  }
  expect(ran).toEqual([]);
  expect(checked).toHaveLength(6);
});

test("outside a repository git fails on its own, so the command runs; an unreadable state is denied", async ($, on) => {
  world(on, {
    git: {
      [STATUS]: { exitCode: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git\n" },
      [`${READ_ONLY} -C /srv/locked status --porcelain --untracked-files=no`]: { exitCode: 128, stderr: "fatal: unable to read index\nmore\n" },
      [`${READ_ONLY} -C /srv/slow status --porcelain --untracked-files=no`]: "reject",
    },
  });

  expect(await check($, "git reset --hard")).toEqual(ENGINE);
  expect(await check($, "git -C /srv/locked reset --hard")).toEqual(deny(UNREADABLE("git reset --hard", "fatal: unable to read index", " in /srv/locked")));
  expect(await check($, "git -C /srv/slow reset --hard")).toEqual(deny(UNREADABLE("git reset --hard", "git timed out", " in /srv/slow")));
  expect(await check($, "git -C $REPO reset --hard")).toEqual(
    deny(UNREADABLE("git reset --hard", "the directory it runs git in is only known when the command runs")),
  );
});

test("a force push to the default branch and a commit that skips its hooks are denied", async ($, on) => {
  world(on, { git: branches("dev") });

  expect(await check($, "git push --force origin main")).toEqual(deny(FORCE_PUSH));
  expect(await check($, "git push --mirror")).toEqual(deny(FORCE_PUSH));
  expect(await check($, "git commit --no-verify -m x")).toEqual(deny(NO_VERIFY));
  expect(await check($, "git commit -n -m x")).toEqual(deny(NO_VERIFY));
});

test("a push that names no branch is judged by the checked-out one, read from local refs", async ($, on) => {
  world(on, { git: branches("main") });
  expect(await check($, "git push -f")).toEqual(deny(FORCE_PUSH));
  expect(await check($, "git push --force origin")).toEqual(deny(FORCE_PUSH));
  expect(await check($, "git push -f origin HEAD")).toEqual(deny(FORCE_PUSH));
});

test("origin/HEAD names the default branch, and a push to main is then an ordinary force push", async ($, on) => {
  const { checked } = world(on, { git: branches("develop", "develop") });
  expect(await check($, "git push -f")).toEqual(deny(FORCE_PUSH));
  expect(await check($, "git push -f origin develop")).toEqual(deny(FORCE_PUSH));
  expect(await check($, "git push -f origin main")).toEqual(ENGINE);
  expect(checked).toEqual([{ tool: "Bash", input: { command: "git push -f origin main" } }]);
});

test("when git cannot read the branches, main and master are the default by name", async ($, on) => {
  world(on, {
    git: {
      "git symbolic-ref --quiet --short HEAD": { exitCode: 128, stderr: "fatal: not a git repository\n" },
      "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": { exitCode: 128, stderr: "fatal: not a git repository\n" },
    },
  });
  expect(await check($, "git push -f origin master")).toEqual(deny(FORCE_PUSH));
  expect(await check($, "git push -f")).toEqual(ENGINE);
});

test("bash-guard in OMCA_DISABLED_HOOKS turns off every git rule, reads no repository, and keeps the catastrophic deny", async ($, on) => {
  const { ran } = world(on, { env: { OMCA_DISABLED_HOOKS: "verification-recorder,bash-guard" } });

  expect(await check($, "git reset --hard")).toEqual(ENGINE);
  expect(await check($, "git push -f origin main")).toEqual(ENGINE);
  expect(await check($, "git commit --no-verify -m x")).toEqual(ENGINE);
  expect(await check($, "rm -rf /")).toEqual(deny(RM_CATASTROPHIC));
  expect(ran).toEqual([]);
});

test("OMCA_DISABLED_HOOKS listing a different hook still reads the repository", async ($, on) => {
  world(on, { env: { OMCA_DISABLED_HOOKS: "other-hook" }, git: { [STATUS]: DIRTY } });

  expect(await check($, "git reset --hard")).toEqual(deny(TRACKED("git reset --hard")));
});

test("a guard that fails while it decides denies the command and names why", async ($, on) => {
  const { checked } = world(on, { failEnv: "x" });

  expect(await check($, "git reset --hard")).toEqual(deny("OMCA's Bash guard failed, so the command was refused: x"));
  expect(checked).toEqual([]);
});

test("a removal handed to a shell, eval or a heredoc, or behind timeout, is judged as the command it runs", async ($, on) => {
  const { checked } = world(on, { git: { [STATUS]: DIRTY } });

  expect(await check($, "bash -c 'rm -rf ~'")).toEqual(deny(RM_CATASTROPHIC));
  expect(await check($, `sh -c 'rm -rf "$HOME"'`)).toEqual(deny(RM_CATASTROPHIC));
  expect(await check($, "sudo bash -lc 'rm -rf /'")).toEqual(deny(RM_CATASTROPHIC));
  expect(await check($, 'eval "rm -rf /"')).toEqual(deny(RM_CATASTROPHIC));
  expect(await check($, "bash <<EOF\nrm -rf /\nEOF")).toEqual(deny(RM_CATASTROPHIC));
  expect(await check($, "timeout 5 rm -rf ~")).toEqual(deny(RM_CATASTROPHIC));
  expect(await powershell($, 'pwsh -Command "Remove-Item -Recurse $HOME"')).toEqual(deny(RM_CATASTROPHIC));
  expect(await powershell($, 'cmd /c "cd x && rd /s /q C:\\"')).toEqual(deny(RM_CATASTROPHIC));
  expect(await check($, 'env bash -c "git reset --hard"')).toEqual(deny(TRACKED("git reset --hard")));
  expect(await check($, "xargs rm -rf")).toEqual(ENGINE);
  expect(await check($, "echo \"bash -c 'rm -rf ~'\"")).toEqual(ENGINE);
  expect(checked).toHaveLength(2);
});

test("a quoted mention of a destructive command passes through untouched", async ($, on) => {
  const { checked } = world(on);

  expect(await check($, 'echo "rm -rf /"')).toEqual(ENGINE);
  expect(await check($, 'git commit -m "drop git reset --hard"')).toEqual(ENGINE);
  expect(checked).toHaveLength(2);
});

for (const command of ["jq . file.json", "npm run build", "uv run pytest", "git status", "git log", "git config --local core.hooksPath /tmp/evil", "git fetch"]) {
  test(`an unmatched command gets the engine's verdict unchanged: ${command}`, async ($, on) => {
    const { checked, ran } = world(on);
    expect(await check($, command)).toEqual(ENGINE);
    expect(checked).toHaveLength(1);
    expect(ran).toEqual([]);
  });
}

test("a PowerShell recursive removal of a drive root is denied, even with the guard switched off", async ($, on) => {
  const { checked } = world(on, { env: { OMCA_DISABLED_HOOKS: "all" } });

  expect(await powershell($, "Remove-Item -Recurse -Force C:\\")).toEqual(deny(RM_CATASTROPHIC));
  expect(await powershell($, "cmd /c rd /s /q C:\\")).toEqual(deny(RM_CATASTROPHIC));
  expect(await powershell($, "ri -r -fo $env:USERPROFILE")).toEqual(deny(RM_CATASTROPHIC));
  expect(checked).toEqual([]);
});

test("PowerShell reads its assignments and checks a whole-tree git operation the same way", async ($, on) => {
  const { checked } = world(on, { git: { ...branches("dev"), [STATUS]: DIRTY } });

  expect(await powershell($, "$S = 'C:\\Users\\u\\.cache\\x'; Remove-Item -Recurse -Force $S\\root")).toEqual(ENGINE);
  expect(await powershell($, "Remove-Item -Recurse -Force build")).toEqual(ENGINE);
  expect(await powershell($, "git.exe push --force origin dev")).toEqual(ENGINE);
  expect(await powershell($, "git.exe reset --hard")).toEqual(deny(TRACKED("git reset --hard")));
  expect(await powershell($, "git.exe push --force origin main")).toEqual(deny(FORCE_PUSH));
  expect(await powershell($, "git commit --no-verify -m 'x'")).toEqual(deny(NO_VERIFY));
  expect(checked).toHaveLength(3);
});

test("a PowerShell mention of a destructive command passes through untouched", async ($, on) => {
  const { checked } = world(on);

  expect(await powershell($, "Write-Host 'Remove-Item -Recurse C:\\'")).toEqual(ENGINE);
  expect(await powershell($, "# Remove-Item -Recurse C:\\")).toEqual(ENGINE);
  expect(await powershell($, 'git commit -m "never git.exe reset --hard"')).toEqual(ENGINE);
  expect(await powershell($, "@'\nRemove-Item -Recurse C:\\\n'@ | Set-Content clean.ps1")).toEqual(ENGINE);
  expect(checked).toHaveLength(4);
});

test("a Monitor command is checked like a Bash command, and a WebSocket monitor reaches the engine untouched", async ($, on) => {
  world(on);
  const monitor = (input: Record<string, unknown>) => $.tool.check({ tool: "Monitor", input: { description: "watch", timeout_ms: 60_000, ...input } });

  expect(await monitor({ command: "rm -rf ~" })).toEqual(deny(RM_CATASTROPHIC));
  expect(await monitor({ command: "rm -rf build" })).toEqual(ENGINE);
  expect(await monitor({ ws: { url: "wss://feed.example.test/events" } })).toEqual(ENGINE);
  expect(await monitor({ command: "tail -f build.log" })).toEqual(ENGINE);
});

test("a tool that only looks like a shell never reaches the guard", async ($, on) => {
  world(on);

  await expect($.tool.check({ tool: "PowerShellX", input: { command: "rm -rf /" } })).resolves.toEqual(ENGINE);
  await expect($.tool.check({ tool: "NotBash", input: { command: "rm -rf /" } })).resolves.toEqual(ENGINE);
});

test("home, the working directory and their parents are denied in any spelling", async ($, on) => {
  const { checked } = world(on, { cwd: "/work/sub" });

  for (const command of ["rm -rf /home/u", "rm -rf /home/u/*", "rm -rf /home/u/dev", "rm -rf /work", "rm -rf /work/sub/", "rm -rf /work/other/../sub"]) {
    expect(await check($, command)).toEqual(deny(RM_CATASTROPHIC));
  }
  expect(await powershell($, "Remove-Item -Recurse /work/sub")).toEqual(deny(RM_CATASTROPHIC));
  expect(checked).toEqual([]);
});

test("a path below home or the working directory runs", async ($, on) => {
  const { checked } = world(on, { cwd: "/work/sub" });

  expect(await check($, "rm -rf /home/u/dev/build")).toEqual(ENGINE);
  expect(await check($, "rm -rf /work/sub/build")).toEqual(ENGINE);
  expect(await check($, "rm -rf /home/user2")).toEqual(ENGINE);
  expect(checked).toHaveLength(3);
});

test("drive roots, Git Bash mounts and share roots are denied under a POSIX layout too", async ($, on) => {
  world(on);

  for (const command of ["rm -rf C:\\", "rm -rf /c", "rm -rf /mnt/c", "rm -rf //srv/share", "rm -rf $USERPROFILE/*"]) {
    expect(await check($, command)).toEqual(deny(RM_CATASTROPHIC));
  }
});

test("a variable that is always set does not make a removal catastrophic", async ($, on) => {
  const { checked } = world(on);

  expect(await check($, 'rm -rf "$TMPDIR/foo"')).toEqual(ENGINE);
  expect(await check($, "rm -rf $XDG_CACHE_HOME/omca")).toEqual(ENGINE);
  expect(await powershell($, "Remove-Item -Recurse -Force $env:TEMP\\x")).toEqual(ENGINE);
  expect(await check($, "rm -rf $DIR/*")).toEqual(deny(VARIABLE("DIR", "/*")));
  expect(checked).toHaveLength(3);
});

test("a substitution inside double quotes is a command and a single-quoted one is a mention", async ($, on) => {
  const { checked } = world(on);

  expect(await check($, 'echo "$(rm -rf ~)"')).toEqual(deny(RM_CATASTROPHIC));
  expect(await check($, 'echo "`rm -rf ~`"')).toEqual(deny(RM_CATASTROPHIC));
  expect(await powershell($, 'Write-Host "$(Remove-Item -Recurse $HOME)"')).toEqual(deny(RM_CATASTROPHIC));
  expect(await check($, "echo '$(rm -rf ~)'")).toEqual(ENGINE);
  expect(await check($, 'echo "$(date)" "; rm -rf ~"')).toEqual(ENGINE);
  expect(checked).toHaveLength(2);
});

test("a relative target is resolved against the session's folder before it is judged", async ($, on) => {
  const { checked } = world(on, { cwd: "/work/sub" });

  for (const command of ["rm -rf ..", "rm -rf ../sub", "rm -rf ../../work/sub/"]) expect(await check($, command)).toEqual(deny(RM_CATASTROPHIC));
  expect(await powershell($, "Remove-Item -Recurse ..\\sub")).toEqual(deny(RM_CATASTROPHIC));
  for (const command of ["rm -rf ./build", "rm -rf build/out", "rm -rf ../other"]) expect(await check($, command)).toEqual(ENGINE);
  expect(await powershell($, "Remove-Item -Recurse .\\build")).toEqual(ENGINE);
  expect(checked).toHaveLength(4);
});

test("git behind a path or an .exe suffix is checked", async ($, on) => {
  world(on, { git: { [STATUS]: DIRTY, [`${READ_ONLY} -C C:\\My Repo clean --dry-run -d -f`]: { stdout: "Would remove x\n" } } });

  expect(await check($, "/usr/bin/git reset --hard")).toEqual(deny(TRACKED("git reset --hard")));
  expect(await check($, 'git -C "C:\\My Repo" clean -fd')).toEqual(deny(UNTRACKED.replace("lists 1 path.", "lists 1 path in C:\\My Repo.")));
  expect(await check($, "command rm -rf ~")).toEqual(deny(RM_CATASTROPHIC));
});

test("on Windows the home from USERPROFILE and the working directory are denied in any spelling", async ($, on) => {
  const { checked } = world(on, { layout: WINDOWS });

  for (const command of [
    "Remove-Item -Recurse -Force C:\\Users\\u",
    "Remove-Item -Recurse -Force c:/users/U/*",
    "Remove-Item -Recurse -Force $env:USERPROFILE\\Documents",
    "Remove-Item -Recurse C:\\work",
    "rd /s /q C:\\work\\",
  ]) {
    expect(await powershell($, command)).toEqual(deny(RM_CATASTROPHIC));
  }
  expect(await check($, "rm -rf /c/Users/u")).toEqual(deny(RM_CATASTROPHIC));
  expect(await check($, "rm -rf /c/work")).toEqual(deny(RM_CATASTROPHIC));
  expect(await powershell($, "ri -r C:\\work\\other.txt, ~\\sub\\old.txt, $env:TEMP\\x, missing.txt")).toEqual(ENGINE);
  expect(checked).toHaveLength(1);
});
