import { describe, expect, test } from "bun:test";
import { classify, type Context } from "./destructive.ts";
import { neutralizePowershell, powershellWords } from "./powershell.ts";

const PS: Context = { shell: "powershell" };
const SESSION: Context = { shell: "powershell", home: "C:\\Users\\x", cwd: "C:\\Users\\x\\proj", root: "C:\\Users\\x\\proj" };

const classOf = (command: string, ctx: Context = PS) => classify(command, ctx)?.kind ?? "none";

describe("the removal commands and their parameters", () => {
  test.each([
    "Remove-Item -Recurse -Force C:\\",
    "Remove-Item -Recurse C:",
    "Remove-Item -Recurse -Force c:/",
    "REMOVE-ITEM -RECURSE C:\\",
    "remove-item -recurse c:\\",
    "ri -r -fo C:\\",
    "rm -r C:\\",
    "rm -Recurse C:\\",
    "rm -rf C:\\",
    "rm -R -Force C:\\",
    "rm --recursive C:\\",
    "del -Recurse C:\\",
    "erase -Recurse C:\\",
    "rd -Recurse C:\\",
    "rmdir -Recurse C:\\",
    "Remove-Item -R C:\\",
    "Remove-Item -Re C:\\",
    "Remove-Item -rec C:\\",
    "Remove-Item -Recurs C:\\",
    "Remove-Item -Recurse:$true C:\\",
    "Remove-Item -Force -Recurse C:\\",
    "Remove-Item C:\\ -Recurse",
    "Remove-Item -Path C:\\ -Recurse",
    "Remove-Item -Pa C:\\ -Recurse",
    "Remove-Item -LiteralPath C:\\ -Recurse",
    "Remove-Item -LiteralPath:C:\\ -Recurse",
    "Remove-Item -Path:C:\\ -Recurse",
    "Remove-Item -Recurse -Include *.log -Path C:\\",
    "Remove-Item -Recurse -Filter *.log -Path C:\\ -Force",
    "Remove-Item -Recurse -Force -ErrorAction SilentlyContinue C:\\",
    "Remove-Item -Recurse -Force -ErrorAction:SilentlyContinue C:\\",
    "& Remove-Item -Recurse C:\\",
    "Remove-Item.exe -Recurse C:\\",
    "Get-Date; Remove-Item -Recurse C:\\",
    "Remove-Item -Recurse build; Remove-Item -Recurse C:\\",
    "Get-ChildItem | ForEach-Object { Remove-Item -Recurse -Force C:\\ }",
    "if ($clean) { Remove-Item -Recurse C:\\ }",
    "foreach ($d in $dirs) { rm -r C:\\ }",
    "(Remove-Item -Recurse C:\\)",
  ])("%s is catastrophic", (command) => expect(classOf(command)).toBe("catastrophic"));

  test.each([
    "Remove-Item C:\\",
    "Remove-Item -Force C:\\",
    "Remove-Item -Recurse:$false C:\\",
    "Remove-Item -Rec:$False C:\\",
    "Remove-Item -Force -ErrorAction SilentlyContinue C:\\Users\\x\\proj\\build\\one.txt",
    "rm -f C:\\one.txt",
    "rm -force C:\\one.txt",
    "del C:\\*.tmp",
    "rd C:\\empty",
    "rmdir C:\\empty",
    "Get-ChildItem C:\\",
    "Remove-Items -Recurse C:\\",
    "Remove-Item-X -Recurse C:\\",
    "xrm -rf C:\\",
  ])("%s is not a recursive removal", (command) => expect(classOf(command)).toBe("none"));

  test("an ambiguous parameter prefix is not Recurse", () => {
    expect(classOf("Remove-Item -F C:\\one.txt")).toBe("none");
    expect(classOf("Remove-Item -Fo -Fi x C:\\one.txt")).toBe("none");
  });
});

