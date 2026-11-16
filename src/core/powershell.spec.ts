import { describe, expect, test } from "bun:test";
import { classify, type Context } from "./destructive.ts";
import { neutralizePowershell, powershellRemovals, powershellWords } from "./powershell.ts";
import { SESSION_STATE } from "./shell-state.ts";

const PS: Context = { shell: "powershell" };
const SESSION: Context = { shell: "powershell", home: "C:\\Users\\x", cwd: "C:\\Users\\x\\proj", root: "C:\\Users\\x\\proj" };

/** `catastrophic`, `removal` for one that runs, `denied` for a git rule's outright deny, `checked` for a whole-tree git operation, else `none`. */
const classOf = (command: string, ctx: Context = PS) => {
  const finding = classify(command, ctx);
  if (finding === undefined || finding.kind !== "git") return finding?.kind ?? "none";
  if (finding.reason !== undefined) return "denied";
  return finding.checks.length > 0 ? "checked" : "none";
};
const operationsOf = (command: string) => {
  const finding = classify(command, PS);
  return finding?.kind === "git" ? finding.checks.map((check) => check.operation) : finding?.kind;
};
const targetsOf = (command: string) => powershellRemovals(command, neutralizePowershell(command), () => SESSION_STATE).map((removal) => removal.targets);

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
    expect(targetsOf("rd /s /q build\\out")).toEqual([["build\\out"]]);
    expect(classOf("cmd /c rd /s /q build\\out")).toBe("removal");
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
  ])("%s runs", (command) => expect(classOf(command)).toBe("removal"));

  test("a removal names its targets, with quotes and commas read as PowerShell reads them", () => {
    expect(targetsOf("Remove-Item -Recurse -Force 'my build', dist -ErrorAction Stop -Include *.o")).toEqual([["my build", "dist"]]);
    expect(targetsOf("Remove-Item -Path a, b -Recurse -Filter *.o")).toEqual([["a", "b"]]);
  });

  test("a removal is reported for each statement in command order", () => {
    expect(targetsOf("Remove-Item -Recurse a; if ($x) { rm -r b }")).toEqual([["a"], ["b"]]);
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
    ["Remove-Item -Recurse C:\\Users\\x\\proj\\build", "removal"],
    ["Remove-Item -Recurse C:\\Users\\x\\Documents\\old", "removal"],
    ["Remove-Item -Recurse C:\\Users\\xavier", "removal"],
    ["Remove-Item -Recurse D:\\Users\\x", "removal"],
  ])("%s is %s", (command, expected) => expect(classOf(command, SESSION)).toBe(expected));

  test("without a session, a home spelling runs", () => {
    expect(classOf("Remove-Item -Recurse -Force C:\\Users\\x")).toBe("removal");
  });
});

