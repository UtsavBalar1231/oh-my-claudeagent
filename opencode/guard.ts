import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { type DenyOnce, judgeWrite } from "../src/core/comments.ts"
import { classify, type Context } from "../src/core/destructive.ts"
import { GIT_ENV, type GitAnswer, gitQueries, gitVerdict } from "../src/core/git-state.ts"
import { isHookDisabled } from "../src/core/kill-switch.ts"
import { homeDir, toPlatform } from "../src/core/path.ts"
import { spacing } from "./spacing.ts"

export type GuardResult = { deny: true; reason: string } | { deny: false }

const ALLOW: GuardResult = { deny: false }
const SH_FAMILY = ["sh", "bash", "zsh"]
const GIT_TIMEOUT_MS = 5000

export const shellKind = (shell: string): Context["shell"] =>
  SH_FAMILY.includes(shell.replace(/^.*[\\/]/, "").toLowerCase().replace(/\.exe$/, "")) ? "bash" : "powershell"

function shellContext(projectRoot: string, shell: string, cwd: string): Context {
  const home = homeDir(process.env)
  return { shell: shellKind(shell), cwd, root: projectRoot, platform: toPlatform(process.platform), ...(home !== undefined && { home }) }
}

function git(argv: readonly string[], cwd: string): GitAnswer {
  try {
    const stdout = execFileSync(argv[0] ?? "git", argv.slice(1), {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...GIT_ENV },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    })
    return { exitCode: 0, stdout, stderr: "" }
  } catch (err) {
    if (typeof err !== "object" || err === null || !("status" in err) || typeof err.status !== "number") {
      return { error: err instanceof Error ? err.message : String(err) }
    }
    const stdout = "stdout" in err ? String(err.stdout ?? "") : ""
    const stderr = "stderr" in err ? String(err.stderr ?? "") : ""
    return { exitCode: err.status, stdout, stderr }
  }
}

function symbolicRef(cwd: string, name: string): string | undefined {
  const answer = git(["git", "symbolic-ref", "--quiet", "--short", name], cwd)
  return "error" in answer || answer.exitCode !== 0 ? undefined : answer.stdout.trim() || undefined
}

// Read from local refs only, so deciding never waits on the network.
function branches(cwd: string): Pick<Context, "branch" | "defaultBranch"> {
  const branch = symbolicRef(cwd, "HEAD")
  const originHead = symbolicRef(cwd, "refs/remotes/origin/HEAD")
  return { ...(branch !== undefined && { branch }), ...(originHead !== undefined && { defaultBranch: originHead.replace(/^origin\//, "") }) }
}

export function checkShell(command: string, projectRoot: string, shell: string, cwd = projectRoot): GuardResult {
  try {
    const ctx = shellContext(projectRoot, shell, cwd)
    const first = classify(command, ctx)
    if (first?.kind === "catastrophic") return { deny: true, reason: first.reason }
    if (first?.kind !== "git" || isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "bash-guard")) return ALLOW
    const finding = first.isForcePush ? classify(command, { ...ctx, ...branches(cwd) }) : first
    if (finding?.kind !== "git") return ALLOW
    if (finding.reason !== undefined) return { deny: true, reason: finding.reason }
    const queries = gitQueries(finding.checks)
    const reason = gitVerdict(
      queries,
      queries.map((query) => (query.argv === undefined ? undefined : git(query.argv, cwd))),
    )
    return reason === undefined ? ALLOW : { deny: true, reason }
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

// Measured: no clean delegation prompt (725 from Claude Code, 171 from OpenCode) or repository
// document went past 3 missing spaces, and with a tenth of their spaces deleted, 95% of the Claude
// Code prompts reach both limits.
const MIN_MISSING = 5
const MIN_MISSING_RATE = 0.01
const EXAMPLES = 4

export function checkDelegation(prompt: string): GuardResult {
  if (isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "delegation-guard")) return ALLOW
  const { words, joined, missing } = spacing(prompt)
  if (missing < MIN_MISSING || missing / (words + missing) < MIN_MISSING_RATE) return ALLOW
  const examples = joined.toSorted((a, b) => b.words.length - a.words.length).slice(0, EXAMPLES).map(({ token }) => token)
  return {
    deny: true,
    reason: `Delegation prompt blocked: ${joined.length} of its tokens run words together, such as ${examples.join(", ")}. The child reads the prompt as its whole brief, so send it again as readable sentences with a space between every word, and put identifiers, paths and commands in backticks.`,
  }
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
