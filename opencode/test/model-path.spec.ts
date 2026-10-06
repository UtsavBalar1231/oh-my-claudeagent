import { afterAll, beforeAll, describe, test } from "bun:test"
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { commit, countLines, git, type Listing, opencodeBin, removeDir, repo, scratchDir, type Server, snapshot, startServer, until, writeConfig } from "./harness.ts"

type Message = { role?: string; content?: unknown }
type Request = { model?: string; messages?: Message[]; tools?: { function: { name: string } }[] }
type Named = { name?: string; parentID?: string | null; status?: { status?: string } }
type Fixture = { root: string; ws: string; server: Server; stub: Bun.Subprocess; stubFd: number; stubLog: string; baseline: number }

const SLOW = 240_000
const EXPLORER = "# Explorer: Codebase Search Specialist"
const EVIDENCE = "Evidence before claims"
const VISIBLE_OMCA_TOOLS = [
  "omca_ast_dump_tree", "omca_ast_find_rule", "omca_ast_replace", "omca_ast_search", "omca_ast_test_rule",
  "omca_boulder_progress", "omca_evidence_log", "omca_evidence_read", "omca_file_read",
  "omca_notepad_compact", "omca_notepad_list", "omca_notepad_read", "omca_notepad_write",
]
let fixture: Fixture | undefined

function need(): Fixture {
  if (!fixture) throw new Error("the OpenCode server did not start")
  return fixture
}

function text(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((part) => (part as { text?: string } | null)?.text).filter((part) => part !== undefined).join("\n")
  return ""
}

function allRequests(): Request[] {
  const raw = readFileSync(need().stubLog, "utf8")
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Request)
}

const requests = () => allRequests().slice(need().baseline)

type Scenario = { start: number; end: number; headBefore: string }
const scenarios = new Map<string, Promise<Scenario>>()

const system = (request: Request) =>
  (request.messages ?? [])
    .filter((message) => message.role === "system")
    .map((message) => text(message.content))
    .join("\n")

const lastIsTool = (request: Request) => request.messages?.at(-1)?.role === "tool"
const lastText = (request: Request) => text(request.messages?.at(-1)?.content)
const toolNames = (request: Request) => (request.tools ?? []).map((tool) => tool.function.name)
const during = ({ start, end }: Scenario) => requests().slice(start, end)
const toolResults = (scenario: Scenario) => during(scenario).filter(lastIsTool).map(lastText).join("\n")

function diagnostics(): string {
  const log = need().server.log()
  const summary = requests().map((request, i) => {
    const names = toolNames(request)
    return `#${i} ${request.messages?.at(-1)?.role} tools=${names.length} evidence_log=${names.includes("omca_evidence_log")} explorer=${system(request).includes(EXPLORER)}${names.includes("omca_evidence_log") ? "" : ` [${names.join(",")}]`}`
  })
  const counts = `plugin loads=${countLines(log, "loading plugin")}, mcp connects=${countLines(log, "mcp connected")}`
  return `${counts}\n${summary.join("\n")}\nserver log tail:\n${log.split("\n").slice(-20).join("\n")}`
}

function verify(ok: boolean, message: string): void {
  if (!ok) throw new Error(`${message}\n${diagnostics()}`)
}