describe("git", () => {
  test.each([
    ["git reset --hard", "git reset --hard"],
    ["git.exe reset --hard", "git reset --hard"],
    ["GIT.EXE reset --hard", "git reset --hard"],
    ["& git stash drop", "git stash drop"],
    ['& "C:\\Program Files\\Git\\cmd\\git.exe" reset --hard', "git reset --hard"],
    ["& 'C:\\Program Files\\Git\\cmd\\git.exe' clean -fd", "git clean"],
    ['"C:\\Program Files\\Git\\cmd\\git.exe" restore .', "git restore ."],
    ['git -C "C:\\My Repo" reset --hard', "git reset --hard"],
    ["git -C 'C:\\My Repo' stash clear", "git stash clear"],
    ['git --git-dir "C:\\My Repo\\.git" clean -fdx', "git clean"],
    ['git --work-tree="C:\\My Repo" checkout -- .', "git checkout ."],
    ["git status; git reset --hard", "git reset --hard"],
    ["if ($dirty) { git stash drop }", "git stash drop"],
    ["Get-Date | Out-Null; git clean -fd", "git clean"],
    ["cmd /c git reset --hard", "git reset --hard"],
    ['cmd /c "git reset --hard"', "git reset --hard"],
  ] as const)("%s is checked against the repository", (command, operation) => expect(operationsOf(command)).toEqual([operation]));

  test.each(["git stash", "git stash pop", "git rm -rf .", "git checkout -- src", "git restore src\\a.ts"])("%s runs", (command) =>
    expect(classOf(command)).toBe("none"),
  );

  test("a force push to another branch runs, and a whole-tree operation beside it is still checked", () => {
    expect(classify("git.exe push --force origin dev", PS)).toEqual({ kind: "git", checks: [], isForcePush: true });
    expect(classOf("git push -f; git reset --hard")).toBe("checked");
  });

  test("a force push to the default branch is denied, by name, by origin/HEAD or as the checked-out branch", () => {
    expect(classOf("git.exe push --force origin main")).toBe("denied");
    expect(classOf("& git push origin +main")).toBe("denied");
    expect(classOf("git push --force-with-lease origin master")).toBe("denied");
    expect(classOf("git push -f", { shell: "powershell", branch: "main" })).toBe("denied");
    expect(classOf("git push -f", { shell: "powershell", branch: "dev" })).toBe("none");
    expect(classOf("git push -f origin trunk", { shell: "powershell", defaultBranch: "trunk" })).toBe("denied");
    expect(classOf("git push -f origin main", { shell: "powershell", defaultBranch: "trunk" })).toBe("none");
  });

  test("a commit that skips its hooks is denied, and a message naming the flag is not", () => {
    expect(classOf("git commit --no-verify -m 'x'")).toBe("denied");
    expect(classOf("git.exe commit -nm 'x'")).toBe("denied");
    expect(classOf("git commit -m 'skip -n and --no-verify'")).toBe("none");
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
    expect(classOf("Write-Host \"$(Get-Date)\"; git stash drop")).toBe("checked");
    expect(classOf("git commit -m 'x'; git reset --hard")).toBe("checked");
    expect(classOf('@"\nbody\n"@ | Set-Content x.ps1\ngit stash drop')).toBe("checked");
  });

  test("a hash inside a token is not a comment", () => {
    expect(classOf("Remove-Item -Recurse C:\\a#b; Remove-Item -Recurse C:\\")).toBe("catastrophic");
  });
});

describe("a subexpression inside double quotes", () => {
  test.each([
    'Write-Host "$(Remove-Item -Recurse C:\\)"',
    'Write-Host "$(Remove-Item -Recurse ~)"',
    '"$(Remove-Item -Recurse ~)"',
    'Write-Host "before $(rm -r C:\\) after"',
    'Write-Host "$(Get-Date; Remove-Item -Recurse C:\\)"',
    'Write-Host "$(Get-Date -Format "$(Remove-Item -Recurse C:\\)")"',
    '$x = "$(Remove-Item -Recurse $HOME)"',
    '@"\n$(Remove-Item -Recurse C:\\)\n"@ | Set-Content x.ps1',
    '@"\nbody $(rm -r ~) body\n"@',
    'Remove-Item -Recurse "$(Get-Location)"',
    'Write-Host "$((1 + 2))"; Remove-Item -Recurse C:\\',
  ])("%s is catastrophic", (command) => expect(classOf(command)).toBe("catastrophic"));

  test.each([
    ['Write-Host "$(git stash drop)"', "git stash drop"],
    ['git commit -m "$(git clean -fd)"', "git clean"],
    ['@"\n$(git reset --hard)\n"@', "git reset --hard"],
  ] as const)("%s is checked against the repository", (command, operation) => expect(operationsOf(command)).toEqual([operation]));

  test("a mention beside a subexpression, or in a single-quoted string, is not a match", () => {
    expect(classOf("Write-Host '$(Remove-Item -Recurse C:\\)'")).toBe("none");
    expect(classOf("Write-Host 'a $(rm -r ~) b'")).toBe("none");
    expect(classOf("@'\n$(Remove-Item -Recurse C:\\)\n'@")).toBe("none");
    expect(classOf('Write-Host "`$(Remove-Item -Recurse C:\\)"')).toBe("none");
    expect(classOf('@"\n`$(Remove-Item -Recurse C:\\)\n"@')).toBe("none");
    expect(classOf('Write-Host "$(Get-Date)" "; Remove-Item -Recurse C:\\"')).toBe("none");
    expect(classOf('Write-Host "$(Get-Date)" "Remove-Item -Recurse C:\\"')).toBe("none");
    expect(classOf('Write-Host "$((1 + 2))" "(rm -r ~)"')).toBe("none");
    expect(classOf('git commit -m "fix $(Get-Date): never Remove-Item -Recurse C:\\"')).toBe("none");
    expect(classOf('Write-Host "$(Write-Host "a; Remove-Item -Recurse C:\\")"')).toBe("none");
  });

  test("a subexpression that runs something harmless is not a match", () => {
    expect(classOf('Write-Host "$(Get-Date)"')).toBe("none");
    expect(classOf('Write-Host "$(Get-ChildItem C:\\ -Recurse)"')).toBe("none");
    expect(classOf('git commit -m "release $(git describe --tags)"')).toBe("none");
  });

  test("the neutralized text leaves a subexpression as a command and keeps the length", () => {
    const command = `Write-Host "a; $(b; c) (d)" 'e $(f)' "\`$(g)"`;
    const out = neutralizePowershell(command);
    expect(out).toBe(`Write-Host "a_ $(b; c) _d_" 'e __f_' "\`$_g_"`);
    expect(out).toHaveLength(command.length);
  });
});

