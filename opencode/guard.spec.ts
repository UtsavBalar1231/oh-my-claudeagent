import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { checkAgentTool, checkDelegation, checkEdit, checkShell, shellKind } from "./guard.ts"

const BASH = "/bin/bash"
const shell = (command: string) => checkShell(command, process.cwd(), BASH)

const RM_CATASTROPHIC =
  "Destructive rm -rf blocked: the target is the filesystem root, home, the working directory, or a directory directly under root or home. Name a deeper path explicitly."
const OFF = "Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing."
const TRACKED = (operation: string) =>
  `Destructive git command blocked: it would discard uncommitted changes to tracked files: git status lists 1 changed file, and ${operation} overwrites them. Commit or stash them first, or REPORT and STOP. ${OFF}`
const UNTRACKED = "Destructive git command blocked: it would delete untracked files: git clean --dry-run lists 1 path. Commit, move or ignore what should stay first, or REPORT and STOP. " + OFF
const STASHED = (operation: string) =>
  `Destructive git command blocked: it would delete stashed changes: git stash list holds 1 entry, and ${operation} deletes them. Apply or commit what should stay first, or REPORT and STOP. ${OFF}`
const FORCE_PUSH =
  "Force push to the default branch blocked: it rewrites history everyone else has pulled. Push to another branch, or ask the user to push. Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing."
const NO_VERIFY =
  "git commit --no-verify blocked: it skips the repository's commit hooks. Fix what the hook reports and commit without the flag. Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing."

let tmp: string
let errorSpy: ReturnType<typeof spyOn>
const savedEnv = {
  OMCA_COMMENT_GATE: process.env.OMCA_COMMENT_GATE,
  OMCA_DISABLED_HOOKS: process.env.OMCA_DISABLED_HOOKS,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  GIT_DIR: process.env.GIT_DIR,
  GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES,
}

beforeEach(() => {
  delete process.env.OMCA_COMMENT_GATE
  delete process.env.OMCA_DISABLED_HOOKS
  tmp = mkdtempSync(join(tmpdir(), "omca-guard-"))
  process.env.GIT_CEILING_DIRECTORIES = tmp
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

const commit = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: dir, stdio: "ignore" })

function repo(name: string, branch = "main"): string {
  const dir = join(tmp, name)
  mkdirSync(dir)
  execFileSync("git", ["init", "--quiet", "--initial-branch", branch], { cwd: dir, stdio: "ignore" })
  writeFileSync(join(dir, "a.txt"), "a\n")
  commit(dir, "add", ".")
  commit(dir, "commit", "--quiet", "-m", "init")
  return dir
}

