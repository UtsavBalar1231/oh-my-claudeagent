import type { Plugin } from "@opencode/plugin"
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import plugin from "./index.ts"
import { PLAN_FILE_BYTE_LIMIT } from "./state.ts"

type Rec = Record<string, unknown>
type Hook = (event: Rec) => Promise<void>
type Command = { name: string; execute: (input: Rec) => Promise<void> }

let dirs: string[] = []
let errorSpy: ReturnType<typeof spyOn>
const savedSwitch = process.env.OMCA_DISABLED_HOOKS

beforeEach(() => {
  delete process.env.OMCA_DISABLED_HOOKS
  errorSpy = spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  if (savedSwitch === undefined) delete process.env.OMCA_DISABLED_HOOKS
  else process.env.OMCA_DISABLED_HOOKS = savedSwitch
  errorSpy.mockRestore()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function fakeContext(options: Rec = {}, agentThrows = false) {
  const directory = mkdtempSync(join(tmpdir(), "omca-index-"))
  dirs.push(directory)
  const registration = { dispose: async () => {} }
  const agents = new Map<string, Rec>()
  const skills: Rec[] = []
  const commands: Command[] = []
  const mcp = new Map<string, unknown>()
  const hooks: Record<string, Hook> = {}
  const prompts: Rec[] = []
  const gets: string[] = []
  const tools = new Map<string, Rec>()
  const permissions: Rec[] = []
  const sessions = new Map<string, { agent: string; location: { directory: string }; parentID?: string }>()
  const interruptions: string[] = []
  const invalidations: string[] = []
  let failInvalidation = false
  const session = (sessionID: string) => {
    let value = sessions.get(sessionID)
    if (!value) { value = { agent: "build", location: { directory } }; sessions.set(sessionID, value) }
    return value
  }
  const rpcHandlers: Record<string, (input: Rec, context?: { signal: AbortSignal }) => Promise<unknown>> = {}
  let permission = (_input: Rec) => {}
  const hookOn = (domain: string) => async (name: string, callback: Hook) => {
    hooks[`${domain}.${name}`] = callback
    return registration
  }
  const newAgent = (id: string): Rec => ({
    id,
    name: id,
    mode: "primary",
    hidden: false,
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  })
  const ctx = {
    location: { directory },
    app: { version: "2.0.29" },
    options,
    agent: {
      transform: async (callback: (editor: { update(id: string, fn: (agent: Rec) => void): void }) => void) => {
        if (agentThrows) throw new Error("agent transform exploded")
        callback({
          update(id, fn) {
            const agent = agents.get(id) ?? newAgent(id)
            fn(agent)
            agents.set(id, agent)
          },
        })
        return registration
      },
      get: async ({ agentID }: { agentID: string }) => {
        gets.push(agentID)
        return { location: { directory }, data: agents.get(agentID) ?? newAgent(agentID) }
      },
    },
    skill: {
      transform: async (callback: (editor: { add(skill: Rec): void }) => void) => {
        callback({ add: (skill) => skills.push(skill) })
        return registration
      },
    },
    command: {
      transform: async (callback: (editor: { add(command: Command): void }) => void) => {
        callback({ add: (command) => commands.push(command) })
        return registration
      },
    },
    mcp: {
      transform: async (callback: (editor: { set(name: string, config: unknown): void }) => void) => {
        callback({ set: (name, config) => mcp.set(name, config) })
        return registration
      },
    },
    session: {
      hook: hookOn("session"),
      get: async ({ sessionID }: { sessionID: string }) => session(sessionID),
      switchAgent: async ({ sessionID, agent }: { sessionID: string; agent: string }) => { session(sessionID).agent = agent },
      interrupt: async ({ sessionID }: { sessionID: string }) => { interruptions.push(sessionID) },
      prompt: async (input: Rec) => {
        prompts.push(input)
      },
    },
    shell: { hook: hookOn("shell") },
    permission: {
      hook: hookOn("permission"),
      assert: async (input: Rec) => { permissions.push(input); permission(input) },
    },
    rpc: {
      register: async (_definition: unknown, handlers: typeof rpcHandlers) => {
        for (const [name, handler] of Object.entries(handlers)) rpcHandlers[name] = (input, context) => handler(input, context ?? { signal: new AbortController().signal })
        return { ...registration, events: { emit: async (_name: string, data: { sessionID: string }) => {
          if (failInvalidation) throw new Error("event stream unavailable")
          invalidations.push(data.sessionID)
        } } }
      },
    },
    tool: {
      hook: hookOn("tool"),
      transform: async (callback: (editor: Rec) => void) => {
        callback({ namespace: () => {}, add: (tool: Rec) => tools.set(`omca_${String(tool.name)}`, tool) })
        return registration
      },
    },
  }
  return { ctx: ctx as unknown as Plugin.Context, agents, skills, commands, mcp, hooks, prompts, gets, tools, permissions, sessions, session, rpcHandlers, interruptions, invalidations, failInvalidation: () => { failInvalidation = true }, deny: (fn: typeof permission) => { permission = fn } }
}

function hook(fake: ReturnType<typeof fakeContext>, name: string): Hook {
  const registered = fake.hooks[name]
  if (registered === undefined) throw new Error(`no ${name} hook`)
  return registered
}

function command(fake: ReturnType<typeof fakeContext>, name: string): Command {
  const found = fake.commands.find((c) => c.name === name)
  if (found === undefined) throw new Error(`no ${name} command`)
  return found
}

async function fireContext(fake: ReturnType<typeof fakeContext>, agent: string) {
  const event = { sessionID: "ses_one", agent, tools: { omca_session_search: {}, omca_omca_hook: {}, omca_health_check: {}, omca_agents_migrate: {}, omca_evidence_log: {} }, system: [] as Rec[] }
  await hook(fake, "session.context")(event)
  return event
}

test("a valid sonnet model ref sets the agent model", async () => {
  const fake = fakeContext({ models: { sonnet: "anthropic/claude-sonnet-5-5" } })
  await plugin.setup(fake.ctx)
  expect(fake.agents.get("omca-explorer")?.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-5-5" })
  expect(fake.agents.get("omca-explorer")?.mode).toBe("subagent")
  expect(fake.agents.get("omca-explorer")?.permissions).toContainEqual({ action: "edit", resource: "*", effect: "deny" })
  expect(errorSpy).not.toHaveBeenCalled()
})

test("an invalid model ref fails plugin setup explicitly", async () => {
  const fake = fakeContext({ models: { sonnet: "bad" } })
  await expect(plugin.setup(fake.ctx)).rejects.toThrow("models.sonnet")
  expect(fake.agents.get("omca-explorer")).toBeUndefined()
})

test("skills carry an absolute path and no relPath", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  expect(fake.skills.length).toBeGreaterThan(0)
  for (const skill of fake.skills) {
    expect(skill).not.toHaveProperty("relPath")
    expect(isAbsolute(String(skill.path))).toBe(true)
  }
})

test("a command prompts the session with its template and arguments", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  await command(fake, "omca-reviewer").execute({ sessionID: "ses_1", prompt: { text: "p.md" }, delivery: "queue" })
  expect(fake.prompts).toHaveLength(1)
  expect(fake.prompts[0]).toMatchObject({ sessionID: "ses_1", delivery: "queue" })
  expect(String(fake.prompts[0]?.text)).toContain("omca-reviewer")
  expect(String(fake.prompts[0]?.text)).toContain("p.md")
})

test("a command keeps its attachments and drops mention offsets into the replaced text", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  const mention = { start: 0, end: 5, text: "@p.md" }
  await command(fake, "omca-reviewer").execute({
    sessionID: "ses_1",
    prompt: { text: "@p.md", files: [{ uri: "file:///p.md", name: "p.md", mention }], agents: [{ name: "omca-explorer", mention }], skills: [{ id: "omca-debugging" }] },
    delivery: "queue",
  })
  expect(fake.prompts[0]).toMatchObject({ files: [{ uri: "file:///p.md", name: "p.md" }], agents: [{ name: "omca-explorer" }], skills: [{ id: "omca-debugging" }] })
  expect(JSON.stringify(fake.prompts[0])).not.toContain('"mention"')
})