describe("-WhatIf", () => {
  test.each([
    "Remove-Item -Recurse -Force C:\\ -WhatIf",
    "Remove-Item -WhatIf -Recurse C:\\",
    "Remove-Item -Recurse C:\\ -whatif",
    "Remove-Item -Recurse C:\\ -wh",
    "Remove-Item -Recurse C:\\ -wha",
    "Remove-Item -Recurse C:\\ -WhatIf:$true",
    "Remove-Item -Recurse -Path C:\\ -WhatIf",
    "Remove-Item -Recurse $HOME -WhatIf",
    "rm -r -WhatIf C:\\",
    "ri -Recurse -wh ~",
    "del -Recurse -WhatIf C:\\",
    "Remove-Item -Recurse build -WhatIf",
    'Write-Host "$(Remove-Item -Recurse C:\\ -WhatIf)"',
  ])("%s is a dry run, not a removal", (command) => expect(classOf(command)).toBe("none"));

  test.each([
    ["Remove-Item -Recurse C:\\", "catastrophic"],
    ["Remove-Item -Recurse C:\\ -WhatIf:$false", "catastrophic"],
    ["Remove-Item -Recurse C:\\ -WhatIf:$False", "catastrophic"],
    ["Remove-Item -Recurse -WhatIf:$false C:\\", "catastrophic"],
    ["Remove-Item -Recurse C:\\ -w", "catastrophic"],
    ["Remove-Item -Recurse C:\\ -Wi", "catastrophic"],
    ["Remove-Item -Recurse C:\\ -Confirm", "catastrophic"],
    ["Remove-Item -Recurse -Path C:\\ -Include -WhatIf", "catastrophic"],
    ["Remove-Item -Recurse a -WhatIf; Remove-Item -Recurse C:\\", "catastrophic"],
    ["Remove-Item -Recurse C:\\ -WhatIf; Remove-Item -Recurse C:\\", "catastrophic"],
    ["Remove-Item -Recurse build -WhatIf:$false", "removal"],
    ["Remove-Item -Recurse build", "removal"],
  ])("%s is %s", (command, expected) => expect(classOf(command)).toBe(expected));

  test("a dry run beside a real removal reports only the real one", () => {
    expect(targetsOf("Remove-Item -Recurse a -WhatIf; Remove-Item -Recurse b")).toEqual([["b"]]);
  });

  test("a mention of -WhatIf in another command does not excuse the removal", () => {
    expect(classOf("Write-Host -WhatIf; Remove-Item -Recurse C:\\")).toBe("catastrophic");
    expect(classOf("Remove-Item -Recurse C:\\ # -WhatIf")).toBe("catastrophic");
  });
});

describe("a relative target", () => {
  test.each([
    ["Remove-Item -Recurse ..\\proj", "catastrophic"],
    ["Remove-Item -Recurse ..\\proj\\", "catastrophic"],
    ["Remove-Item -Recurse -Path .\\..\\proj", "catastrophic"],
    ["Remove-Item -Recurse ../proj", "catastrophic"],
    ["Remove-Item -Recurse ..", "catastrophic"],
    ["Remove-Item -Recurse .\\build", "removal"],
    ["Remove-Item -Recurse build\\out", "removal"],
    ["Remove-Item -Recurse -Force .\\proj", "removal"],
    ["Remove-Item -Recurse ..\\proj\\build", "removal"],
  ])("from the project root, %s is %s", (command, expected) => expect(classOf(command, SESSION)).toBe(expected));

  test("without a working directory a relative path runs", () => {
    expect(classOf("Remove-Item -Recurse ..\\proj")).toBe("removal");
  });
});