describe("cmd forms", () => {
  test.each([
    "cmd /c rd /s /q C:\\",
    "cmd /c rmdir /s /q C:\\",
    "cmd /c del /s /q C:\\*",
    "cmd /c erase /s C:\\",
    "cmd.exe /c rd /s /q C:\\",
    "CMD /C RD /S /Q C:\\",
    "cmd /k rd /s C:\\",
    'cmd /c "rd /s /q C:\\"',
    "& cmd /c rd /s /q C:\\",
    "rd /s /q C:\\",
    "rmdir /s /q C:\\",
    "del /s /q C:\\*",
    "del /q /s C:\\",
    "rd C:\\ /s",
    "rd /s /q C:\\Windows",
    "rd /s /q \\\\srv\\share",
  ])("%s is catastrophic", (command) => expect(classOf(command)).toBe("catastrophic"));

  test.each(["cmd /c rd /q C:\\empty", "cmd /c del /q C:\\one.txt", "rd /q C:\\empty", "cmd /c dir C:\\"])(
    "%s is not a recursive removal",
    (command) => expect(classOf(command)).toBe("none"),
  );

  test("the flags of a cmd removal are not its targets", () => {
    expect(classify("cmd /c rd /s /q build\\out", PS)).toEqual({
      kind: "advisory",
      removals: [{ targets: ["build\\out"] }],
      git: [],
    });
  });
});

describe("targets", () => {
  test.each([
    "Remove-Item -Recurse $HOME",
    "Remove-Item -Recurse ~",
    "Remove-Item -Recurse ~\\*",
    "Remove-Item -Recurse $HOME\\*",
    "Remove-Item -Recurse $HOME\\Documents",
    "Remove-Item -Recurse $env:USERPROFILE",
    "Remove-Item -Recurse ${env:USERPROFILE}",
    "Remove-Item -Recurse $env:USERPROFILE\\*",
    "Remove-Item -Recurse -Force \"$env:USERPROFILE\\*\"",
    "Remove-Item -Recurse '$env:USERPROFILE'",
    "Remove-Item -Recurse $env:HOMEDRIVE$env:HOMEPATH",
    "Remove-Item -Recurse %USERPROFILE%\\*",
    "Remove-Item -Recurse \\\\srv\\share",
    "Remove-Item -Recurse //srv/share",
    "Remove-Item -Recurse \\\\srv\\share\\*",
    "Remove-Item -Recurse C:\\Windows",
    "Remove-Item -Recurse C:\\Windows\\*",
    "Remove-Item -Recurse C:\\Users",
    "Remove-Item -Recurse -Path C:\\Users\\*",
    "Remove-Item -Recurse \\",
    "Remove-Item -Recurse \\*",
    "Remove-Item -Recurse .",
    "Remove-Item -Recurse .\\*",
    "Remove-Item -Recurse ..",
    "Remove-Item -Recurse ..\\..",
    "Remove-Item -Recurse $dir\\*",
    "Remove-Item -Recurse $env:TEMP\\..\\..",
    "Remove-Item -Recurse -Force $env:LOCALAPPDATA",
    "Remove-Item -Recurse $env:APPDATA\\*",
    "Remove-Item -Recurse build, C:\\",
    "Remove-Item -Recurse C:\\,build",
    "Remove-Item -Recurse $(Get-Location)",
    "rm -rf /",
    "rm -rf ~",
    "rm -rf /usr/*",
  ])("%s is catastrophic", (command) => expect(classOf(command)).toBe("catastrophic"));

  test.each([
    "Remove-Item -Recurse -Force C:\\Users\\x\\proj\\build",
    "Remove-Item -Recurse -Force $env:TEMP\\x",
    "Remove-Item -Recurse -Force \"$env:TEMP\\x\"",
    "Remove-Item -Recurse -Force $env:TMPDIR\\x\\y",
    "Remove-Item -Recurse -Force $env:RUNNER_TEMP\\build",
    "Remove-Item -Recurse -Force ${env:XDG_CACHE_HOME}\\omca",
    "Remove-Item -Recurse -Force %TEMP%\\x",
    "Remove-Item -Recurse $env:TEMP\\*",
    "Remove-Item -Recurse -Force $env:LOCALAPPDATA\\npm-cache",
    "Remove-Item -Recurse $env:APPDATA\\Code\\Cache",
    "Remove-Item -Recurse $HOME\\Documents\\old",
    "Remove-Item -Recurse $env:USERPROFILE\\a\\b",
    "Remove-Item -Recurse \\\\srv\\share\\builds",
    "Remove-Item -Recurse C:\\Windows\\System32",
    "Remove-Item -Recurse build",
    "Remove-Item -Recurse .\\build\\out",
    "Remove-Item -Recurse build, dist",
    "Remove-Item -Recurse (Join-Path $root 'build')",
    "Remove-Item -Recurse -Filter *.log C:\\Users\\x\\proj\\logs",
    "Get-ChildItem | Remove-Item -Recurse -Force",
    "Get-ChildItem C:\\x -Recurse | Remove-Item -Recurse",
    "Remove-Item -Recurse $dir",
    "Remove-Item -Recurse $dir.bak\\x",
    "rm -rf build",
    "ri -r x",
    "rd /s /q build",
    "del /s /q build\\*.o",
  ])("%s is held for review", (command) => expect(classOf(command)).toBe("advisory"));

  test("a removal names its targets, with quotes and commas read as PowerShell reads them", () => {
    expect(classify("Remove-Item -Recurse -Force 'my build', dist -ErrorAction Stop -Include *.o", PS)).toEqual({
      kind: "advisory",
      removals: [{ targets: ["my build", "dist"] }],
      git: [],
    });
    expect(classify("Remove-Item -Path a, b -Recurse -Filter *.o", PS)).toEqual({
      kind: "advisory",
      removals: [{ targets: ["a", "b"] }],
      git: [],
    });
  });

  test("a removal is reported for each statement in command order", () => {
    expect(classify("Remove-Item -Recurse a; if ($x) { rm -r b }", PS)).toEqual({
      kind: "advisory",
      removals: [{ targets: ["a"] }, { targets: ["b"] }],
      git: [],
    });
  });
});

