import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { type Agent, commit, countLines, git, type Listing, opencodeBin, removeDir, scratchDir, type Server, snapshot, startServer, until, writeConfig } from "./harness.ts"

type Fixture = { root: string; server: Server; a: string; b: string; c: string }
type Session = { data?: { id?: string; location?: { directory?: string } } }
type Named = { id?: string; name?: string; autoinvoke?: boolean; status?: { status?: string } }

const SLOW = 120_000
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

async function omcaAgents(dir: string): Promise<Agent[] | undefined> {
  const { body } = await need().server.api<Listing<Agent>>("GET", "/api/agent", dir)
  const omca = (body?.data ?? []).filter((agent) => agent.id.startsWith("omca-"))
  return omca.length === 8 ? body?.data : undefined
}

const explore = (agents: Agent[] | undefined) => agents?.find((agent) => agent.id === "omca-explorer")

const registeredIn = (dir: string) => until(`omca agents registered in ${dir}`, 15_000, () => omcaAgents(dir), need().server.last)

describe.skipIf(!opencodeBin)("opencode plugin smoke", () => {
  beforeAll(async () => {
    const root = scratchDir("smoke")
    const plugin = snapshot(join(root, "plugin"))
    git(plugin, "init", "-q")
    git(plugin, "add", "-A")
    commit(plugin, "package")
    const [a, b, c] = ["a", "b", "c"].map((name) => join(root, name)) as [string, string, string]
    workspace(a, localPlugin(plugin, "anthropic/claude-sonnet-5-5"))
    workspace(b, localPlugin(plugin, "bad"))
    workspace(c, { plugins: [`oh-my-claudeagent@git+file://${plugin}`] })
    fixture = { root, server: await startServer(root, root), a, b, c }
  }, SLOW)

  afterAll(async () => {
    if (!fixture) return
    await fixture.server.stop()
    removeDir(fixture.root)
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

  test("omca-explorer model is anthropic/claude-sonnet-5-5 in A and unset in B", async () => {
    const { a, b } = need()
    expect(explore(await registeredIn(a))?.model).toMatchObject({ providerID: "anthropic", id: "claude-sonnet-5-5" })
    const agentsInB = await registeredIn(b)
    expect(explore(agentsInB)).toBeDefined()
    expect(explore(agentsInB)?.model ?? null).toBeNull()
  }, SLOW)

  test("5 omca-* skills with omca-handoff autoinvoke false, and 3 omca-* commands", async () => {
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
        return omca.length === 3 ? omca : undefined
      },
      server.last,
    )
  }, SLOW)

  test("omca MCP server connected", async () => {
    const { server, a } = need()
    await until(
      "omca MCP connected",
      90_000,
      async () => {
        const { body } = await server.api<Listing<Named>>("GET", "/api/mcp", a)
        return (body?.data ?? []).some((mcp) => mcp.name === "omca" && mcp.status?.status === "connected")
      },
      server.last,
    )
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

  test("log has no disabled plugin line and one ignoring models line", async () => {
    await registeredIn(need().b)
    const log = need().server.log()
    expect(countLines(log, "disabled plugin after transform failure")).toBe(0)
    expect(countLines(log, "omca: ignoring models.")).toBe(1)
  })

  test("git+file plugin spec loads 8 agents with a non-empty omca-explorer system prompt", async () => {
    const { server, c } = need()
    await until(
      "git spec load",
      60_000,
      async () => {
        const agents = await omcaAgents(c)
        return (explore(agents)?.system?.length ?? 0) > 0
      },
      server.last,
    )
  }, SLOW)
})