test("the context hook pushes the output style only for a primary agent and hides tools for all", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  const fire = (agent: string) => fireContext(fake, agent)
  const primary = await fire("build")
  expect(primary.system).toHaveLength(1)
  expect(primary.system[0]).toMatchObject({ type: "text" })
  expect(Object.keys(primary.tools)).toEqual(["omca_health_check", "omca_evidence_log"])
  const sub = await fire("omca-explorer")
  expect(sub.system).toHaveLength(0)
  expect(sub.tools).not.toHaveProperty("omca_session_search")
})

test("the context hook looks up an agent's mode once and never for omca subagents", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  await fireContext(fake, "build")
  await fireContext(fake, "build")
  await fireContext(fake, "omca-explorer")
  expect(fake.gets).toEqual(["build"])
})

test("command arguments are substituted literally", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  await command(fake, "omca-reviewer").execute({ sessionID: "ses_1", prompt: { text: "p.md $& $$" }, delivery: "queue" })
  expect(String(fake.prompts[0]?.text)).toContain("p.md $& $$")
})

test("the tool hook denies a destructive git command and allows git status", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  const fire = (command: string) => hook(fake, "tool.execute.before")({ sessionID: "ses_one", tool: "shell", input: { command } })
  await expect(fire("git reset --hard HEAD~1")).rejects.toThrow("omca guard: ")
  await expect(fire("git status")).resolves.toBeUndefined()
})