describe("home, the working directory and its parents", () => {
  test.each([
    ["Remove-Item -Recurse -Force C:\\Users\\x", "catastrophic"],
    ["Remove-Item -Recurse -Force C:\\Users\\x\\*", "catastrophic"],
    ["Remove-Item -Recurse c:/users/X", "catastrophic"],
    ["Remove-Item -Recurse C:\\Users\\x\\Documents", "catastrophic"],
    ["Remove-Item -Recurse C:\\Users\\x\\proj", "catastrophic"],
    ["Remove-Item -Recurse C:\\Users\\x\\proj\\sub\\..", "catastrophic"],
    ["rd /s /q C:\\Users\\x\\proj\\", "catastrophic"],
    ["Remove-Item -Recurse C:\\Users\\x\\proj\\build", "advisory"],
    ["Remove-Item -Recurse C:\\Users\\x\\Documents\\old", "advisory"],
    ["Remove-Item -Recurse C:\\Users\\xavier", "advisory"],
    ["Remove-Item -Recurse D:\\Users\\x", "advisory"],
  ])("%s is %s", (command, expected) => expect(classOf(command, SESSION)).toBe(expected));

  test("without a session, a home spelling stays held for review", () => {
    expect(classOf("Remove-Item -Recurse -Force C:\\Users\\x")).toBe("advisory");
  });
});

describe("git", () => {
  test.each([
    ["git reset --hard", "reset --hard"],
    ["git.exe reset --hard", "reset --hard"],
    ["GIT.EXE reset --hard", "reset --hard"],
    ["& git stash", "stash"],
    ['& "C:\\Program Files\\Git\\cmd\\git.exe" reset --hard', "reset --hard"],
    ["& 'C:\\Program Files\\Git\\cmd\\git.exe' clean -fd", "clean"],
    ['"C:\\Program Files\\Git\\cmd\\git.exe" restore .', "restore"],
    ['git -C "C:\\My Repo" reset --hard', "reset --hard"],
    ["git -C 'C:\\My Repo' stash", "stash"],
    ['git --git-dir "C:\\My Repo\\.git" clean -fdx', "clean"],
    ['git --work-tree="C:\\My Repo" checkout -- .', "checkout --"],
    ["git status; git reset --hard", "reset --hard"],
    ["if ($dirty) { git stash }", "stash"],
    ["Get-Date | Out-Null; git clean -fd", "clean"],
    ["cmd /c git reset --hard", "reset --hard"],
    ['cmd /c "git reset --hard"', "reset --hard"],
    ["git rm -rf .", "rm -r"],
  ] as const)("%s is blocking", (command, operation) =>
    expect(classify(command, PS)).toEqual({ kind: "blocking", removals: [], git: [{ operation }] }),
  );

  test("a force push is advisory and a blocking operation outranks it", () => {
    expect(classify("git.exe push --force origin main", PS)).toEqual({
      kind: "advisory",
      removals: [],
      git: [{ operation: "push --force", remote: "origin", branch: "main" }],
    });
    expect(classOf("git push -f; git stash")).toBe("blocking");
  });

  test.each([
    "git status",
    "git.exe log --oneline",
    '& "C:\\Program Files\\Git\\cmd\\git.exe" diff',
    'git -C "C:\\My Repo" status',
    "git push origin main",
  ])("%s is not a match", (command) => expect(classOf(command)).toBe("none"));
});

