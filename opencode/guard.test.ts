import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkEdit, checkShell, guardSelfTest, runGuard } from "./guard.ts"

const root = join(import.meta.dir, "..")

let tmp: string
let errorSpy: ReturnType<typeof spyOn>
const savedGate = process.env.OMCA_COMMENT_GATE

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "omca-guard-"))
  errorSpy = spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
  if (savedGate === undefined) delete process.env.OMCA_COMMENT_GATE
  else process.env.OMCA_COMMENT_GATE = savedGate
  rmSync(tmp, { recursive: true, force: true })
})

const opts = () => ({ cwd: tmp, projectRoot: tmp })

function tempScript(body: string) {
  const file = join(tmp, "guard.sh")
  writeFileSync(file, `#!/bin/bash\n${body}\n`)
  return file
}

describe("decisions", () => {
  test("git-destructive-deny denies a hard reset", async () => {
    const result = await checkShell(root, "git reset --hard HEAD~1", opts())
    expect(result.deny).toBe(true)
    if (result.deny) expect(result.reason).toContain("Destructive git command blocked")
    expect(errorSpy).toHaveBeenCalledTimes(0)
  })

  test("git status is allowed", async () => {
    expect(await checkShell(root, "git status", opts())).toEqual({ deny: false })
    expect(errorSpy).toHaveBeenCalledTimes(0)
  })

  test("permission-filter denies a recursive removal of /home", async () => {
    const result = await checkShell(root, "rm -rf /home", opts())
    expect(result.deny).toBe(true)
    if (result.deny) expect(result.reason).toContain("Destructive rm -rf blocked")
    expect(errorSpy).toHaveBeenCalledTimes(0)
  })

  test("a recursive removal of build is allowed", async () => {
    expect(await checkShell(root, "rm -rf build", opts())).toEqual({ deny: false })
    expect(errorSpy).toHaveBeenCalledTimes(0)
  })

  test("write-guard denies a write to the evidence ledger", async () => {
    const path = join(tmp, ".omca", "evidence", "verification-evidence.json")
    const result = await checkEdit(root, "write", { path, content: "{}" }, tmp)
    expect(result.deny).toBe(true)
    if (result.deny) expect(result.reason).toContain("evidence_log")
    expect(errorSpy).toHaveBeenCalledTimes(0)
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

  test("write-guard denies a patch that moves a file onto the evidence ledger", async () => {
    const patchText =
      "*** Begin Patch\n*** Update File: notes.txt\n*** Move to: .omca/evidence/verification-evidence.json\n@@\n-a\n+b\n*** End Patch"
    const result = await checkEdit(root, "patch", { patchText }, tmp)
    expect(result.deny).toBe(true)
    if (result.deny) expect(result.reason).toContain("evidence_log")
    expect(errorSpy).toHaveBeenCalledTimes(0)
  })

  test("write-guard denies a patch that adds the evidence ledger", async () => {
    const patchText = "*** Begin Patch\n*** Add File: .omca/evidence/verification-evidence.json\n+{}\n*** End Patch"
    const result = await checkEdit(root, "patch", { patchText }, tmp)
    expect(result.deny).toBe(true)
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

describe("guardSelfTest", () => {
  test("passes with the real toolchain", async () => {
    expect(await guardSelfTest(root)).toEqual([])
  })

  test("reports scripts when jq is broken", async () => {
    const shim = join(tmp, "shim")
    mkdirSync(shim)
    writeFileSync(join(shim, "jq"), "#!/bin/sh\nexit 127\n")
    chmodSync(join(shim, "jq"), 0o755)
    const savedPath = process.env.PATH
    process.env.PATH = `${shim}:${savedPath}`
    try {
      expect((await guardSelfTest(root)).length).toBeGreaterThan(0)
    } finally {
      process.env.PATH = savedPath
    }
  })
})
