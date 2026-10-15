import type { Plugin } from "@opencode/plugin"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { authorizePath, canonicalPath, resolvePath } from "./access.ts"

let directory: string
let root: string
let calls: Array<{ action: string; resources: string[] }>

beforeEach(() => {
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), "omca-access-")))
  root = join(directory, "workspace")
  mkdirSync(root)
  calls = []
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

function context(run?: (input: { action: string; resources: string[] }) => void): Plugin.Context {
  return {
    session: { get: async () => ({ location: { directory: root } }) },
    permission: { assert: async (input: { action: string; resources: string[] }) => { calls.push(input); run?.(input) } },
  } as unknown as Plugin.Context
}

test("path resolution expands home paths without discarding their spelling", () => {
  expect(resolvePath(root, "~/plans/work.md")).toBe(join(homedir(), "plans", "work.md"))
  expect(resolvePath(root, "~")).toBe(homedir())
  expect(resolvePath(root, "selected.md")).toBe(join(root, "selected.md"))
})

test("uses location-relative read resources without creating missing state", async () => {
  const path = join(root, ".omca", "state", "boulder.json")
  expect(await authorizePath(context(), "ses_one", "build", root, path, "read")).toBe(path)
  expect(calls).toEqual([expect.objectContaining({ action: "read", resources: [".omca/state/boulder.json"] })])
})

test("external reads assert the directory boundary before the canonical file", async () => {
  const path = join(directory, "reference.md")
  writeFileSync(path, "reference")
  await authorizePath(context(), "ses_one", "plan", root, path, "read")
  expect(calls.map((call) => call.action)).toEqual(["external_directory", "read"])
  expect(calls[1]?.resources).toEqual([canonicalPath(path).replaceAll("\\", "/")])
})

test("native denials propagate without an alternate filesystem read", async () => {
  const ctx = context(() => { throw new Error("configured deny") })
  await expect(authorizePath(ctx, "ses_one", "build", root, "private.txt", "read")).rejects.toThrow("configured deny")
  expect(calls).toHaveLength(1)
})

test("sensitive and network paths are refused before permission approval", async () => {
  await expect(authorizePath(context(), "ses_one", "build", root, ".env", "read")).rejects.toThrow("sensitive")
  await expect(authorizePath(context(), "ses_one", "build", root, "//host/share/key", "read")).rejects.toThrow(/[Nn]etwork/)
  expect(calls).toHaveLength(0)
})

test.skipIf(process.platform === "win32")("symlink retargeting during approval requires another check", async () => {
  const one = join(root, "one.md")
  const two = join(root, "two.md")
  const link = join(root, "selected.md")
  writeFileSync(one, "one")
  writeFileSync(two, "two")
  symlinkSync(one, link)
  const ctx = context(() => { rmSync(link); symlinkSync(two, link) })
  await expect(authorizePath(ctx, "ses_one", "build", root, link, "read")).rejects.toThrow(/Path changed/)
})