describe("decisions", () => {
  test("git status is allowed", () => {
    expect(shell("git status")).toEqual({ deny: false })
  })

  test("a recursive removal of /home is denied as catastrophic", () => {
    expect(shell("rm -rf /home")).toEqual({ deny: true, reason: RM_CATASTROPHIC })
  })

  test("a removal of a deeper path, a force push to another branch and a stash run", () => {
    expect(shell("rm -rf build")).toEqual({ deny: false })
    expect(shell("git push --force origin feature/x")).toEqual({ deny: false })
    expect(shell("rm -rf build && git stash && git stash pop")).toEqual({ deny: false })
    expect(shell("git checkout -- src && git rm -r vendor")).toEqual({ deny: false })
  })

  test("a variable assigned in the command is read before the target is judged", () => {
    expect(shell("S=/home/user/.cache/tmp/x/scratchpad; rm -rf $S/root")).toEqual({ deny: false })
    expect(shell('T=$(mktemp -d) && rm -rf "$T"')).toEqual({ deny: false })
    expect(shell("rm -rf -- < $S/file")).toEqual({ deny: false })
    expect(shell("S=/tmp/x rm -rf $S/y")).toEqual({
      deny: true,
      reason:
        'Destructive rm -rf blocked: the target starts with a variable that can be unset or empty when the rm runs: $S. Then $S/y is /y. Assign S in a statement of its own that always runs before the rm (S=/path/to/dir; cd dir && rm -rf "$S/..."), or write ${S:?} so the shell stops when S is unset or empty.',
    })
  })

  test("a glob after a cd is judged in the directory the cd enters, unless the cd can fail first", () => {
    expect(shell("cd /srv/scratch/x && rm -rf *")).toEqual({ deny: false })
    expect(shell("cd /srv/scratch/x; rm -rf *")).toEqual({
      deny: true,
      reason:
        "Destructive rm -rf blocked: the rm can run after its cd failed: a cd joined to it by ; or a newline leaves the rm in the original directory when the cd fails, and there * is protected. Join them with && (cd dir && rm -rf ...) so the rm runs only after the cd succeeds.",
    })
  })

  test("a quoted mention of a destructive command is allowed", () => {
    expect(shell('git commit -m "stop using rm -rf / and git reset --hard"')).toEqual({ deny: false })
  })

  test("bash-guard in OMCA_DISABLED_HOOKS turns off the git rules, never the catastrophic one", () => {
    const dir = repo("switched")
    writeFileSync(join(dir, "a.txt"), "changed\n")
    process.env.OMCA_DISABLED_HOOKS = "verification-recorder,bash-guard"
    expect(checkShell("git reset --hard", dir, BASH)).toEqual({ deny: false })
    expect(checkShell("git push --force origin main", dir, BASH)).toEqual({ deny: false })
    expect(checkShell("git commit --no-verify -m x", dir, BASH)).toEqual({ deny: false })
    expect(checkShell("rm -rf ~", dir, BASH)).toEqual({ deny: true, reason: RM_CATASTROPHIC })
  })

  test("the working directory and its parents are denied, a path below it runs", () => {
    const cwd = process.cwd()
    const denied = { deny: true, reason: RM_CATASTROPHIC }
    expect(shell(`rm -rf ${cwd}`)).toEqual(denied)
    expect(shell(`rm -rf ${cwd}/*`)).toEqual(denied)
    expect(shell(`rm -rf ${dirname(cwd)}`)).toEqual(denied)
    expect(shell(`rm -rf ${cwd}/build/out`)).toEqual({ deny: false })
  })

  test("the project directory is guarded when the process runs from its parent", () => {
    const project = join(tmp, "work", "proj")
    const denied = { deny: true, reason: RM_CATASTROPHIC }
    expect(checkShell(`rm -rf ${project}`, project, BASH)).toEqual(denied)
    expect(checkShell(`rm -rf ${project}/*`, project, BASH)).toEqual(denied)
    expect(checkShell(`rm -rf ${project}/build`, project, BASH)).toEqual({ deny: false })
  })

  test("relative removals use the command cwd rather than the plugin directory", () => {
    const project = join(tmp, "project")
    const cwd = join(project, "nested")
    expect(checkShell("rm -rf ../nested", project, BASH, cwd)).toEqual({ deny: true, reason: RM_CATASTROPHIC })
    expect(checkShell("rm -rf build/out", project, BASH, cwd)).toEqual({ deny: false })
  })

  test("home is read from the environment, in any spelling", () => {
    process.env.HOME = "/home/bob"
    process.env.USERPROFILE = "/home/bob"
    const denied = { deny: true, reason: RM_CATASTROPHIC }
    expect(shell("rm -rf /home/bob")).toEqual(denied)
    expect(shell("rm -rf /home/bob/dev")).toEqual(denied)
    expect(shell("rm -rf $USERPROFILE")).toEqual(denied)
    expect(shell("rm -rf /home/bob/dev/x")).toEqual({ deny: false })
  })

  test("drive roots and Git Bash mounts are denied, and an always-set variable is not", () => {
    const denied = { deny: true, reason: RM_CATASTROPHIC }
    expect(shell("rm -rf C:\\")).toEqual(denied)
    expect(shell("rm -rf /c")).toEqual(denied)
    expect(shell("rm -rf /c/Users")).toEqual(process.platform === "win32" ? denied : { deny: false })
    expect(shell("rm -rf //srv/share")).toEqual(denied)
    expect(shell('rm -rf "$TMPDIR/foo"')).toEqual({ deny: false })
  })

  test("git behind an .exe suffix or a path is checked, and a quoted heredoc body is not a command", () => {
    const dir = repo("suffixed")
    writeFileSync(join(dir, "a.txt"), "changed\n")
    expect(checkShell("git.exe reset --hard", dir, BASH)).toEqual({ deny: true, reason: TRACKED("git reset --hard") })
    expect(checkShell('"C:\\Program Files\\Git\\cmd\\git.exe" checkout .', dir, BASH)).toEqual({ deny: true, reason: TRACKED("git checkout .") })
    expect(checkShell("cat <<'EOF'\nrm -rf /\ngit reset --hard\nEOF", dir, BASH)).toEqual({ deny: false })
    expect(shell("cat <<'EOF'\nnotes\nEOF\nrm -rf /")).toEqual({ deny: true, reason: RM_CATASTROPHIC })
  })

  test("a nested or wrapped removal of home is denied as catastrophic", () => {
    const denied = { deny: true, reason: RM_CATASTROPHIC }
    expect(shell("bash -c 'rm -rf ~'")).toEqual(denied)
    expect(shell("eval \"rm -rf /\"")).toEqual(denied)
    expect(shell("timeout 5 rm -rf ~")).toEqual(denied)
    expect(shell("bash <<'EOF'\nrm -rf /\nEOF")).toEqual(denied)
    expect(shell("xargs rm -rf")).toEqual({ deny: false })
  })

  test("a commit that skips its hooks is denied, and bash-guard in OMCA_DISABLED_HOOKS lets it run", () => {
    expect(shell("git commit --no-verify -m x")).toEqual({ deny: true, reason: NO_VERIFY })
    expect(shell("sh -c 'git commit -n -m x'")).toEqual({ deny: true, reason: NO_VERIFY })
    process.env.OMCA_DISABLED_HOOKS = "bash-guard"
    expect(shell("git commit --no-verify -m x")).toEqual({ deny: false })
  })

  test("a write to a new file is allowed", () => {
    expect(checkEdit("write", { path: join(tmp, "new.txt"), content: "hi" }, tmp)).toEqual({ deny: false })
    expect(errorSpy).toHaveBeenCalledTimes(0)
  })
})

