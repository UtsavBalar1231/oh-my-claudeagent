import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { bindPlan } from "../state.ts"
import { type Agent, installPackage, isolatedEnv, type Listing, opencodeBin, packageFixture, removeDir, scratchDir, type Server, startServer, startStubProvider, until, writeConfig } from "./harness.ts"

const tmux = Bun.which("tmux")
if (process.env.CI === "true" && process.env.RUNNER_OS === "Linux" && (!tmux || !opencodeBin)) throw new Error("Linux CI requires OpenCode and tmux; terminal coverage must not silently skip")
let fixture: { root: string; ws: string; server: Server; sessionID: string; socket: string; stopProvider: () => Promise<void>; stopPackage: () => Promise<void> } | undefined
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

function terminal(...args: string[]): string {
  if (!fixture || !tmux) throw new Error("Terminal fixture is not ready")
  const result = Bun.spawnSync([tmux, "-L", fixture.socket, ...args], { env: { ...fixture.server.env, TERM: "xterm-256color" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString()
}

describe.skipIf(!opencodeBin || !tmux || process.platform === "win32")("native OpenCode terminal panel", () => {
  beforeAll(async () => {
    const root = scratchDir("tui")
    const ws = join(root, "ws")
    const provider = await startStubProvider(root)
    const plugin = packageFixture(join(root, "plugin"))
    writeConfig(ws, {
      model: "stub/scripted",
      providers: {
        stub: {
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "stub" },
          models: { scripted: { capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 200000, output: 32000 } } },
        },
      },
      plugins: [plugin.spec],
    })
    // Installing the package pulls its peer dependencies from npm, which takes far longer than
    // registration when npm's cache is cold, so it finishes before the registration wait starts.
    await installPackage(plugin.spec, isolatedEnv(root, ws), ws)
    const server = await startServer(root, ws)
    fixture = { root, ws, server, sessionID: "", socket: `omca-tui-${crypto.randomUUID()}`, stopProvider: provider.stop, stopPackage: plugin.stop }
    await until("OMCA primary registered", 20_000, async () => (await server.api<Listing<Agent>>("GET", "/api/agent", ws)).body?.data?.some((agent) => agent.id === "omca"), () => server.log().split("\n").filter((line) => /failed|WARN|ERROR/.test(line)).slice(-3).join("\n"))
    const created = await server.api<{ data?: { id: string } }>("POST", "/api/session", ws, { title: "OMCA terminal inspection", agent: "omca", location: { directory: ws } })
    if (!created.body?.data?.id) throw new Error(created.text)
    fixture.sessionID = created.body.data.id
    const plan = join(ws, "work.md")
    writeFileSync(plan, "# Work\n\nStatus: FINAL\n\n- [ ] 1. First task\n- [ ] 2. Second task\n")
    await bindPlan(ws, fixture.sessionID, plan)
    const seeded = await server.api("POST", `/api/session/${fixture.sessionID}/prompt`, ws, { text: "OMCA-TUI-FIXTURE: Reply briefly without tools." })
    if (seeded.status >= 400) throw new Error(seeded.text)
    const configDir = join(root, "config", "opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "cli.json"), JSON.stringify({ theme: { name: "lucent-orng", mode: "dark" }, animations: false, tabs: { mode: "off" } }))
  }, 120_000)

  afterAll(async () => {
    if (!fixture) return
    if (tmux) Bun.spawnSync([tmux, "-L", fixture.socket, "kill-server"], { env: fixture.server.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    await fixture.server.stop()
    await fixture.stopProvider()
    await fixture.stopPackage()
    await removeDir(fixture.root)
  }, 120_000)

  test("loads the packaged TUI, opens its panel and keeps narrow/wide layouts usable", async () => {
    if (!fixture || !opencodeBin) throw new Error("Fixture missing")
    const command = [opencodeBin, "--server", fixture.server.base, "--session", fixture.sessionID, fixture.ws].map(quote).join(" ")
    terminal("new-session", "-d", "-s", "omca", "-x", "80", "-y", "32", command)
    const capture = () => terminal("capture-pane", "-p", "-t", "omca")
    await until("native session transcript displayed", 30_000, async () => capture().includes("OMCA-TUI-FIXTURE"), capture)
    const diagnostics = () => {
      const log = join(fixture!.root, "data", "opencode", "log", "opencode.log")
      const failures = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => /WARN|ERROR|failed.*plugin/i.test(line)).slice(-5) : []
      const serverFailures = fixture!.server.log().split("\n").filter((line) => /WARN|ERROR|failed.*plugin/i.test(line)).slice(-5)
      return `Client: ${failures.join("\n") || "No plugin warning logged"}\nServer: ${serverFailures.join("\n") || "No plugin warning logged"}\n${capture()}`
    }
    try {
      await until("installed package TUI footer loaded", 15_000, async () => capture().includes("OMCA: 0/2"), diagnostics)
    } catch (error) {
      console.error(diagnostics())
      throw error
    }
    terminal("send-keys", "-t", "omca", "-l", "/omca")
    terminal("send-keys", "-t", "omca", "Enter")
    await until("slash completion selected", 5_000, async () => capture().includes("/omca"), capture)
    terminal("send-keys", "-t", "omca", "Enter")
    await until("OMCA panel displayed", 20_000, async () => capture().includes("OMCA / Overview"), capture)
    expect(capture()).toContain("Current plan")
    expect(capture()).toContain("First task")
    expect(capture()).not.toContain("SHA256")
    expect(capture()).not.toContain("Native server-authored verification")
    for (const width of [120, 200, 80]) {
      terminal("resize-window", "-t", "omca", "-x", String(width), "-y", "32")
      await until(`OMCA panel at ${width} columns`, 5_000, async () => capture().includes("OMCA / Overview"), capture)
    }
    terminal("send-keys", "-t", "omca", "6")
    await until("Doctor tab", 5_000, async () => capture().includes("Read-only server health"), capture)
    terminal("send-keys", "-t", "omca", "Escape")
    await until("panel closed", 5_000, async () => !capture().includes("Read-only server health"), capture)
    const edited = await fixture.server.api("POST", `/api/session/${fixture.sessionID}/prompt`, fixture.ws, { text: "OMCA-SCENARIO:plan-checkbox" })
    expect(edited.status, edited.text).toBeLessThan(400)
    await until("footer reflects the native edit with the panel closed", 10_000, async () => capture().includes("OMCA: 1/2"), capture)
    expect(fixture.server.log()).not.toContain("failed to load plugin")
  }, 90_000)
})
