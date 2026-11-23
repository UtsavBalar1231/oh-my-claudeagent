import type { Plugin } from "@opencode/plugin"
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import plugin from "./index.ts"

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
  const stored = new Map<string, unknown>()
  let permission = (_input: Rec) => {}
  let listed: Rec[] | Error = []
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
    app: { version: "2.3.2" },
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
    model: {
      list: async () => {
        if (listed instanceof Error) throw listed
        return { data: listed }
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
    storage: {
      get: async (key: string) => stored.get(key),
      set: async (key: string, value: unknown) => { stored.set(key, value) },
      remove: async (key: string) => { stored.delete(key) },
    },
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
  return { ctx: ctx as unknown as Plugin.Context, agents, skills, commands, mcp, hooks, prompts, gets, tools, permissions, sessions, session, rpcHandlers, stored, interruptions, invalidations, failInvalidation: () => { failInvalidation = true }, deny: (fn: typeof permission) => { permission = fn }, list: (models: Rec[] | Error) => { listed = models } }
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

async function fireContext(fake: ReturnType<typeof fakeContext>, agent: string, sessionID = "ses_one") {
  const event = { sessionID, agent, tools: { omca_health_check: {}, omca_evidence_log: {}, omca_task_create: {}, omca_task_update: {}, omca_task_list: {}, omca_task_get: {}, todowrite: {}, write: {}, shell: {} }, system: [] as Rec[] }
  await hook(fake, "session.context")(event)
  return event
}

test("a valid sonnet model ref sets the agent model, with no variant stamped on it", async () => {
  const fake = fakeContext({ models: { sonnet: "anthropic/claude-sonnet-5-5" } })
  await plugin.setup(fake.ctx)
  expect(fake.agents.get("omca-explorer")?.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-5-5" })
  expect(fake.agents.get("omca-explorer")?.mode).toBe("subagent")
  expect(fake.agents.get("omca-explorer")?.permissions).toContainEqual({ action: "edit", resource: "*", effect: "deny" })
  expect(errorSpy).not.toHaveBeenCalled()
})

const variants = (providerID: string, id: string, names: string[]) => ({ providerID, id, variants: names.map((name) => ({ id: name })) })

async function resolved(fake: ReturnType<typeof fakeContext>, agent: string, model: Rec) {
  const event = { sessionID: "ses_one", agent, kind: "primary", model }
  await hook(fake, "session.experimental.model.resolve")(event)
  return event.model
}

test("each agent runs its tier's model at its own declared effort when the model offers that variant", async () => {
  const fake = fakeContext({ models: { opus: "openai/gpt-6.1-sol", sonnet: "openai/gpt-6.1-terra", fable: "openai/gpt-6-astra" } })
  await plugin.setup(fake.ctx)
  fake.list([variants("openai", "gpt-6.1-sol", ["low", "medium", "high", "xhigh"]), variants("openai", "gpt-6.1-terra", ["low", "medium", "high"]), variants("openai", "gpt-6-astra", ["high", "xhigh"])])
  const effective = async (id: string) => resolved(fake, id, { ...(fake.agents.get(id)?.model as Rec), variant: "default" })
  expect(await effective("omca-architect")).toEqual({ providerID: "openai", id: "gpt-6-astra", variant: "xhigh" })
  expect(await effective("omca-build-fixer")).toEqual({ providerID: "openai", id: "gpt-6.1-sol", variant: "medium" })
  expect(await effective("omca-analyzer")).toEqual({ providerID: "openai", id: "gpt-6.1-sol", variant: "high" })
  expect(await effective("omca-executor")).toEqual({ providerID: "openai", id: "gpt-6.1-terra", variant: "high" })
  expect(fake.agents.get("omca")?.model).toEqual({ providerID: "openai", id: "gpt-6.1-sol" })
})

test("an effort the model does not offer leaves the request on the model's default", async () => {
  const fake = fakeContext({ models: { fable: "stub/defaults", sonnet: "stub/noreason" } })
  await plugin.setup(fake.ctx)
  fake.list([variants("stub", "defaults", ["low", "medium", "high"]), variants("stub", "noreason", [])])
  expect(await resolved(fake, "omca-architect", { providerID: "stub", id: "defaults", variant: "default" })).toEqual({ providerID: "stub", id: "defaults", variant: "default" })
  expect(await resolved(fake, "omca-explorer", { providerID: "stub", id: "noreason" })).toEqual({ providerID: "stub", id: "noreason" })
})

test("the effort applies only to the agent's own tier model, and never over a chosen variant", async () => {
  const fake = fakeContext({ models: { opus: "openai/gpt-6.1-sol#xhigh", sonnet: "openai/gpt-6.1-terra" } })
  await plugin.setup(fake.ctx)
  fake.list([variants("openai", "gpt-6.1-sol", ["medium", "xhigh"]), variants("openai", "gpt-6.1-terra", ["high"]), variants("openai", "other", ["high"])])
  expect(fake.agents.get("omca-build-fixer")?.model).toEqual({ providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" })
  expect(await resolved(fake, "omca-build-fixer", { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" })).toEqual({ providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" })
  expect(await resolved(fake, "omca-executor", { providerID: "openai", id: "gpt-6.1-terra", variant: "low" })).toEqual({ providerID: "openai", id: "gpt-6.1-terra", variant: "low" })
  expect(await resolved(fake, "omca-executor", { providerID: "openai", id: "other" })).toEqual({ providerID: "openai", id: "other" })
  expect(await resolved(fake, "build", { providerID: "openai", id: "gpt-6.1-terra" })).toEqual({ providerID: "openai", id: "gpt-6.1-terra" })
})

test("a model listing that fails is logged and leaves the request as it was", async () => {
  const fake = fakeContext({ models: { sonnet: "openai/gpt-6.1-terra" } })
  await plugin.setup(fake.ctx)
  fake.list(new Error("models unavailable"))
  expect(await resolved(fake, "omca-executor", { providerID: "openai", id: "gpt-6.1-terra" })).toEqual({ providerID: "openai", id: "gpt-6.1-terra" })
  expect(errorSpy).toHaveBeenCalledTimes(1)
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
  expect(fake.prompts[0]).toMatchObject({ sessionID: "ses_1", delivery: "queue", metadata: { source: "omca.command" } })
  expect(String(fake.prompts[0]?.text)).toContain("omca-reviewer")
  expect(String(fake.prompts[0]?.text)).toContain("p.md")
})

test("a command keeps its attachments and drops mention offsets into the replaced text", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  const mention = { start: 0, end: 5, text: "@p.md" }
  await command(fake, "omca-reviewer").execute({
    sessionID: "ses_1",
    prompt: { text: "@p.md", files: [{ uri: "file:///p.md", name: "p.md", mention, source: { type: "uri", uri: "file:///p.md" } }], agents: [{ name: "omca-explorer", mention }], skills: [{ id: "omca-debugging" }] },
    delivery: "queue",
  })
  expect(fake.prompts[0]).toMatchObject({ files: [{ uri: "file:///p.md", name: "p.md", source: { type: "uri", uri: "file:///p.md" } }], agents: [{ name: "omca-explorer" }], skills: [{ id: "omca-debugging" }] })
  expect(JSON.stringify(fake.prompts[0])).not.toContain('"mention"')
})

test("the context hook pushes the output style only for a primary agent and hides tools for all", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  const fire = (agent: string) => fireContext(fake, agent)
  const primary = await fire("build")
  expect(primary.system).toHaveLength(1)
  expect(primary.system[0]).toMatchObject({ type: "text" })
  expect(Object.keys(primary.tools)).toEqual(["omca_health_check", "omca_evidence_log", "omca_task_list", "omca_task_get", "todowrite", "write", "shell"])
  const sub = await fire("omca-explorer")
  expect(sub.system).toHaveLength(0)
  expect(Object.keys(sub.tools)).toEqual(["omca_health_check", "omca_evidence_log", "omca_task_list", "omca_task_get", "todowrite"])
  expect(Object.keys((await fire("omca-executor")).tools)).toEqual(["omca_health_check", "omca_evidence_log", "omca_task_list", "omca_task_get", "todowrite", "write", "shell"])
})

test("the context hook looks up an agent's mode once and never for omca subagents", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  await fireContext(fake, "build")
  await fireContext(fake, "build")
  await fireContext(fake, "omca-explorer")
  expect(fake.gets).toEqual(["build"])
})

function seedRun(fake: ReturnType<typeof fakeContext>, tasks: Rec[] = [{ id: "1", subject: "Work", status: "pending", metadata: { run: "work" } }]) {
  const dir = join(fake.ctx.location.directory, ".omca", "state", "tasks")
  mkdirSync(dir, { recursive: true })
  for (const task of tasks) writeFileSync(join(dir, `${String(task.id)}.json`), JSON.stringify(task))
  return dir
}

test("OMCA workers learn the open run's name once per session, read-only ones without the notepad call, and Build does not", async () => {
  const fake = fakeContext()
  const dir = seedRun(fake)
  await plugin.setup(fake.ctx)
  expect((await fireContext(fake, "omca-executor")).system).toEqual([{ type: "text", text: '[ACTIVE RUN] work. Record discoveries with omca_notepad_write, plan_name "work", in the section learnings, issues, decisions or problems.' }])
  expect((await fireContext(fake, "omca-explorer", "ses_two")).system).toEqual([{ type: "text", text: "[ACTIVE RUN] work. Put discoveries, issues and decisions in your report for the coordinator to record; do not call omca_notepad_write." }])
  expect((await fireContext(fake, "build", "ses_three")).system.some((part) => String(part.text).includes("[ACTIVE RUN]"))).toBe(false)
  rmSync(dir, { recursive: true })
  expect((await fireContext(fake, "omca-executor")).system).toHaveLength(1)
  expect((await fireContext(fake, "omca-executor", "ses_four")).system).toEqual([])
})

test("the coordinator's own check holds its task completions until it logs evidence, and a failed shell call records nothing", async () => {
  const fake = fakeContext()
  seedRun(fake, [1, 2].map((id) => ({ id: String(id), subject: "Work", status: "pending", metadata: { run: "work" } })))
  await plugin.setup(fake.ctx)
  fake.session("ses_one").agent = "omca"
  const context = { sessionID: "ses_one", agent: "omca", messageID: "msg_1", id: "call_1", signal: new AbortController().signal, progress: async () => {} }
  const call = (name: string, input: Rec) => (fake.tools.get(`omca_${name}`) as unknown as { execute(input: Rec, context: Rec): Promise<Rec> }).execute(input, { ...context, id: crypto.randomUUID() })
  const after = hook(fake, "tool.execute.after")
  await after({ tool: "shell", sessionID: "ses_one", status: "error", input: { command: "bun test" }, error: new Error("refused") })
  expect((await call("task_update", { taskId: "1", status: "completed" })).content).toBe("Task #1 [completed] Work")
  await after({ tool: "shell", sessionID: "ses_one", status: "completed", input: { command: "bun test" }, result: { output: { exitCode: 1 }, content: [] } })
  await expect(call("task_update", { taskId: "2", status: "completed" })).rejects.toThrow("You ran `bun test`")
  await call("evidence_log", { evidence_type: "test", command: "bun test", exit_code: 1, output_snippet: "1 failing" })
  expect((await call("task_update", { taskId: "2", status: "completed" })).content).toBe("Task #2 [completed] Work")
})

test("command arguments are substituted literally", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  await command(fake, "omca-reviewer").execute({ sessionID: "ses_1", prompt: { text: "p.md $& $$" }, delivery: "queue" })
  expect(String(fake.prompts[0]?.text)).toContain("p.md $& $$")
})

test("the tool hook denies a commit that skips its hooks and allows git status", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  const fire = (command: string) => hook(fake, "tool.execute.before")({ sessionID: "ses_one", tool: "shell", input: { command } })
  await expect(fire("git commit --no-verify -m x")).rejects.toThrow("omca guard: git commit --no-verify blocked")
  await expect(fire("git status")).resolves.toBeUndefined()
})

test("the tool hook holds the specialists' contract whatever the permission rules allow", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  const fire = (agent: string, tool: string, input: Rec = {}) => hook(fake, "tool.execute.before")({ sessionID: "ses_one", agent, tool, input })
  await expect(fire("omca-explorer", "write", { path: "x.txt", content: "x" })).rejects.toThrow("omca guard: omca-explorer is read-only, so it cannot run write")
  await expect(fire("omca-architect", "opencode_worktree_create", { name: "w" })).rejects.toThrow("omca guard: omca-architect is read-only")
  await expect(fire("omca-executor", "subagent", { agent: "omca-explorer", prompt: "look" })).rejects.toThrow("omca guard: omca-executor is a specialist and does not delegate")
  await expect(fire("omca", "subagent", { agent: "general", prompt: "look" })).rejects.toThrow("omca guard: OMCA delegates to its own specialists")
  await expect(fire("omca", "subagent", { agent: "omca-explorer", prompt: "look around the repository" })).resolves.toBeUndefined()
})

