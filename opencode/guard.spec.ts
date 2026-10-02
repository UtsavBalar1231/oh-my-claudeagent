import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { checkEdit, checkShell } from "./guard.ts"

const RM_CATASTROPHIC =
  "Destructive rm -rf blocked: the target is the filesystem root, home, the working directory, or a directory directly under root or home. Name a deeper path explicitly."
const GIT =
  "Destructive git command blocked. If working tree is dirty, REPORT and STOP — never modify history. Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing."

let tmp: string
let errorSpy: ReturnType<typeof spyOn>
const savedEnv = {
  OMCA_COMMENT_GATE: process.env.OMCA_COMMENT_GATE,
  OMCA_DISABLED_HOOKS: process.env.OMCA_DISABLED_HOOKS,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
}

beforeEach(() => {
  delete process.env.OMCA_COMMENT_GATE
  delete process.env.OMCA_DISABLED_HOOKS
  tmp = mkdtempSync(join(tmpdir(), "omca-guard-"))
  errorSpy = spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(tmp, { recursive: true, force: true })
})

describe("decisions", () => {
  test("a hard reset is denied with the git reason", () => {
    expect(checkShell("git reset --hard HEAD~1")).toEqual({ deny: true, reason: GIT })
  })

  test("git status is allowed", () => {
    expect(checkShell("git status")).toEqual({ deny: false })
  })

  test("a recursive removal of /home is denied as catastrophic", () => {
    expect(checkShell("rm -rf /home")).toEqual({ deny: true, reason: RM_CATASTROPHIC })
  })

  test("an advisory match runs, since there is no dialog to hold it in", () => {
    expect(checkShell("rm -rf build")).toEqual({ deny: false })
    expect(checkShell("git push --force origin main")).toEqual({ deny: false })
  })

  test("a blocking match alongside an advisory one is denied with the git reason", () => {
    expect(checkShell("rm -rf build && git stash")).toEqual({ deny: true, reason: GIT })
  })

  test("a quoted mention of a destructive command is allowed", () => {
    expect(checkShell('git commit -m "stop using rm -rf / and git reset --hard"')).toEqual({ deny: false })
  })

  test("bash-guard in OMCA_DISABLED_HOOKS turns off the git deny, never the catastrophic one", () => {
    process.env.OMCA_DISABLED_HOOKS = "verification-recorder,bash-guard"
    expect(checkShell("git reset --hard")).toEqual({ deny: false })
    expect(checkShell("rm -rf ~")).toEqual({ deny: true, reason: RM_CATASTROPHIC })
  })

  test("the working directory and its parents are denied, a path below it runs", () => {
    const cwd = process.cwd()
    const denied = { deny: true, reason: RM_CATASTROPHIC }
    expect(checkShell(`rm -rf ${cwd}`)).toEqual(denied)
    expect(checkShell(`rm -rf ${cwd}/*`)).toEqual(denied)
    expect(checkShell(`rm -rf ${dirname(cwd)}`)).toEqual(denied)
    expect(checkShell(`rm -rf ${cwd}/build/out`)).toEqual({ deny: false })
  })

  test("home is read from the environment, in any spelling", () => {
    process.env.HOME = "/home/bob"
    process.env.USERPROFILE = "/home/bob"
    const denied = { deny: true, reason: RM_CATASTROPHIC }
    expect(checkShell("rm -rf /home/bob")).toEqual(denied)
    expect(checkShell("rm -rf /home/bob/dev")).toEqual(denied)
    expect(checkShell("rm -rf $USERPROFILE")).toEqual(denied)
    expect(checkShell("rm -rf /home/bob/dev/x")).toEqual({ deny: false })
  })

  test("drive roots and Git Bash mounts are denied, and an always-set variable is not", () => {
    const denied = { deny: true, reason: RM_CATASTROPHIC }
    expect(checkShell("rm -rf C:\\")).toEqual(denied)
    expect(checkShell("rm -rf /c")).toEqual(denied)
    expect(checkShell("rm -rf /c/Users")).toEqual(process.platform === "win32" ? denied : { deny: false })
    expect(checkShell("rm -rf //srv/share")).toEqual(denied)
    expect(checkShell('rm -rf "$TMPDIR/foo"')).toEqual({ deny: false })
  })

  test("git behind an .exe suffix or a path is denied, and a quoted heredoc body is not a command", () => {
    expect(checkShell("git.exe reset --hard")).toEqual({ deny: true, reason: GIT })
    expect(checkShell('"C:\\Program Files\\Git\\cmd\\git.exe" stash')).toEqual({ deny: true, reason: GIT })
    expect(checkShell("cat <<'EOF'\nrm -rf /\ngit reset --hard\nEOF")).toEqual({ deny: false })
    expect(checkShell("cat <<'EOF'\nnotes\nEOF\nrm -rf /")).toEqual({ deny: true, reason: RM_CATASTROPHIC })
  })

  test("a write to a new file is allowed", () => {
    expect(checkEdit("write", { path: join(tmp, "new.txt"), content: "hi" }, tmp)).toEqual({ deny: false })
    expect(errorSpy).toHaveBeenCalledTimes(0)
  })
})