describe("the working directory named as a variable or a subexpression", () => {
  const NO_CWD: Context = { shell: "powershell", home: "C:\\Users\\x" };

  test.each([
    "Remove-Item -Recurse $PWD\\build",
    "Remove-Item -Recurse $pwd\\build",
    "Remove-Item -Recurse $PWD/build",
    "Remove-Item -Recurse ${PWD}\\build",
    'Remove-Item -Recurse "$PWD\\build"',
    "Remove-Item -Recurse (Get-Location)\\build",
    "Remove-Item -Recurse (get-location)\\build",
    "Remove-Item -Recurse $(Get-Location)\\build",
    'Remove-Item -Recurse "$(Get-Location)\\build"',
    "Remove-Item -Recurse (pwd)\\build",
    "Remove-Item -Recurse $(pwd)\\build\\out",
    "Remove-Item -Recurse -Path $PWD\\build -Force",
    "Remove-Item -Recurse $PWD\\build\\*",
    "rm -r $PWD\\build",
    "rd /s /q $PWD\\build",
  ])("%s runs whether or not the working directory is known", (command) => {
    expect(classOf(command, SESSION)).toBe("removal");
    expect(classOf(command, NO_CWD)).toBe("removal");
    expect(classOf(command)).toBe("removal");
  });

  test.each([
    "Remove-Item -Recurse $PWD",
    "Remove-Item -Recurse $pwd",
    "Remove-Item -Recurse ${PWD}",
    'Remove-Item -Recurse "$PWD"',
    "Remove-Item -Recurse (Get-Location)",
    "Remove-Item -Recurse $(Get-Location)",
    "Remove-Item -Recurse (pwd)",
    "Remove-Item -Recurse $PWD\\..",
    "Remove-Item -Recurse (Get-Location)\\..\\..",
    "Remove-Item -Recurse $PWD\\*",
    "Remove-Item -Recurse -Force $(Get-Location)\\*",
    "ri -r $PWD",
  ])("%s is the working directory or a parent, so it is catastrophic", (command) => {
    expect(classOf(command, SESSION)).toBe("catastrophic");
    expect(classOf(command, NO_CWD)).toBe("catastrophic");
    expect(classOf(command)).toBe("catastrophic");
  });

  test("another subexpression in the target is still unknown, and a variable that only starts with PWD is not it", () => {
    expect(classOf('Remove-Item -Recurse "$(Get-Location)$(Get-Date)"', SESSION)).toBe("catastrophic");
    expect(classOf("Remove-Item -Recurse $(Split-Path $PWD)\\build", SESSION)).toBe("catastrophic");
    expect(classOf("Remove-Item -Recurse $PWDX\\build", SESSION)).toBe("catastrophic");
  });

  test("a mention of the working directory in a quoted string is not a removal", () => {
    expect(classOf("Write-Host 'Remove-Item -Recurse $PWD'", SESSION)).toBe("none");
    expect(classOf('Write-Host "Remove-Item -Recurse $PWD"', SESSION)).toBe("none");
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

describe("a nested command", () => {
  test.each([
    'pwsh -Command "Remove-Item -Recurse C:\\"',
    "pwsh -c 'Remove-Item -Recurse $HOME'",
    "pwsh.exe -NoProfile -NonInteractive -Command Remove-Item -Recurse C:\\",
    "pwsh -Comm 'ri -r ~'",
    'powershell -Command "Remove-Item -Recurse -Force C:\\Windows"',
    "powershell.exe -c rm -r C:\\",
    '& "C:\\Program Files\\PowerShell\\7\\pwsh.exe" -c "Remove-Item -Recurse C:\\"',
    'cmd /c "cd build && rd /s /q C:\\"',
    "cmd /d /c rd /s /q C:\\",
    'cmd.exe /C "del /s /q C:\\*"',
    'Invoke-Expression "Remove-Item -Recurse C:\\"',
    "iex 'Remove-Item -Recurse $HOME'",
    "Invoke-Expression -Command 'rd /s /q C:\\'",
    "bash -c 'rm -rf ~'",
    "wsl.exe; sh -c 'rm -rf /'",
    "pwsh -c \"cmd /c 'rd /s /q C:\\'\"",
  ])("%s is catastrophic", (command) => expect(classOf(command)).toBe("catastrophic"));

  test.each([
    ["pwsh -c 'git reset --hard'", "git reset --hard"],
    ['cmd /c "git stash drop && echo done"', "git stash drop"],
    ["iex 'git clean -fdx'", "git clean"],
  ] as const)("%s is checked against the repository", (command, operation) => expect(operationsOf(command)).toEqual([operation]));

  test("a commit that skips its hooks inside bash is denied", () => expect(classOf("bash -c 'git commit -n -m x'")).toBe("denied"));

  test("a force push to the default branch inside pwsh or cmd is denied", () => {
    expect(classOf("pwsh -c 'git push -f origin main'")).toBe("denied");
    expect(classOf('cmd /c "git push --force origin master"')).toBe("denied");
    expect(classOf("pwsh -c 'git push -f origin dev'")).toBe("none");
  });

  test("a removal of a deeper path inside pwsh or cmd runs", () => {
    expect(classOf('cmd /c rd /s /q "C:\\My Dir\\build"')).toBe("removal");
    expect(classOf("pwsh -c 'Remove-Item -Recurse build, dist'")).toBe("removal");
  });

  test.each([
    'Write-Host "pwsh -c \'Remove-Item -Recurse C:\\\'"',
    "Write-Host 'iex \"Remove-Item -Recurse C:\\\"'",
    "# cmd /c rd /s /q C:\\",
    "pwsh -File clean.ps1 -c 'Remove-Item -Recurse C:\\'",
    "pwsh -c 'Write-Host \"Remove-Item -Recurse C:\\\"'",
    "iex $command",
    "Invoke-Expression (Get-Content clean.ps1 -Raw)",
    "cmd /c dir C:\\",
  ])("%s runs nothing destructive", (command) => expect(classOf(command)).toBe("none"));
});

describe("a variable the command assigns", () => {
  const VARIABLE = (variable: string, target: string, empty: string) =>
    `Destructive rm -rf blocked: the target starts with a variable that can be unset or empty when the rm runs: ${variable}. Then ${target} is ${empty}. Assign ${variable} in a statement of its own before the removal, or name the path explicitly.`;
  const reasonOf = (command: string) => {
    const finding = classify(command, SESSION);
    return finding?.kind === "catastrophic" ? finding.reason : finding?.kind;
  };

  test.each([
    "$S = 'C:\\Users\\x\\.cache\\tmp\\x'; Remove-Item -Recurse -Force $S\\root",
    '$s = "C:\\Users\\x\\.cache\\tmp"; Remove-Item -Recurse "$S\\x"',
    "$env:OUT = 'D:\\build\\out'; Remove-Item -Recurse $env:OUT\\obj",
    "$S = 'C:\\work\\a'\nRemove-Item -Recurse ${S}\\b",
    "$S = 'C:\\work\\a'; foreach ($d in 1, 2) { Remove-Item -Recurse $S\\b }",
  ])("%s runs", (command) => expect(reasonOf(command)).toBe("removal"));

  test.each([
    ["Remove-Item -Recurse $S\\x", "$S", "$S\\x", "\\x"],
    ["$S = Get-Thing; Remove-Item -Recurse $S\\x", "$S", "$S\\x", "\\x"],
    ["$S = ''; Remove-Item -Recurse $S\\x", undefined, "", ""],
    ["$S = 'C:\\a'; if ($c) { $S = $null }; Remove-Item -Recurse $S\\x", "$S", "$S\\x", "\\x"],
    ["$S = 'C:\\a'; foreach ($d in 1, 2) { Remove-Item -Recurse $S\\x; $S = '' }", "$S", "$S\\x", "\\x"],
    ["$S = 'C:\\a' | Out-Null; Remove-Item -Recurse $S\\x", "$S", "$S\\x", "\\x"],
  ])("%s is denied", (command, variable, target, empty) =>
    expect(reasonOf(command)).toBe(
      variable === undefined
        ? "Destructive rm -rf blocked: the target is the filesystem root, home, the working directory, or a directory directly under root or home. Name a deeper path explicitly."
        : VARIABLE(variable, target, empty),
    ),
  );

  test("a redirection is not a target", () => {
    expect(targetsOf("Remove-Item -Recurse build 2>$null")).toEqual([["build"]]);
    expect(targetsOf("Remove-Item -Recurse build *> out.log")).toEqual([["build"]]);
    expect(targetsOf("Remove-Item -Recurse build 2>&1")).toEqual([["build"]]);
  });
});