test("the shell hook reads the command in the shell that will run it", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  const fire = (command: string, shell: string) => hook(fake, "shell.create.before")({ command, shell, cwd: fake.ctx.location.directory, timeout: 0, env: {} })
  await expect(fire("rd /s /q C:\\", "C:\\Windows\\System32\\cmd.exe")).rejects.toThrow("omca guard: Destructive rm -rf blocked")
  await expect(fire("Remove-Item -Recurse -Force ~", "pwsh")).rejects.toThrow("omca guard: Destructive rm -rf blocked")
  await expect(fire("git status", "/bin/zsh")).resolves.toBeUndefined()
})

test("the shell hook refuses a command its guard fails on", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  await expect(hook(fake, "shell.create.before")({ command: 42, shell: "/bin/bash" })).rejects.toThrow("omca guard: OMCA's shell guard failed, so the command was refused")
})

test("a throwing required transform fails setup instead of loading a partial plugin", async () => {
  const fake = fakeContext({}, true)
  await expect(plugin.setup(fake.ctx)).rejects.toThrow("agent transform exploded")
  expect(Object.keys(fake.hooks)).toEqual([])
  expect(fake.agents.size).toBe(0)
})

test("registers a visible coordinator without a duplicate MCP transport", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  expect(fake.agents.get("omca")).toMatchObject({ mode: "primary", hidden: false })
  expect(fake.mcp.size).toBe(0)
  expect(fake.tools.has("omca_evidence_log")).toBe(true)
})

test("native Plan omits mutation tools and allows only explicitly read-only children", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  const event = await fireContext(fake, "plan")
  expect(event.tools).not.toHaveProperty("omca_evidence_log")
  for (const target of ["omca-executor", "general", "custom-worker"]) {
    const permission = { action: "subagent", agent: "plan", resources: [target], effect: "allow" }
    await hook(fake, "permission.evaluate")(permission)
    expect(permission.effect).toBe("deny")
  }
  for (const target of ["explore", "omca-explorer", "omca-reviewer"]) {
    const permission = { action: "subagent", agent: "plan", resources: [target], effect: "allow" }
    await hook(fake, "permission.evaluate")(permission)
    expect(permission.effect).toBe("allow")
  }
  const build = { action: "subagent", agent: "build", resources: ["general"], effect: "allow" }
  await hook(fake, "permission.evaluate")(build)
  expect(build.effect).toBe("allow")
})

test("planning command switches only to native Plan and preserves delivery", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  await command(fake, "omca-plan").execute({ sessionID: "ses_one", prompt: { text: "review auth" }, delivery: "queue" })
  expect(fake.session("ses_one").agent).toBe("plan")
  expect(fake.prompts[0]).toMatchObject({ sessionID: "ses_one", delivery: "queue" })
  expect(String(fake.prompts[0]?.text)).toContain("review auth")
})

test("start-work refuses Plan mode before any write permission or binding", async () => {
  const fake = fakeContext()
  fake.session("ses_one").agent = "plan"
  await plugin.setup(fake.ctx)
  await expect(command(fake, "omca-start-work").execute({ sessionID: "ses_one", prompt: { text: "work.md" }, delivery: "steer" })).rejects.toThrow("Switch to Build")
  expect(fake.permissions).toHaveLength(0)
})