describe("the comment gate", () => {
  const RESTATES = 'Comment restates the following code line ("set the user name"): delete it, or replace it with the non-obvious why.'
  const slop = '# set the user name\nuser_name="$input_value"'

  test("a restating comment in a written file is denied when the gate is deny", () => {
    process.env.OMCA_COMMENT_GATE = "deny"
    const result = checkEdit("write", { path: "/repo/scripts/denied.sh", content: slop }, tmp)
    expect(result).toEqual({ deny: true, reason: expect.stringContaining(`Blocked: comment slop. ${RESTATES} The convention:`) })
    expect(errorSpy).toHaveBeenCalledTimes(0)
  })

  test("the same finding in the same file passes on the retry and is denied again after", () => {
    process.env.OMCA_COMMENT_GATE = "deny"
    const attempt = () => checkEdit("write", { path: "/repo/scripts/retried.sh", content: slop }, tmp).deny
    expect([attempt(), attempt(), attempt()]).toEqual([true, false, true])
  })

  test("an attribution comment is denied on every attempt", () => {
    process.env.OMCA_COMMENT_GATE = "deny"
    const attempt = () => checkEdit("edit", { path: "/repo/a.py", newString: "# AI-generated helper\nx = 1" }, tmp)
    const denied = { deny: true, reason: expect.stringContaining("Blocked: AI-attribution or placeholder comment. AI attribution comment detected.") }
    expect(attempt()).toEqual(denied)
    expect(attempt()).toEqual(denied)
  })

  test("a restating comment in a source-file patch is denied", () => {
    process.env.OMCA_COMMENT_GATE = "deny"
    const patchText = `*** Begin Patch\n*** Add File: scripts/patched.sh\n+# set the user name\n+user_name="$input_value"\n*** End Patch`
    expect(checkEdit("patch", { patchText }, tmp)).toEqual({ deny: true, reason: expect.stringContaining(RESTATES) })
    expect(errorSpy).toHaveBeenCalledTimes(0)
  })

  test("a patch is judged one file at a time, so a Markdown section does not hide a source section", () => {
    process.env.OMCA_COMMENT_GATE = "deny"
    const patchText = [
      "*** Begin Patch",
      "*** Add File: a.md",
      "+# Install",
      "+Install it",
      "*** Add File: sections.py",
      "+# AI-generated helper",
      "+x = 1",
      "*** End Patch",
    ].join("\n")
    expect(checkEdit("patch", { patchText }, tmp)).toEqual({ deny: true, reason: expect.stringContaining("AI attribution comment detected.") })
  })

  test("a Markdown patch section is skipped", () => {
    process.env.OMCA_COMMENT_GATE = "deny"
    const patchText = "*** Begin Patch\n*** Add File: a.md\n+# Install\n+Install it\n*** End Patch"
    expect(checkEdit("patch", { patchText }, tmp)).toEqual({ deny: false })
    expect(errorSpy).toHaveBeenCalledTimes(0)
  })

  test("the advise and off levels allow a write the deny level would block", () => {
    const input = { path: "/repo/a.py", content: "# AI-generated helper\nx = 1" }
    for (const level of [undefined, "advise", "off"]) {
      if (level === undefined) delete process.env.OMCA_COMMENT_GATE
      else process.env.OMCA_COMMENT_GATE = level
      expect(checkEdit("write", input, tmp)).toEqual({ deny: false })
    }
  })

  test("comment-gate in OMCA_DISABLED_HOOKS allows a write the gate would deny", () => {
    process.env.OMCA_COMMENT_GATE = "deny"
    const input = { path: "/repo/a.py", content: "# AI-generated helper\nx = 1" }
    expect(checkEdit("write", input, tmp).deny).toBe(true)
    process.env.OMCA_DISABLED_HOOKS = "comment-gate"
    expect(checkEdit("write", input, tmp)).toEqual({ deny: false })
  })

  test("a tool that writes no file is allowed", () => {
    process.env.OMCA_COMMENT_GATE = "deny"
    expect(checkEdit("read", { path: "/repo/a.py", content: "# AI-generated helper" }, tmp)).toEqual({ deny: false })
  })
})