test("a relative or home workdir is read in the session's directory, not the server's", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  const directory = fake.ctx.location.directory
  execFileSync("git", ["init", "-q"], { cwd: directory })
  mkdirSync(join(directory, "sub"))
  writeFileSync(join(directory, "sub", "dirty.txt"), "x")
  execFileSync("git", ["add", "."], { cwd: directory })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x"], { cwd: directory })
  const fire = (workdir: string) => hook(fake, "tool.execute.before")({ sessionID: "ses_one", agent: "build", tool: "shell", input: { command: "git reset --hard", workdir } })
  await expect(fire("sub")).resolves.toBeUndefined()
  writeFileSync(join(directory, "sub", "dirty.txt"), "changed")
  await expect(fire("sub")).rejects.toThrow("omca guard:")
  await expect(fire(join(directory, "sub"))).rejects.toThrow("omca guard:")
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

test("only the coordinator denies built-in workers and preserves other permissions", async () => {
  const fake = fakeContext()
  const permissions = [{ action: "subagent", resource: "custom-worker", effect: "ask" }]
  fake.agents.set("omca", { permissions: [...permissions] })
  for (const id of ["build", "plan", "general", "explore", "custom-worker"]) {
    fake.agents.set(id, { id, permissions: [...permissions] })
  }
  await plugin.setup(fake.ctx)
  expect(fake.agents.get("omca")?.permissions).toEqual([
    ...permissions,
    { action: "subagent", resource: "general", effect: "deny" },
    { action: "subagent", resource: "explore", effect: "deny" },
  ])
  for (const id of ["build", "plan", "general", "explore", "custom-worker"]) {
    expect(fake.agents.get(id)).toEqual({ id, permissions })
  }
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

test("only the coordinator is offered the task writers, and it gets one list", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  const coordinator = await fireContext(fake, "omca")
  expect(Object.keys(coordinator.tools)).toEqual(["omca_health_check", "omca_evidence_log", "omca_task_create", "omca_task_update", "omca_task_list", "omca_task_get", "write", "shell"])
  for (const agent of ["build", "plan", "omca-executor"]) {
    const { tools } = await fireContext(fake, agent)
    expect(tools).not.toHaveProperty("omca_task_create")
    expect(tools).not.toHaveProperty("omca_task_update")
    expect(tools).toHaveProperty("omca_task_list")
  }
})

test("start-work refuses Plan mode before changing anything", async () => {
  const fake = fakeContext()
  fake.session("ses_one").agent = "plan"
  await plugin.setup(fake.ctx)
  await expect(command(fake, "omca-start-work").execute({ sessionID: "ses_one", prompt: { text: "work.md" }, delivery: "steer" })).rejects.toThrow("Switch to Build")
  expect(fake.permissions).toHaveLength(0)
  expect(fake.prompts).toEqual([])
})

test("start-work is its own approval: it asks nothing more, switches to the coordinator and writes no state", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  await command(fake, "omca-start-work").execute({ sessionID: "ses_one", prompt: { text: " plans/work.md " }, delivery: "steer" })
  expect(fake.permissions).toEqual([])
  expect(fake.session("ses_one").agent).toBe("omca")
  expect(fake.prompts[0]).toMatchObject({ sessionID: "ses_one", delivery: "steer" })
  expect(String(fake.prompts[0]?.text)).toStartWith("The user ran /omca-start-work and approved it.")
  expect(String(fake.prompts[0]?.text)).toContain("Read omca_task_list first.")
  expect(String(fake.prompts[0]?.text)).toEndWith("Plan document or instructions:\n plans/work.md ")
  expect(existsSync(join(fake.ctx.location.directory, ".omca"))).toBe(false)
})

test("start-work with no argument continues the open run without a permission prompt", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  await command(fake, "omca-start-work").execute({ sessionID: "ses_one", prompt: { text: "" }, delivery: "steer" })
  expect(fake.permissions).toEqual([])
  expect(fake.session("ses_one").agent).toBe("omca")
  expect(String(fake.prompts[0]?.text)).toStartWith("The user ran /omca-start-work and approved it.")
})

test("the panel reads the checkout's run for any session in it", async () => {
  const fake = fakeContext()
  const dir = join(fake.ctx.location.directory, ".omca", "state", "tasks")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "1.json"), JSON.stringify({ id: "1", subject: "Work", status: "pending", metadata: { run: "work" } }))
  await plugin.setup(fake.ctx)
  expect(await fake.rpcHandlers.snapshot?.({ sessionID: "ses_two" })).toMatchObject({ run: { name: "work", tasks: [{ id: "1", subject: "Work" }] } })
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
  const dir = join(fake.ctx.location.directory, ".omca", "state", "tasks")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "1.json"), JSON.stringify({ id: "1", subject: "Work", status: "pending", metadata: { run: "work" } }))
  await plugin.setup(fake.ctx)
  fake.deny((input) => {
    if (input.action === "read" && (input.resources as string[]).includes(".omca/notepads/work/decisions.md")) throw new Error("section denied")
  })
  await expect(fake.rpcHandlers.snapshot?.({ sessionID: "ses_one" })).rejects.toThrow("section denied")
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