test("start-work binds an approved FINAL plan and pause keeps its file", async () => {
  const fake = fakeContext()
  const path = join(fake.ctx.location.directory, "work.md")
  writeFileSync(path, "# Work\n\nStatus: FINAL\n\n- [ ] 1. Implement and test\n")
  await plugin.setup(fake.ctx)
  await command(fake, "omca-start-work").execute({ sessionID: "ses_one", prompt: { text: path }, delivery: "steer" })
  expect(fake.permissions.some((input) => input.action === "omca.start")).toBe(true)
  expect(fake.session("ses_one").agent).toBe("omca")
  expect(readFileSync(join(fake.ctx.location.directory, ".omca", ".gitignore"), "utf8")).toBe("*\n!/rules/\n!/rules/**\n")
  const snapshot = fake.rpcHandlers.snapshot
  expect(snapshot).toBeDefined()
  expect(await snapshot?.({ sessionID: "ses_one" })).toMatchObject({ plan: { name: "work" } })
  await command(fake, "omca-pause").execute({ sessionID: "ses_one" })
  expect(fake.interruptions).toEqual(["ses_one"])
  expect(await snapshot?.({ sessionID: "ses_one" })).toMatchObject({ plan: null })
})

test("RPC refuses a session in a different checkout", async () => {
  const fake = fakeContext()
  const other = join(fake.ctx.location.directory, "other")
  mkdirSync(other)
  fake.session("ses_other").location.directory = other
  await plugin.setup(fake.ctx)
  await expect(fake.rpcHandlers.snapshot?.({ sessionID: "ses_other" })).rejects.toThrow("another checkout")
})

test("RPC authorizes every standard notepad section even when files are absent", async () => {
  const fake = fakeContext()
  const path = join(fake.ctx.location.directory, "work.md")
  writeFileSync(path, "Status: FINAL\n\n- [ ] 1. Work\n")
  await plugin.setup(fake.ctx)
  await command(fake, "omca-start-work").execute({ sessionID: "ses_one", prompt: { text: path }, delivery: "steer" })
  fake.deny((input) => {
    if (input.action === "read" && (input.resources as string[]).includes(".omca/notepads/work/decisions.md")) throw new Error("section denied")
  })
  await expect(fake.rpcHandlers.snapshot?.({ sessionID: "ses_one" })).rejects.toThrow("section denied")
})

test("workflow commands honor registry read and lock-owner edit denials", async () => {
  for (const [action, resource] of [["read", ".omca/state/boulder.json"], ["edit", ".omca/state/boulder.json.lock.d/owner"]]) {
    const fake = fakeContext()
    const path = join(fake.ctx.location.directory, "work.md")
    writeFileSync(path, "Status: FINAL\n\n- [ ] 1. Work\n")
    await plugin.setup(fake.ctx)
    fake.deny((input) => {
      if (input.action === action && (input.resources as string[]).includes(resource!)) throw new Error("native denial")
    })
    await expect(command(fake, "omca-start-work").execute({ sessionID: "ses_one", prompt: { text: path }, delivery: "steer" })).rejects.toThrow("native denial")
    expect(existsSync(join(fake.ctx.location.directory, ".omca"))).toBe(false)
  }
})

test("start-work refuses a plan edited while approval is pending", async () => {
  const fake = fakeContext()
  const path = join(fake.ctx.location.directory, "work.md")
  writeFileSync(path, "Status: FINAL\n\n- [ ] 1. Original\n")
  await plugin.setup(fake.ctx)
  fake.deny((input) => {
    if (input.action === "omca.start") writeFileSync(path, "Status: FINAL\n\n- [ ] 1. Different scope\n")
  })
  await expect(command(fake, "omca-start-work").execute({ sessionID: "ses_one", prompt: { text: path }, delivery: "steer" })).rejects.toThrow("Plan changed")
  expect(existsSync(join(fake.ctx.location.directory, ".omca"))).toBe(false)
})

test("start-work refuses an oversized plan before requesting execution approval", async () => {
  const fake = fakeContext()
  const path = join(fake.ctx.location.directory, "work.md")
  writeFileSync(path, Buffer.alloc(PLAN_FILE_BYTE_LIMIT + 1, "x"))
  await plugin.setup(fake.ctx)
  await expect(command(fake, "omca-start-work").execute({ sessionID: "ses_one", prompt: { text: path }, delivery: "steer" })).rejects.toThrow("native read limit")
  expect(fake.permissions.some((input) => input.action === "omca.start")).toBe(false)
  expect(existsSync(join(fake.ctx.location.directory, ".omca"))).toBe(false)
})

