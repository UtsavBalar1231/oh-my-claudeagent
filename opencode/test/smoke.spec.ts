import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { type Agent, commit, countLines, git, installPackage, isolatedEnv, type Listing, opencodeBin, packageFixture, removeDir, scratchDir, type Server, startServer, until, writeConfig } from "./harness.ts"

type Fixture = { root: string; server: Server; packageServer: Server; a: string; b: string; c: string; stopPackage(): Promise<void> }
type Session = { data?: { id?: string; location?: { directory?: string } } }
type Named = { id?: string; name?: string; autoinvoke?: boolean; status?: { status?: string } }

const SLOW = 180_000
let fixture: Fixture | undefined

function need(): Fixture {
  if (!fixture) throw new Error("the OpenCode server did not start")
  return fixture
}

function workspace(dir: string, config: unknown): void {
  writeConfig(dir, config)
  git(dir, "init", "-q")
  git(dir, "add", "-A")
  commit(dir, "one")
  commit(dir, "two")
}

function localPlugin(pluginRoot: string, sonnet: string) {
  return { plugins: [{ package: join(pluginRoot, "opencode"), options: { models: { sonnet } } }] }
}

async function omcaAgents(dir: string, server = need().server): Promise<Agent[] | undefined> {
  const { body } = await server.api<Listing<Agent>>("GET", "/api/agent", dir)
  const omca = (body?.data ?? []).filter((agent) => agent.id.startsWith("omca-"))
  return omca.length === 8 ? body?.data : undefined
}

const explore = (agents: Agent[] | undefined) => agents?.find((agent) => agent.id === "omca-explorer")

const registeredIn = (dir: string) => until(`omca agents registered in ${dir}`, 15_000, () => omcaAgents(dir), need().server.last)

