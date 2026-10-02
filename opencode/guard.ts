import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { classify, reasonFor } from "../src/core/destructive.ts"
import { isHookDisabled } from "../src/core/kill-switch.ts"

export type GuardResult = { deny: true; reason: string } | { deny: false }

const ALLOW: GuardResult = { deny: false }

export async function runGuard(
  script: string,
  payload: unknown,
  opts: { cwd: string; projectRoot: string; timeoutMs?: number },
): Promise<GuardResult> {
  const name = basename(script)
  if (!existsSync(script)) {
    console.error(`[omca] guard script missing, allowing: ${script}`)
    return ALLOW
  }
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_ROOT: opts.projectRoot }
  delete env.HOOK_INPUT
  let proc
  try {
    proc = Bun.spawn(["bash", script], {
      cwd: opts.cwd,
      // A Blob closes stdin at EOF, so the `timeout 5 cat` read in common.sh returns at once.
      stdin: new Blob([JSON.stringify(payload)]),
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (err) {
    console.error(`[omca] guard ${name} failed to spawn, allowing: ${err}`)
    return ALLOW
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<"timeout">((done) => {
    timer = setTimeout(() => done("timeout"), opts.timeoutMs ?? 10000)
  })
  const code = await Promise.race([proc.exited, timedOut])
  clearTimeout(timer)
  if (code === "timeout") {
    proc.kill()
    // A forked child such as `sleep` can hold the pipes open past the kill, so the pipes are never awaited here.
    console.error(`[omca] guard ${name} timed out, allowing`)
    return ALLOW
  }
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  if (code === 2) return { deny: true, reason: stderr.trim() }
  if (code !== 0) {
    console.error(`[omca] guard ${name} exited ${code}, allowing: ${stderr.trim()}`)
    return ALLOW
  }
  let out
  try {
    out = JSON.parse(stdout)?.hookSpecificOutput
  } catch {
    return ALLOW
  }
  if (out?.permissionDecision === "deny") return { deny: true, reason: String(out.permissionDecisionReason ?? "") }
  return ALLOW
}

const script = (root: string, name: string) => join(root, "scripts", `${name}.sh`)

// OpenCode has no dialog to hold a command in, so it decides as `guardMode: deny` does: a
// catastrophic or blocking match is denied, and an advisory one runs.
export function checkShell(command: string): GuardResult {
  const finding = classify(command)
  if (finding === undefined || finding.kind === "advisory") return ALLOW
  if (finding.kind === "blocking" && isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "bash-guard")) return ALLOW
  return { deny: true, reason: reasonFor(finding) }
}

type EditPayload = { tool_name: string; hook_event_name: "PreToolUse"; tool_input: Record<string, unknown> }

function editPayloads(tool: string, input: Record<string, unknown>, projectRoot: string) {
  const payload = (tool_name: string, tool_input: Record<string, unknown>): EditPayload => ({
    tool_name,
    hook_event_name: "PreToolUse",
    tool_input,
  })
  const path = (p: unknown) => resolve(projectRoot, String(p))
  if (tool === "write") {
    const p = payload("Write", { file_path: path(input.path), content: input.content })
    return { writes: [p], comments: [p] }
  }
  if (tool === "edit") {
    const p = payload("Edit", { file_path: path(input.path), old_string: input.oldString, new_string: input.newString })
    return { writes: [p], comments: [p] }
  }
  if (tool !== "patch") return { writes: [], comments: [] }
  const text = String(input.patchText ?? "")
  const headers = [...text.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)]
  const writes: EditPayload[] = []
  const comments: EditPayload[] = []
  headers.forEach((header, i) => {
    const section = text.slice(header.index, headers[i + 1]?.index)
    const p = payload("Edit", { file_path: path(header[2].trim()), patchText: section })
    writes.push(p)
    comments.push(p)
    const move = section.match(/^\*\*\* Move to: (.+)$/m)
    if (move) writes.push(payload("Edit", { file_path: path(move[1].trim()), patchText: section }))
  })
  return { writes, comments }
}

export async function checkEdit(
  root: string,
  tool: string,
  input: Record<string, unknown>,
  projectRoot: string,
): Promise<GuardResult> {
  const { writes, comments } = editPayloads(tool, input, projectRoot)
  const opts = { cwd: projectRoot, projectRoot }
  for (const p of writes) {
    const result = await runGuard(script(root, "write-guard"), p, opts)
    if (result.deny) return result
  }
  if (process.env.OMCA_COMMENT_GATE !== "deny") return ALLOW
  for (const p of comments) {
    const result = await runGuard(script(root, "comment-checker"), p, opts)
    if (result.deny) return result
  }
  return ALLOW
}

export async function guardSelfTest(root: string): Promise<string[]> {
  const tmp = mkdtempSync(join(tmpdir(), "omca-"))
  const opts = { cwd: tmp, projectRoot: tmp }
  const cases: [string, unknown][] = [
    [
      "write-guard",
      {
        tool_name: "Write",
        hook_event_name: "PreToolUse",
        tool_input: { file_path: join(tmp, ".omca", "evidence", "verification-evidence.json"), content: "{}" },
      },
    ],
  ]
  const failed: string[] = []
  try {
    for (const [name, payload] of cases) {
      const file = script(root, name)
      if (!(await runGuard(file, payload, opts)).deny) failed.push(basename(file))
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return failed
}
