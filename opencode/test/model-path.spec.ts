import { afterAll, beforeAll, describe, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { commit, countLines, git, type Listing, opencodeBin, removeDir, scratchDir, type Server, snapshot, startServer, startStubProvider, until, writeConfig } from "./harness.ts"

type Message = { role?: string; content?: unknown }
type Request = { model?: string; messages?: Message[]; tools?: { function: { name: string } }[] }
type Named = { name?: string; parentID?: string | null; status?: { status?: string } }
type Fixture = { root: string; ws: string; server: Server; stopProvider: () => Promise<void>; stubLog: string; baseline: number }

const SLOW = 240_000
let EXPLORER: string
let EXECUTOR: string
let EVIDENCE: string
let HANDOFF: string
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
const worker = (request: Request) => system(request).includes(EXPLORER) || system(request).includes(EXECUTOR)

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

const run = (scenario: string, agent = "build") => opencode(["run", "--server", need().server.base, "--model", "stub/scripted", "--agent", agent, "--auto", "--format", "json", `OMCA-SCENARIO:${scenario}`], 180_000)

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
  for (const name of ["shell-reset", "subagent", "skill-load", "explore-write"]) await ran(name)
}

describe.skipIf(!opencodeBin)("opencode model path", () => {
  beforeAll(async () => {
    const root = scratchDir("model-path")
    const provider = await startStubProvider(root)

    const ws = join(root, "ws")
    const plugin = snapshot(join(root, "plugin"))
    const source = await import(join(plugin, "opencode", "lib.ts")) as typeof import("../lib.ts")
    const expected = source.generate(plugin)
    const explorer = expected.agents.find((agent) => agent.id === "omca-explorer")
    const executor = expected.agents.find((agent) => agent.id === "omca-executor")
    const handoff = expected.skills.find((skill) => skill.id === "omca-handoff")
    if (!explorer || !executor || !handoff) throw new Error("Fixture prompt definitions are incomplete")
    EXPLORER = explorer.system.trim()
    EXECUTOR = executor.system.trim()
    EVIDENCE = expected.outputStyle.trim()
    HANDOFF = handoff.content.trim()
    writeConfig(ws, {
      model: "stub/scripted",
      providers: {
        stub: {
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "stub" },
          models: {
            scripted: { capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 200000, output: 32000 } },
            "scripted-sonnet": { capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 200000, output: 32000 } },
          },
        },
      },
      plugins: [{ package: join(plugin, "opencode"), options: { models: { sonnet: "stub/scripted-sonnet" } } }],
    })
    git(ws, "init", "-q")
    writeFileSync(join(ws, "file.txt"), "one\n")
    git(ws, "add", "file.txt")
    commit(ws, "one")
    writeFileSync(join(ws, "file.txt"), "two\n")
    commit(ws, "two", "-a")

    const server = await startServer(root, ws, { OMCA_COMMENT_GATE: "deny" })
    fixture = { root, ws, server, stopProvider: provider.stop, stubLog: provider.requests, baseline: 0 }

    await until("opencode models lists stub/scripted", 30_000, async () => (await opencode(["models", "--server", server.base], 20_000)).includes("stub/scripted"), server.last)
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
    await fixture.stopProvider()
    await removeDir(fixture.root)
  }, SLOW)

  const head = () => git(need().ws, "rev-parse", "HEAD")

  test("shell-reset: the guard denial reaches the model and HEAD stays", async () => {
    const scenario = await ran("shell-reset")
    verify(head() === scenario.headBefore, "shell-reset: HEAD moved")
    verify(toolResults(scenario).includes("omca guard:"), "shell-reset: no omca guard denial reached the model")
  }, SLOW)

  test("subagent: the omca-executor child session sees the guard denial", async () => {
    const { server, ws } = need()
    const scenario = await ran("subagent")
    const sessions = await server.api<Listing<Named>>("GET", "/api/session", ws)
    verify((sessions.body?.data ?? []).some((session) => session.parentID != null), `subagent: no child session: ${sessions.text}`)
    verify(during(scenario).some((request) => system(request).includes(EXECUTOR)), "subagent: no request carried the omca-executor system")
    verify(head() === scenario.headBefore, "subagent: HEAD moved")
    const childResult = during(scenario)
      .filter((request) => lastIsTool(request) && system(request).includes(EXECUTOR))
      .map(lastText)
      .join("\n")
    verify(childResult.includes("omca guard:"), "subagent: no omca guard denial reached the omca-executor child")
  }, SLOW)

  test("context: build requests carry the evidence rule and omca-explorer requests do not", async () => {
    await ranAll()
    verify(
      requests().some((request) => request.tools != null && !system(request).includes(EXPLORER) && system(request).includes(EVIDENCE)),
      `context: no build request contains '${EVIDENCE}'`,
    )
    verify(!requests().some((request) => system(request).includes(EXPLORER) && system(request).includes(EVIDENCE)), `context: the omca-explorer request contains '${EVIDENCE}'`)
  }, SLOW)

  test("tools: build requests expose essential native tools without legacy transport tools", async () => {
    await ranAll()
    const buildTools = requests()
      .filter((request) => (request.tools?.length ?? 0) > 0 && !worker(request))
      .map((request) => toolNames(request).filter((name) => name.startsWith("omca_")).sort())
    verify(buildTools.length > 0, "tools: no build request carried tools")
    for (const names of buildTools) {
      verify(names.includes("omca_evidence_log"), "tools: native evidence tool missing")
      verify(names.includes("omca_boulder_progress"), "tools: native progress tool missing")
      verify(!names.some((name) => ["omca_omca_hook", "omca_agents_migrate", "omca_boulder_write"].includes(name)), "tools: a legacy transport tool is exposed")
    }
  }, SLOW)

  test("instructions: native guidance names registered tools without Claude transport ids", async () => {
    await ranAll()
    const build = requests().filter((request) => (request.tools?.length ?? 0) > 0 && !worker(request)).map(system)
    verify(build.some((text) => text.includes("omca_evidence_log")), "instructions: no build request carried native evidence guidance")
    const named = [...new Set(build.flatMap((text) => [...text.matchAll(/\bomca_[a-z_]+/g)].map((match) => match[0])))]
    const hidden = named.filter((name) => !VISIBLE_OMCA_TOOLS.includes(name))
    verify(hidden.length === 0, `instructions: a build request names ${hidden.join(",")}, which the adapter hides`)
    const claudeIds = requests().flatMap((request) => [...system(request).matchAll(/.{0,80}mcp__plugin_oh-my-claudeagent_omca__.{0,80}/g)].map((match) => match[0]))
    verify(claudeIds.length === 0, `instructions: a request names an omca tool by its Claude Code id: ${[...new Set(claudeIds)].join(" | ")}`)
  }, SLOW)

  test("models: omca-explorer requests go to the sonnet override and build requests to the default", async () => {
    await ranAll()
    const explorer = requests().filter((request) => system(request).includes(EXPLORER))
    verify(explorer.length > 0, "models: no omca-explorer request")
    verify(explorer.every((request) => request.model === "scripted-sonnet"), `models: omca-explorer went to ${explorer.map((request) => request.model).join(",")}`)
    verify(requests().filter((request) => !worker(request)).every((request) => request.model === "scripted"), "models: a build request left the default model")
  }, SLOW)

  test("slop-write: the comment gate denial reaches the model and the file is not written", async () => {
    const scenario = await ran("slop-write")
    verify(toolResults(scenario).includes("omca guard: Blocked: comment slop."), "slop-write: no comment gate denial reached the model")
    verify(!existsSync(join(need().ws, "slop.sh")), "slop-write: slop.sh was written")
  }, SLOW)

  test("explore-write: omca-explorer has neither file mutators nor an unrestricted shell", async () => {
    const scenario = await ran("explore-write")
    const explorer = during(scenario).filter((request) => system(request).includes(EXPLORER))
    verify(explorer.length > 0, "explore-write: no request carried the omca-explorer system")
    verify(explorer.every((request) => !toolNames(request).some((name) => ["write", "edit", "patch", "shell"].includes(name))), "explore-write: omca-explorer was offered a write tool or unrestricted shell")
    verify(!existsSync(join(need().ws, "explored.txt")), "explore-write: explored.txt was written")
  }, SLOW)

  test("skill-load: the skill returns its concise manual-only body without untranslated text", async () => {
    const result = toolResults(await ran("skill-load"))
    verify(result !== "", "skill-load: no follow-up request carried the skill result")
    verify(result.includes(HANDOFF), "skill-load: native handoff instructions are missing")
    verify(!result.includes("oh-my-claudeagent:"), "skill-load: skill result contains untranslated oh-my-claudeagent: text")
  }, SLOW)

  test("Code Mode discovers deferred native OMCA tools", async () => {
    const scenario = await ran("discover-tools")
    verify(toolResults(scenario).includes("ast_search"), "discover-tools: native AST tool was not discoverable in Code Mode")
  }, SLOW)

  test.each(["plan-worker", "plan-general"])("native Plan refuses execution-capable delegation: %s", async (scenario) => {
    const start = requests().length
    await run(scenario, "plan")
    const observed = requests().slice(start)
    verify(observed.filter(lastIsTool).map(lastText).join("\n").includes("OMCA planning cannot launch execution-capable specialists"), "plan-worker: native permission denial did not reach the model")
    verify(!observed.some((request) => system(request).includes(EXECUTOR)), "plan-worker: an executor request was started")
    verify(!observed.some((request) => request.messages?.at(-1)?.role === "user" && lastText(request).includes("OMCA-SCENARIO:write-file")), "plan-worker: an implementation child received the forbidden task")
    verify(!existsSync(join(need().ws, "explored.txt")), "plan-worker: implementation changed the workspace")
  }, SLOW)

  test.each(["native-general", "native-explore"])("OMCA refuses built-in delegation while Build retains it: %s", async (scenario) => {
    for (const agent of ["omca", "build"]) {
      const start = requests().length
      await run(scenario, agent)
      const observed = requests().slice(start)
      const childStarted = observed.some((request) => request.messages?.at(-1)?.role === "user" && lastText(request).includes("OMCA-SCENARIO:warm-up"))
      verify(childStarted === (agent === "build"), `${scenario}: unexpected child launch for ${agent}`)
      if (agent === "omca") {
        const result = observed.filter(lastIsTool).map(lastText).join("\n")
        verify(/denied|not allowed|rejected/i.test(result), `${scenario}: no permission denial reached OMCA: ${result}`)
      }
    }
  }, SLOW)

  test("OMCA still launches its executor specialist", async () => {
    const start = requests().length
    await run("subagent", "omca")
    const observed = requests().slice(start)
    verify(observed.some((request) => system(request).includes(EXECUTOR)), "OMCA did not launch omca-executor")
    verify(observed.filter(lastIsTool).map(lastText).join("\n").includes("omca guard:"), "OMCA executor did not run its scoped task")
  }, SLOW)

  test("delegation preserves readable multiline prompts and reaches both primary agents", async () => {
    const expected = "You are a subagent spawned by another session.\nOMCA-SCENARIO:warm-up\n\nTask: Read `src/audio helper.ts` without editing files.\nConstraints: No network, hardware access, or commits.\nReference only: `printf '%s\\n' 'two words'`.\nKeep the 200–250 ms interval and the 30 s deadline."
    for (const agent of ["omca", "build"]) {
      const start = requests().length
      await run("prompt-fidelity", agent)
      const observed = requests().slice(start)
      verify(observed.some((request) => !worker(request) && system(request).includes("never minify them to save tokens")), `${agent}: delegation fidelity guidance did not reach the parent`)
      const child = observed.find((request) => system(request).includes(EXECUTOR) && request.messages?.at(-1)?.role === "user")
      verify(child !== undefined && lastText(child) === expected, `${agent}: multiline delegation changed before reaching the child`)
    }
  }, SLOW)
})