describe("the shell the command runs in", () => {
  const denied = { deny: true, reason: RM_CATASTROPHIC }
  const root = "C:\\proj"

  test("cmd and PowerShell removals of a drive root or home are denied", () => {
    expect(checkShell("rd /s /q C:\\", root, "C:\\Windows\\System32\\cmd.exe")).toEqual(denied)
    expect(checkShell("del /s /q C:\\*", root, "powershell.exe")).toEqual(denied)
    expect(checkShell("Remove-Item -Recurse -Force ~", root, "C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toEqual(denied)
  })

  test("every shell but PowerShell and cmd is read as bash, whatever the path or case", () => {
    for (const shell of ["/usr/bin/zsh", "C:\\Program Files\\Git\\bin\\BASH.EXE", "sh", "/usr/bin/dash", "/bin/ksh", "/usr/bin/fish", "nu"]) expect(shellKind(shell)).toBe("bash")
    for (const shell of ["pwsh", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "cmd.exe"]) expect(shellKind(shell)).toBe("powershell")
  })

  test("a removal through an unset variable is denied in dash as in bash", () => {
    expect(checkShell("x=/; rm -rf $x", process.cwd(), "/usr/bin/dash")).toEqual(checkShell("x=/; rm -rf $x", process.cwd(), BASH))
    expect(checkShell("x=/; rm -rf $x", process.cwd(), "/usr/bin/dash")).toMatchObject({ deny: true })
  })

  test("a command the guard cannot read is refused", () => {
    const result = checkShell(42 as unknown as string, root, BASH)
    expect(result).toEqual({ deny: true, reason: expect.stringContaining("OMCA's shell guard failed, so the command was refused: ") })
  })
})

describe("a whole-tree git operation", () => {
  test("runs on a clean repository and is denied on a dirty one", () => {
    const clean = repo("clean")
    const dirty = repo("dirty")
    writeFileSync(join(dirty, "a.txt"), "changed\n")
    for (const [command, operation] of [
      ["git reset --hard", "git reset --hard"],
      ["git checkout .", "git checkout ."],
      ["git checkout -- .", "git checkout ."],
      ["git restore .", "git restore ."],
    ] as const) {
      expect(checkShell(command, clean, BASH)).toEqual({ deny: false })
      expect(checkShell(command, dirty, BASH)).toEqual({ deny: true, reason: TRACKED(operation) })
    }
    expect(checkShell("git checkout -- a.txt", dirty, BASH)).toEqual({ deny: false })
    expect(checkShell("git restore --worktree a.txt", dirty, BASH)).toEqual({ deny: false })
  })

  test("git clean is denied only when its dry run lists a file, and leaves the file in place", () => {
    const dir = repo("untracked")
    expect(checkShell("git clean -fd", dir, BASH)).toEqual({ deny: false })
    writeFileSync(join(dir, "new.txt"), "new\n")
    expect(checkShell("git clean -fd", dir, BASH)).toEqual({ deny: true, reason: UNTRACKED })
    expect(checkShell("git clean -n", dir, BASH)).toEqual({ deny: false })
    expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("new\n")
  })

  test("git stash drop and clear are denied only while a stash entry exists", () => {
    const dir = repo("stashed")
    expect(checkShell("git stash drop", dir, BASH)).toEqual({ deny: false })
    writeFileSync(join(dir, "a.txt"), "wip\n")
    commit(dir, "stash", "push", "--quiet")
    expect(checkShell("git stash drop", dir, BASH)).toEqual({ deny: true, reason: STASHED("git stash drop") })
    expect(checkShell("git stash clear", dir, BASH)).toEqual({ deny: true, reason: STASHED("git stash clear") })
    expect(checkShell("git stash pop", dir, BASH)).toEqual({ deny: false })
  })

  test("reads the repository -C names, and runs outside a repository", () => {
    const clean = repo("other-clean")
    const dirty = repo("other-dirty")
    writeFileSync(join(dirty, "a.txt"), "changed\n")
    expect(checkShell(`git -C ${dirty} reset --hard`, clean, BASH)).toEqual({
      deny: true,
      reason: `Destructive git command blocked: it would discard uncommitted changes to tracked files: git status lists 1 changed file in ${dirty}, and git reset --hard overwrites them. Commit or stash them first, or REPORT and STOP. ${OFF}`,
    })
    const outside = join(tmp, "outside")
    mkdirSync(outside)
    expect(checkShell("git reset --hard", outside, BASH)).toEqual({ deny: false })
  })
})

describe("a force push to the default branch", () => {
  const repo = (branch: string, originHead?: string): string => {
    const dir = join(tmp, `repo-${branch}-${originHead ?? "none"}`)
    mkdirSync(dir)
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" })
    git("init", "--quiet", "--initial-branch", branch)
    if (originHead !== undefined) git("symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${originHead}`)
    return dir
  }
  const denied = { deny: true, reason: FORCE_PUSH }

  test("is denied by name, and a force push to another branch runs", () => {
    const dir = repo("dev")
    expect(checkShell("git push --force origin main", dir, BASH)).toEqual(denied)
    expect(checkShell("git push origin +HEAD:master", dir, BASH)).toEqual(denied)
    expect(checkShell("git push --force-with-lease origin dev", dir, BASH)).toEqual({ deny: false })
  })

  test("is denied when the push names no branch and the checked-out one is the default", () => {
    expect(checkShell("git push -f", repo("main"), BASH)).toEqual(denied)
    expect(checkShell("git push --force origin", repo("master"), BASH)).toEqual(denied)
    expect(checkShell("git push -f", repo("topic"), BASH)).toEqual({ deny: false })
  })

  test("follows the branch origin/HEAD names, and then main is an ordinary branch", () => {
    const dir = repo("develop", "develop")
    expect(checkShell("git push -f origin develop", dir, BASH)).toEqual(denied)
    expect(checkShell("git push -f", dir, BASH)).toEqual(denied)
    expect(checkShell("git push -f origin main", dir, BASH)).toEqual({ deny: false })
  })

  test("outside a repository, main and master are the default by name", () => {
    process.env.GIT_DIR = join(tmp, "no-repository")
    expect(checkShell("git push -f origin main", tmp, BASH)).toEqual(denied)
    expect(checkShell("git push -f", tmp, BASH)).toEqual({ deny: false })
  })
})

describe("the comment gate", () => {
  const SEPARATOR = 'Decorative separator comment ("----------"): delete it.'
  const slop = '# ----------\nuser_name="$input_value"'

  test("a decorative separator in a written file is denied when the gate is deny", () => {
    process.env.OMCA_COMMENT_GATE = "deny"
    const result = checkEdit("write", { path: "/repo/scripts/denied.sh", content: slop }, tmp)
    expect(result).toEqual({ deny: true, reason: expect.stringContaining(`Blocked: comment slop. ${SEPARATOR} The convention:`) })
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

  test("a decorative separator in a source-file patch is denied", () => {
    process.env.OMCA_COMMENT_GATE = "deny"
    const patchText = `*** Begin Patch\n*** Add File: scripts/patched.sh\n+# ----------\n+user_name="$input_value"\n*** End Patch`
    expect(checkEdit("patch", { patchText }, tmp)).toEqual({ deny: true, reason: expect.stringContaining(SEPARATOR) })
    expect(errorSpy).toHaveBeenCalledTimes(0)
  })

  test("an indented patch header is read as the host reads it", () => {
    process.env.OMCA_COMMENT_GATE = "deny"
    const patchText = `*** Begin Patch\n  *** Add File: scripts/patched.sh\n+# ----------\n+user_name="$input_value"\n*** End Patch`
    expect(checkEdit("patch", { patchText }, tmp)).toEqual({ deny: true, reason: expect.stringContaining(SEPARATOR) })
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

describe("a delegation prompt", () => {
  const GARBLED = "Read-only review of the parser change. Decide theboundaryforthenewflow andreportunresolvedrisks toparentbeforeediting, keepcurrentdependencies unchanged, and listeveryfileyouread. Workersonleaf."
  const REWRITE = "Read-only review of the parser change. Decide the boundary for the new flow and report unresolved risks to the parent before editing. Keep the current dependencies unchanged, and list every file you read. Workers stay leaf agents."
  const deleteEveryThirdSpace = (text: string) => {
    let spaces = 0
    return text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((chunk, i) => (i % 2 ? chunk : chunk.replace(/([a-z]) (?=[a-z])/g, (space, letter: string) => (++spaces % 3 === 0 ? letter : space)))).join("")
  }

  test("words run together are denied, naming the longest joins", () => {
    expect(checkDelegation(GARBLED)).toEqual({
      deny: true,
      reason: "Delegation prompt blocked: 6 of its tokens run words together, such as theboundaryforthenewflow, listeveryfileyouread, andreportunresolvedrisks, toparentbeforeediting. The child reads the prompt as its whole brief, so send it again as readable sentences with a space between every word, and put identifiers, paths and commands in backticks.",
    })
  })

  test("the same brief written as sentences is allowed", () => {
    expect(checkDelegation(REWRITE)).toEqual({ deny: false })
  })

  test("delegation-guard in OMCA_DISABLED_HOOKS allows a prompt the guard would deny", () => {
    process.env.OMCA_DISABLED_HOOKS = "delegation-guard"
    expect(checkDelegation(GARBLED)).toEqual({ deny: false })
  })

  test("four missing spaces are allowed and a fifth denies", () => {
    expect(checkDelegation("Decide toparentbeforeediting and ifdefer.").deny).toBe(false)
    expect(checkDelegation("Decide toparentbeforeediting and ifdefer, then andwhy.").deny).toBe(true)
  })

  test("joins under one percent of a long prompt are allowed", () => {
    const joins = " Decide toparentbeforeediting andreportunresolvedrisks."
    expect(checkDelegation(`${REWRITE} `.repeat(20) + joins).deny).toBe(false)
    expect(checkDelegation(`${REWRITE} `.repeat(10) + joins).deny).toBe(true)
  })

  test("real words, compounds, names, British spellings, code, paths and URLs are allowed", () => {
    const prompt = [
      "Report the redistributability, characterization and counterintelligence incompatibilities indiscriminately, not counterproductively.",
      "Check the filesystem, the frontend on localhost, every worktree, the dotfiles config, the teardown and the misconfiguration.",
      "Ask Infineon about the colour visualisation. Run `nolisten`; nolisten stays off, and -noreset too.",
      "Audit src/commands/conflict.rs against /tmp/project/plan.md at 9906a34d640d2111f724544cbc50f7f130569ae1, then https://example.com/noapprovalroundneeded.",
      "Keep getElementsByClassName and CLAUDE_CODE_ENABLE_TODO_TOOLS as they are.\n```\nkeepthisasitis andthisone\n```",
    ].join("\n")
    expect(checkDelegation(prompt)).toEqual({ deny: false })
  })

  const agents = [...new Bun.Glob("agents/*.md").scanSync({ cwd: join(import.meta.dir, "..") })].sort()

  test.each(agents)("%s is allowed as written and denied with every third space deleted", (path) => {
    const text = readFileSync(join(import.meta.dir, "..", path), "utf8")
    expect(checkDelegation(text)).toEqual({ deny: false })
    expect(checkDelegation(deleteEveryThirdSpace(text)).deny).toBe(true)
  })
})

describe("the specialists' contract", () => {
  const specialists = new Set(["omca-explorer", "omca-executor"])
  const denied = (reason: string) => ({ deny: true, reason })

  test("a read-only specialist cannot edit, run a shell or use OpenCode's own mutators", () => {
    for (const tool of ["write", "edit", "patch", "shell", "opencode_worktree_create", "opencode_session_move"]) {
      expect(checkAgentTool("omca-explorer", tool, "", specialists)).toEqual(denied(`omca-explorer is read-only, so it cannot run ${tool}`))
    }
    for (const tool of ["read", "grep", "omca_evidence_read", "webfetch", "opencode_worktree_list", "opencode_models", "opencode_read_mcp_resource"]) expect(checkAgentTool("omca-explorer", tool, "", specialists)).toEqual({ deny: false })
  })

  test("an executing specialist edits and runs a shell but does not delegate", () => {
    for (const tool of ["write", "shell", "opencode_worktree_create"]) expect(checkAgentTool("omca-executor", tool, "", specialists)).toEqual({ deny: false })
    expect(checkAgentTool("omca-executor", "subagent", "omca-explorer", specialists)).toEqual(denied("omca-executor is a specialist and does not delegate"))
  })

  test("the coordinator delegates to specialists and not to the built-in workers", () => {
    expect(checkAgentTool("omca", "subagent", "omca-executor", specialists)).toEqual({ deny: false })
    for (const target of ["general", "explore"]) {
      expect(checkAgentTool("omca", "subagent", target, specialists)).toEqual(denied(`OMCA delegates to its own specialists, not to the built-in ${target} agent`))
    }
    expect(checkAgentTool("build", "subagent", "general", specialists)).toEqual({ deny: false })
  })
})