test.skipIf(process.platform === "win32")("start-work refuses identical-content plan retargeting during approval", async () => {
  const fake = fakeContext()
  const path = join(fake.ctx.location.directory, "approved.md")
  const denied = join(fake.ctx.location.directory, "denied.md")
  const content = "Status: FINAL\n\n- [ ] 1. Approved\n"
  writeFileSync(path, content)
  writeFileSync(denied, content)
  await plugin.setup(fake.ctx)
  fake.deny((input) => {
    if (input.action === "read" && (input.resources as string[]).includes("denied.md")) throw new Error("unapproved plan")
    if (input.action === "omca.start") { rmSync(path); symlinkSync(denied, path) }
  })
  await expect(command(fake, "omca-start-work").execute({ sessionID: "ses_one", prompt: { text: path }, delivery: "steer" })).rejects.toThrow("Path changed")
  expect(existsSync(join(fake.ctx.location.directory, ".omca"))).toBe(false)
  expect(fake.prompts).toEqual([])
})

test.each(["read", "edit"])("denying state gitignore %s prevents a first binding", async (action) => {
  const fake = fakeContext()
  const path = join(fake.ctx.location.directory, "work.md")
  writeFileSync(path, "Status: FINAL\n\n- [ ] 1. Work\n")
  await plugin.setup(fake.ctx)
  fake.deny((input) => {
    if (input.action === action && (input.resources as string[]).includes(".omca/.gitignore")) throw new Error("ignore denied")
  })
  await expect(command(fake, "omca-start-work").execute({ sessionID: "ses_one", prompt: { text: path }, delivery: "steer" })).rejects.toThrow("ignore denied")
  expect(existsSync(join(fake.ctx.location.directory, ".omca"))).toBe(false)
})

test.each(["pause", "reload"])("%s supersedes an in-flight start without admitting execution", async (action) => {
  const fake = fakeContext()
  const path = join(fake.ctx.location.directory, "work.md")
  writeFileSync(path, "Status: FINAL\n\n- [ ] 1. Work\n")
  const cleanup = await plugin.setup(fake.ctx)
  let entered!: () => void
  let release!: () => void
  const enteredSwitch = new Promise<void>((resolve) => { entered = resolve })
  const releaseSwitch = new Promise<void>((resolve) => { release = resolve })
  const spy = spyOn(fake.ctx.session, "switchAgent").mockImplementation(async () => {
    entered()
    await releaseSwitch
    fake.session("ses_one").agent = "omca"
  })
  try {
    const start = command(fake, "omca-start-work").execute({ sessionID: "ses_one", prompt: { text: path }, delivery: "steer" })
    const verdict = start.then(() => null, (error: unknown) => error)
    await enteredSwitch
    expect(JSON.parse(readFileSync(join(fake.ctx.location.directory, ".omca", "state", "boulder.json"), "utf8")).bindings).toHaveProperty("opencode:ses_one")
    if (action === "pause") await command(fake, "omca-pause").execute({ sessionID: "ses_one" })
    else {
      if (!cleanup) throw new Error("Plugin did not register cleanup")
      await cleanup()
    }
    release()
    expect(String(await verdict)).toContain("superseded or paused")
    expect(fake.prompts).toEqual([])
    const bindings = JSON.parse(readFileSync(join(fake.ctx.location.directory, ".omca", "state", "boulder.json"), "utf8")).bindings
    if (action === "pause") expect(bindings).not.toHaveProperty("opencode:ses_one")
    else expect(bindings).toHaveProperty("opencode:ses_one")
  } finally {
    release()
    spy.mockRestore()
  }
})

test("native edits invalidate their session and its parent without requiring an open panel", async () => {
  const fake = fakeContext()
  fake.session("ses_child").parentID = "ses_parent"
  await plugin.setup(fake.ctx)
  await hook(fake, "tool.execute.after")({ tool: "edit", sessionID: "ses_child", status: "completed", result: { content: "updated" } })
  expect(fake.invalidations).toEqual(["ses_child", "ses_parent"])
})

test("failed UI invalidation does not turn a completed native edit into a tool failure", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  fake.failInvalidation()
  await expect(hook(fake, "tool.execute.after")({ tool: "patch", sessionID: "ses_one", status: "completed", result: { content: "updated" } })).resolves.toBeUndefined()
  expect(errorSpy).toHaveBeenCalled()
})

test("cancelled RPC inspection stops before file permissions", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  const controller = new AbortController()
  controller.abort()
  await expect(fake.rpcHandlers.snapshot?.({ sessionID: "ses_one" }, { signal: controller.signal })).rejects.toThrow()
  expect(fake.permissions).toHaveLength(0)
})
