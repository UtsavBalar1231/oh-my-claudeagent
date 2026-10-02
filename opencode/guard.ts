import { resolve } from "node:path"
import { type DenyOnce, judgeWrite } from "../src/core/comments.ts"
import { classify, reasonFor } from "../src/core/destructive.ts"
import { isHookDisabled } from "../src/core/kill-switch.ts"

export type GuardResult = { deny: true; reason: string } | { deny: false }

const ALLOW: GuardResult = { deny: false }

// OpenCode has no dialog to hold a command in, so it decides as `guardMode: deny` does: a
// catastrophic or blocking match is denied, and an advisory one runs.
export function checkShell(command: string): GuardResult {
  const finding = classify(command)
  if (finding === undefined || finding.kind === "advisory") return ALLOW
  if (finding.kind === "blocking" && isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "bash-guard")) return ALLOW
  return { deny: true, reason: reasonFor(finding) }
}

function editInputs(tool: string, input: Record<string, unknown>, projectRoot: string): Record<string, unknown>[] {
  const path = (p: unknown) => resolve(projectRoot, String(p))
  if (tool === "write") return [{ file_path: path(input.path), content: input.content }]
  if (tool === "edit") return [{ file_path: path(input.path), new_string: input.newString }]
  if (tool !== "patch") return []
  const text = String(input.patchText ?? "")
  const headers = [...text.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)]
  return headers.map((header, i) => ({
    file_path: path(header[2].trim()),
    patchText: text.slice(header.index, headers[i + 1]?.index),
  }))
}

// A second attempt at a finding the gate has just denied passes, so the adapter process keeps
// the last denial for as long as it runs.
const lastDenial: DenyOnce = {}

export function checkEdit(tool: string, input: Record<string, unknown>, projectRoot: string): GuardResult {
  if (process.env.OMCA_COMMENT_GATE !== "deny" || isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "comment-gate")) return ALLOW
  for (const editInput of editInputs(tool, input, projectRoot)) {
    const verdict = judgeWrite("deny", editInput, lastDenial)
    if (verdict?.kind === "deny") return { deny: true, reason: verdict.reason }
  }
  return ALLOW
}