async function collect(proc: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<string> {
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return out + err
}

async function opencode(args: string[], timeoutMs: number): Promise<string> {
  const { ws, server } = need()
  // `opencode run` reads a piped stdin to EOF, so an inherited open pipe would hang it; it takes its directory from PWD, which `cwd` leaves alone.
  const proc = Bun.spawn([opencodeBin ?? "opencode", ...args], { cwd: ws, env: { ...server.env, PWD: ws }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    return await collect(proc)
  } finally {
    clearTimeout(timer)
  }
}

const run = (scenario: string) => opencode(["run", "--server", need().server.base, "--model", "stub/scripted", "--auto", "--format", "json", `OMCA-SCENARIO:${scenario}`], 180_000)

// Runs a scenario the first time any test asks for it, so a test that reads the requests a scenario produced does not depend on the test that usually runs it coming first.
function ran(name: string): Promise<Scenario> {
  let scenario = scenarios.get(name)
  if (!scenario) {
    const start = requests().length
    const headBefore = git(need().ws, "rev-parse", "HEAD")
    scenario = run(name).then(() => ({ start, end: requests().length, headBefore }))
    scenarios.set(name, scenario)
  }
  return scenario
}

async function ranAll(): Promise<void> {
  for (const name of ["shell-reset", "subagent", "skill-load"]) await ran(name)
}

describe.skipIf(!opencodeBin)("opencode model path", () => {
  beforeAll(async () => {
    const root = scratchDir("model-path")
    const stubLog = join(root, "requests.jsonl")
    const stubOut = join(root, "stub.out")
    writeFileSync(stubLog, "")
    const stubFd = openSync(stubOut, "a")
    const stub = Bun.spawn([process.execPath, join(repo, "opencode", "test", "stub-provider.ts")], {
      env: { ...process.env, STUB_LOG: stubLog },
      stdin: "ignore",
      stdout: stubFd,
      stderr: stubFd,
    })
    const stubPort = await until("stub started", 5000, async () => readFileSync(stubOut, "utf8").match(/^listening (\d+)/m)?.[1], () => readFileSync(stubOut, "utf8"))

    const ws = join(root, "ws")
    writeConfig(ws, {
      model: "stub/scripted",
      providers: {
        stub: {
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${stubPort}/v1`, apiKey: "stub" },
          models: {
            scripted: { capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 200000, output: 32000 } },
            "scripted-sonnet": { capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 200000, output: 32000 } },
          },
        },
      },
      plugins: [{ package: join(snapshot(join(root, "plugin")), "opencode"), options: { models: { sonnet: "stub/scripted-sonnet" } } }],
    })
    git(ws, "init", "-q")
    writeFileSync(join(ws, "file.txt"), "one\n")
    git(ws, "add", "file.txt")
    commit(ws, "one")
    writeFileSync(join(ws, "file.txt"), "two\n")
    commit(ws, "two", "-a")

    const server = await startServer(root, ws, { OMCA_COMMENT_GATE: "deny" })
    fixture = { root, ws, server, stub, stubFd, stubLog, baseline: 0 }

    await until("opencode models lists stub/scripted", 30_000, async () => (await opencode(["models", "--server", server.base], 20_000)).includes("stub/scripted"), server.last)
    await until(
      "omca MCP server connected",
      90_000,
      async () => {
        const { body } = await server.api<Listing<Named>>("GET", "/api/mcp", ws)
        return (body?.data ?? []).some((mcp) => mcp.name === "omca" && mcp.status?.status === "connected")
      },
      server.last,
    )
    await until(
      "omca tools reach the model",
      60_000,
      async () => {
        await run("warm-up")
        const last = allRequests().filter((request) => (request.tools?.length ?? 0) > 0).at(-1)
        return last !== undefined && toolNames(last).includes("omca_evidence_log")
      },
      server.last,
    )
    need().baseline = allRequests().length
  }, SLOW)

  afterAll(async () => {
    if (!fixture) return
    await fixture.server.stop()
    fixture.stub.kill()
    await fixture.stub.exited
    closeSync(fixture.stubFd)
    removeDir(fixture.root)
  }, SLOW)

  const head = () => git(need().ws, "rev-parse", "HEAD")

  test("shell-reset: the guard denial reaches the model and HEAD stays", async () => {
    const scenario = await ran("shell-reset")
    verify(head() === scenario.headBefore, "shell-reset: HEAD moved")
    verify(toolResults(scenario).includes("omca guard:"), "shell-reset: no omca guard denial reached the model")
  }, SLOW)

  test("subagent: the omca-explorer child session sees the guard denial", async () => {
    const { server, ws } = need()
    const scenario = await ran("subagent")
    const sessions = await server.api<Listing<Named>>("GET", "/api/session", ws)
    verify((sessions.body?.data ?? []).some((session) => session.parentID != null), `subagent: no child session: ${sessions.text}`)
    verify(during(scenario).some((request) => system(request).includes(EXPLORER)), "subagent: no request carried the omca-explorer system")
    verify(head() === scenario.headBefore, "subagent: HEAD moved")
    const childResult = during(scenario)
      .filter((request) => lastIsTool(request) && system(request).includes(EXPLORER))
      .map(lastText)
      .join("\n")
    verify(childResult.includes("omca guard:"), "subagent: no omca guard denial reached the omca-explorer child")
  }, SLOW)

  test("context: build requests carry the evidence rule and omca-explorer requests do not", async () => {
    await ranAll()
    verify(
      requests().some((request) => request.tools != null && !system(request).includes(EXPLORER) && system(request).includes(EVIDENCE)),
      `context: no build request contains '${EVIDENCE}'`,
    )
    verify(!requests().some((request) => system(request).includes(EXPLORER) && system(request).includes(EVIDENCE)), `context: the omca-explorer request contains '${EVIDENCE}'`)
  }, SLOW)

  test("tools: every build request exposes exactly the visible omca tools", async () => {
    await ranAll()
    const buildTools = requests()
      .filter((request) => (request.tools?.length ?? 0) > 0 && !system(request).includes(EXPLORER))
      .map((request) => toolNames(request).filter((name) => name.startsWith("omca_")).sort())
    verify(buildTools.length > 0, "tools: no build request carried tools")
    const wrong = buildTools.filter((names) => names.join(",") !== VISIBLE_OMCA_TOOLS.join(","))
    verify(wrong.length === 0, `tools: a build request exposes ${wrong[0]?.join(",")} instead of ${VISIBLE_OMCA_TOOLS.join(",")}`)
  }, SLOW)

  test("models: omca-explorer requests go to the sonnet override and build requests to the default", async () => {
    await ranAll()
    const explorer = requests().filter((request) => system(request).includes(EXPLORER))
    verify(explorer.length > 0, "models: no omca-explorer request")
    verify(explorer.every((request) => request.model === "scripted-sonnet"), `models: omca-explorer went to ${explorer.map((request) => request.model).join(",")}`)
    verify(requests().filter((request) => !system(request).includes(EXPLORER)).every((request) => request.model === "scripted"), "models: a build request left the default model")
  }, SLOW)

  test("slop-write: the comment gate denial reaches the model and the file is not written", async () => {
    const scenario = await ran("slop-write")
    verify(toolResults(scenario).includes("omca guard: Blocked: comment slop."), "slop-write: no comment gate denial reached the model")
    verify(!existsSync(join(need().ws, "slop.sh")), "slop-write: slop.sh was written")
  }, SLOW)

  test("explore-write: omca-explorer cannot write a file", async () => {
    const scenario = await ran("explore-write")
    const explorer = during(scenario).filter((request) => system(request).includes(EXPLORER))
    verify(explorer.length > 0, "explore-write: no request carried the omca-explorer system")
    verify(explorer.every((request) => !toolNames(request).some((name) => ["write", "edit", "patch"].includes(name))), "explore-write: omca-explorer was offered a write tool")
    verify(!existsSync(join(need().ws, "explored.txt")), "explore-write: explored.txt was written")
  }, SLOW)

  test("skill-load: the skill result names /omca-handoff without untranslated text", async () => {
    const result = toolResults(await ran("skill-load"))
    verify(result !== "", "skill-load: no follow-up request carried the skill result")
    verify(result.includes("/omca-handoff"), "skill-load: skill result lacks /omca-handoff")
    verify(!result.includes("oh-my-claudeagent:"), "skill-load: skill result contains untranslated oh-my-claudeagent: text")
  }, SLOW)
})
