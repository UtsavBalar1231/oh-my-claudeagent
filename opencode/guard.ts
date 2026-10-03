import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { type DenyOnce, judgeWrite } from "../src/core/comments.ts"
import { classify, type Context, type Finding, reasonFor } from "../src/core/destructive.ts"
import { isHookDisabled } from "../src/core/kill-switch.ts"
import { homeDir, toPlatform } from "../src/core/path.ts"

export type GuardResult = { deny: true; reason: string } | { deny: false }

const ALLOW: GuardResult = { deny: false }
const SH_FAMILY = ["sh", "bash", "zsh"]

export const shellKind = (shell: string): Context["shell"] =>
  SH_FAMILY.includes(shell.replace(/^.*[\\/]/, "").toLowerCase().replace(/\.exe$/, "")) ? "bash" : "powershell"

function shellContext(projectRoot: string, shell: string): Context {
  const home = homeDir(process.env)
  return { shell: shellKind(shell), cwd: projectRoot, root: projectRoot, platform: toPlatform(process.platform), ...(home !== undefined && { home }) }
}

function symbolicRef(projectRoot: string, name: string): string | undefined {
  try {
    const ref = execFileSync("git", ["symbolic-ref", "--quiet", "--short", name], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })
    return ref.trim() || undefined
  } catch {
    return undefined
  }
}

// Read from local refs only, so deciding never waits on the network.
function branches(projectRoot: string): Pick<Context, "branch" | "defaultBranch"> {
  const branch = symbolicRef(projectRoot, "HEAD")
  const originHead = symbolicRef(projectRoot, "refs/remotes/origin/HEAD")
  return { ...(branch !== undefined && { branch }), ...(originHead !== undefined && { defaultBranch: originHead.replace(/^origin\//, "") }) }
}

const isPush = (finding: Finding | undefined): boolean =>
  finding !== undefined && finding.kind !== "catastrophic" && finding.git.some((git) => git.operation === "push --force")

// OpenCode has no dialog to hold a command in, so it decides as `guardMode: deny` does: a
// catastrophic or blocking match is denied, and an advisory one runs. A guard that fails refuses
// the command, as the mod's guard does.
export function checkShell(command: string, projectRoot: string, shell: string): GuardResult {
  try {
    const ctx = shellContext(projectRoot, shell)
    const first = classify(command, ctx)
    const finding = isPush(first) ? classify(command, { ...ctx, ...branches(projectRoot) }) : first
    if (finding === undefined || finding.kind === "advisory") return ALLOW
    if (finding.kind === "blocking" && isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "bash-guard")) return ALLOW
    return { deny: true, reason: reasonFor(finding) }
  } catch (err) {
    return { deny: true, reason: `OMCA's shell guard failed, so the command was refused: ${err instanceof Error ? err.message : String(err)}` }
  }
}

const addedLines = (section: string): string =>
  section
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n")

function editInputs(tool: string, input: Record<string, unknown>, projectRoot: string): Record<string, unknown>[] {
  const path = (p: unknown) => resolve(projectRoot, String(p))
  if (tool === "write") return [{ file_path: path(input.path), content: input.content }]
  if (tool === "edit") return [{ file_path: path(input.path), new_string: input.newString }]
  if (tool !== "patch") return []
  const text = String(input.patchText ?? "")
  const headers = [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
  return headers.map((header, i) => ({
    file_path: path((header[1] ?? "").trim()),
    content: addedLines(text.slice(header.index, headers[i + 1]?.index)),
  }))
}

// The gate lets a repeat of the finding it last denied through, so the adapter process keeps
// that denial for as long as it runs.
const lastDenial: DenyOnce = new Map()

export function checkEdit(tool: string, input: Record<string, unknown>, projectRoot: string): GuardResult {
  if (process.env.OMCA_COMMENT_GATE !== "deny" || isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "comment-gate")) return ALLOW
  for (const editInput of editInputs(tool, input, projectRoot)) {
    const verdict = judgeWrite("deny", editInput, lastDenial)
    if (verdict?.kind === "deny") return { deny: true, reason: verdict.reason }
  }
  return ALLOW
}