describe.skipIf(!opencodeBin)("opencode plugin smoke", () => {
  beforeAll(async () => {
    const root = scratchDir("smoke")
    const plugin = packageFixture(join(root, "plugin"))
    const [a, b, c] = ["a", "b", "c"].map((name) => join(root, name)) as [string, string, string]
    workspace(a, localPlugin(plugin.directory, "anthropic/claude-sonnet-5-5"))
    workspace(b, { plugins: [join(plugin.directory, "opencode")] })
    workspace(c, {})
    const packageRoot = join(root, "package-runtime")
    await installPackage(plugin.spec, isolatedEnv(packageRoot, c), c)
    fixture = { root, server: await startServer(root, root), packageServer: await startServer(packageRoot, c), a, b, c, stopPackage: plugin.stop }
  }, SLOW)

  afterAll(async () => {
    if (!fixture) return
    await fixture.server.stop()
    await fixture.packageServer.stop()
    await fixture.stopPackage()
    await removeDir(fixture.root)
  }, SLOW)

  test("server starts on 127.0.0.1", async () => {
    const { server, a } = need()
    await until("server started", 15_000, async () => (await server.api<Listing<unknown>>("GET", "/api/agent", a)).body?.data, server.last)
  }, SLOW)

  test("8 omca-* agents are registered", async () => {
    const agents = await registeredIn(need().a)
    expect(agents.filter((agent) => agent.id.startsWith("omca-"))).toHaveLength(8)
  }, SLOW)

  test("omca-explorer is a subagent with edit/subagent denied", async () => {
    const agent = explore(await registeredIn(need().a))
    expect(agent?.mode).toBe("subagent")
    const denied = (agent?.permissions ?? []).filter((permission) => permission.effect === "deny").map((permission) => permission.action)
    expect(["edit", "subagent"].filter((action) => !denied.includes(action))).toEqual([])
  })

  test("OMCA is selectable while native Build and Plan remain primary", async () => {
    const agents = await registeredIn(need().a)
    for (const id of ["omca", "build", "plan"]) expect(agents.find((agent) => agent.id === id)?.mode).toBe("primary")
  })

  test("read-only RPC works in the installed adapter without initializing state", async () => {
    const { server, a } = need()
    await registeredIn(a)
    const created = await server.api<Session>("POST", "/api/session", a, { title: "OMCA inspection", location: { directory: a } })
    const sessionID = created.body?.data?.id
    expect(sessionID).toBeString()
    const response = await server.api<{ output?: { sessionID?: string; plan?: unknown; health?: unknown[] } }>("POST", "/api/rpc/omca/snapshot", a, { input: { sessionID } })
    expect(response.status, response.text).toBe(200)
    expect(response.body?.output).toMatchObject({ sessionID, plan: null })
    expect(response.body?.output?.health?.length).toBeGreaterThan(0)
    expect(existsSync(join(a, ".omca"))).toBe(false)
  }, SLOW)

  test("omca-explorer model is anthropic/claude-sonnet-5-5 in A and unset in B", async () => {
    const { a, b } = need()
    expect(explore(await registeredIn(a))?.model).toMatchObject({ providerID: "anthropic", id: "claude-sonnet-5-5" })
    const agentsInB = await registeredIn(b)
    expect(explore(agentsInB)).toBeDefined()
    expect(explore(agentsInB)?.model ?? null).toBeNull()
  }, SLOW)

  test("skills preserve manual handoff and commands include native planning/execution", async () => {
    const { server, a } = need()
    const skills = await until(
      "omca skills",
      15_000,
      async () => {
        const { body } = await server.api<Listing<Named>>("GET", "/api/skill", a)
        const omca = (body?.data ?? []).filter((skill) => skill.id?.startsWith("omca-"))
        return omca.length === 5 ? omca : undefined
      },
      server.last,
    )
    expect(skills.find((skill) => skill.id === "omca-handoff")?.autoinvoke).toBe(false)
    await until(
      "omca commands",
      15_000,
      async () => {
        const { body } = await server.api<Listing<Named>>("GET", "/api/command", a)
        const omca = (body?.data ?? []).filter((command) => command.name?.startsWith("omca-"))
        const expected = ["omca-analyzer", "omca-reviewer", "omca-build-fixer", "omca-plan", "omca-start-work", "omca-pause"]
        return expected.every((name) => omca.some((command) => command.name === name)) ? omca : undefined
      },
      server.last,
    )
  }, SLOW)

  test("native integration does not start a duplicate omca MCP server", async () => {
    const { server, a } = need()
    await registeredIn(a)
    const response = await server.api<Listing<Named>>("GET", "/api/mcp", a)
    expect(response.status, response.text).toBe(200)
    expect(Array.isArray(response.body?.data)).toBe(true)
    expect(response.body!.data!.some((mcp) => mcp.name === "omca")).toBe(false)
  }, SLOW)

  test("shell guard blocked the reset, kept HEAD, and allowed git status", async () => {
    const { server, a } = need()
    await registeredIn(a)
    const created = await server.api<Session>("POST", "/api/session", a, { title: "smoke", location: { directory: a } })
    expect(created.body?.data?.location?.directory).toBe(a)
    const session = created.body?.data?.id
    expect(session).toBeString()
    const before = git(a, "rev-parse", "HEAD")
    const reset = await server.api<unknown>("POST", `/api/session/${session}/shell`, a, { command: "git reset --hard HEAD~1" })
    expect(reset.status).toBeGreaterThanOrEqual(400)
    expect(git(a, "rev-parse", "HEAD")).toBe(before)
    const status = await server.api<unknown>("POST", `/api/session/${session}/shell`, a, { command: "git status" })
    expect(status.status).toBeGreaterThanOrEqual(200)
    expect(status.status).toBeLessThan(300)
  }, SLOW)

  test("log has no disabled plugin or silently ignored model configuration", async () => {
    await registeredIn(need().b)
    const log = need().server.log()
    expect(countLines(log, "disabled plugin after transform failure")).toBe(0)
    expect(countLines(log, "omca: ignoring models.")).toBe(0)
  })

  test("Git package spec loads 8 agents with a non-empty omca-explorer system prompt", async () => {
    const { packageServer: server, c } = need()
    let packageState = ""
    await until(
      "git spec load",
      60_000,
      async () => {
        const agents = await omcaAgents(c, server)
        if ((explore(agents)?.system?.length ?? 0) === 0) {
          const plugins = await server.api("GET", "/api/plugin", c)
          packageState = plugins.text
        }
        return (explore(agents)?.system?.length ?? 0) > 0
      },
      () => {
        const failures = server.log().split("\n").filter((line) => /plugin|install|WARN|ERROR/i.test(line)).join("\n")
        console.error(packageState, failures)
        return `${packageState}\n${failures}\n${server.last()}`
      },
    )
  }, SLOW)
})
