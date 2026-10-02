import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkEdit, checkShell, runGuard } from "./guard.ts"

const root = join(import.meta.dir, "..")

const RM_CATASTROPHIC =
  "Destructive rm -rf blocked: the target is the filesystem root, home, the working directory, or a directory directly under root or home. Name a deeper path explicitly."
const GIT =
  "Destructive git command blocked. If working tree is dirty, REPORT and STOP — never modify history. Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing."

let tmp: string
let errorSpy: ReturnType<typeof spyOn>
const savedEnv = {
  OMCA_COMMENT_GATE: process.env.OMCA_COMMENT_GATE,
  OMCA_DISABLED_HOOKS: process.env.OMCA_DISABLED_HOOKS,
}

beforeEach(() => {
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

const opts = () => ({ cwd: tmp, projectRoot: tmp })

function tempScript(body: string) {
  const file = join(tmp, "guard.sh")
  writeFileSync(file, `#!/bin/bash\n${body}\n`)
  return file
}

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

  test("a write to a new file is allowed", async () => {
    expect(await checkEdit(root, "write", { path: join(tmp, "new.txt"), content: "hi" }, tmp)).toEqual({
      deny: false,
    })
    expect(errorSpy).toHaveBeenCalledTimes(0)
  })

  test("comment-checker denies a restating comment when the gate is deny", async () => {
    process.env.OMCA_COMMENT_GATE = "deny"
    const content = '# set the user name\nuser_name="$input_value"'
    const result = await checkEdit(root, "write", { path: "/repo/scripts/foo.sh", content }, tmp)
    expect(result.deny).toBe(true)
    if (result.deny) expect(result.reason).toContain("restates the following code line")
    expect(errorSpy).toHaveBeenCalledTimes(0)
  })

  test("comment-checker skips a Markdown patch section", async () => {
    process.env.OMCA_COMMENT_GATE = "deny"
    const patchText = "*** Begin Patch\n*** Add File: a.md\n+# Install\n+Install it\n*** End Patch"
    expect(await checkEdit(root, "patch", { patchText }, tmp)).toEqual({ deny: false })
    expect(errorSpy).toHaveBeenCalledTimes(0)
  })

  test("comment-checker denies a restating comment in a source-file patch", async () => {
    process.env.OMCA_COMMENT_GATE = "deny"
    const patchText =
      '*** Begin Patch\n*** Add File: scripts/foo.sh\n+# set the user name\n+user_name="$input_value"\n*** End Patch'
    const result = await checkEdit(root, "patch", { patchText }, tmp)
    expect(result.deny).toBe(true)
    if (result.deny) expect(result.reason).toContain("restates the following code line")
    expect(errorSpy).toHaveBeenCalledTimes(0)
  })
})

describe("failure modes allow and log once", () => {
  test("nonexistent script", async () => {
    expect(await runGuard(join(tmp, "missing.sh"), {}, opts())).toEqual({ deny: false })
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  test("timeout returns promptly", async () => {
    const started = performance.now()
    expect(await runGuard(tempScript("exec sleep 5"), {}, { ...opts(), timeoutMs: 200 })).toEqual({ deny: false })
    expect(performance.now() - started).toBeLessThan(2000)
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  test("exit 127", async () => {
    expect(await runGuard(tempScript("exit 127"), {}, opts())).toEqual({ deny: false })
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })
})