describe("a mention is not the command running", () => {
  test.each([
    "# Remove-Item -Recurse C:\\",
    "Get-Date # Remove-Item -Recurse C:\\",
    "<# Remove-Item -Recurse C:\\ #>\nGet-Date",
    "<# one\nRemove-Item -Recurse C:\\\n#>\nGet-Date",
    "Write-Host 'Remove-Item -Recurse C:\\'",
    'Write-Host "Remove-Item -Recurse C:\\"',
    'Write-Output "rm -rf /"',
    "Write-Output 'x; Remove-Item -Recurse C:\\'",
    'Write-Host "cmd /c rd /s /q C:\\"',
    'Write-Host "cmd /c git reset --hard"',
    'git commit -m "never run Remove-Item -Recurse C:\\"',
    "git commit -m 'drop git reset --hard from the flow'",
    "git commit -m 'it''s fine; Remove-Item -Recurse C:\\'",
    'git log --grep "git stash"',
    "@'\nRemove-Item -Recurse C:\\\ngit reset --hard\n'@ | Set-Content clean.ps1",
    "@'\nit's a body\nRemove-Item -Recurse C:\\\n'@ | Set-Content clean.ps1",
    '@"\nRemove-Item -Recurse C:\\\n"@ | Set-Content clean.ps1',
    "Select-String -Pattern 'Remove-Item -Recurse' -Path *.ps1",
    "Get-Content C:\\Remove-Item",
  ])("%s", (command) => expect(classOf(command)).toBe("none"));

  test("the same text as a command is caught, next to its controls", () => {
    expect(classOf("Remove-Item -Recurse C:\\")).toBe("catastrophic");
    expect(classOf("Write-Host 'x'; Remove-Item -Recurse C:\\")).toBe("catastrophic");
    expect(classOf("@'\nbody\n'@ | Set-Content x.ps1\nRemove-Item -Recurse C:\\")).toBe("catastrophic");
    expect(classOf("Remove-Item -Recurse a <# note #>\nRemove-Item -Recurse C:\\")).toBe("catastrophic");
    expect(classOf("Get-Date # note\nRemove-Item -Recurse C:\\")).toBe("catastrophic");
    expect(classOf("Write-Host \"$(Get-Date)\"; git stash")).toBe("blocking");
    expect(classOf("git commit -m 'x'; git reset --hard")).toBe("blocking");
    expect(classOf('@"\nbody\n"@ | Set-Content x.ps1\ngit stash')).toBe("blocking");
  });

  test("a hash inside a token is not a comment", () => {
    expect(classOf("Remove-Item -Recurse C:\\a#b; Remove-Item -Recurse C:\\")).toBe("catastrophic");
  });
});

describe("neutralizePowershell", () => {
  test("blanks command positions inside quotes and whole comments, keeping the length", () => {
    const command = `Write-Host "a; b | (c) {d}" 'e $(f) g;h' # i; j\nk <# l ; m #> n`;
    const out = neutralizePowershell(command);
    expect(out).toBe(`Write-Host "a_ b _ _c_ _d_" 'e __f_ g_h' ______\nk ___________ n`);
    expect(out).toHaveLength(command.length);
  });

  test("a backtick escapes a quote and a doubled single quote stays inside the span", () => {
    expect(neutralizePowershell('"a`"; b" ; c')).toBe('"a`"_ b" ; c');
    expect(neutralizePowershell("'it''s;x' ; c")).toBe("'it''s_x' ; c");
  });

  test("a here-string ends at its terminator line and keeps the length", () => {
    const command = "@'\na ' b ; c\n'@ ; d\n";
    const out = neutralizePowershell(command);
    expect(out).toBe("@'___________'@ ; d\n");
    expect(out).toHaveLength(command.length);
  });

  test("an unterminated here-string hides the rest, as PowerShell reads it", () => {
    expect(neutralizePowershell("@'\nx; y")).toBe("@'_____");
  });
});

describe("powershellWords", () => {
  test("splits on white space and commas, drops quotes, and reads backtick and doubled quotes", () => {
    expect(powershellWords(` a "b c" 'd''e' f,g "h""i" j\`k l\`  m "" `)).toEqual([
      "a",
      "b c",
      "d'e",
      "f",
      "g",
      'h"i',
      "jk",
      "l ",
      "m",
      "",
    ]);
  });

  test("a backslash is a path separator, not an escape", () => {
    expect(powershellWords('C:\\a\\ b "C:\\My Repo\\"')).toEqual(["C:\\a\\", "b", "C:\\My Repo\\"]);
  });
});
