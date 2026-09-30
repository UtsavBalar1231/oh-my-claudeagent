import type { Plugin } from "@opencode/plugin"
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import plugin from "./index.ts"

type Rec = Record<string, unknown>
type Hook = (event: Rec) => Promise<void>
type Command = { name: string; execute: (input: Rec) => Promise<void> }

let dirs: string[] = []
let errorSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  errorSpy = spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
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
      prompt: async (input: Rec) => {
        prompts.push(input)
      },
    },
    shell: { hook: hookOn("shell") },
    tool: { hook: hookOn("tool") },
  }
  return { ctx: ctx as unknown as Plugin.Context, agents, skills, commands, mcp, hooks, prompts, gets }
}

async function fireContext(fake: ReturnType<typeof fakeContext>, agent: string) {
  const event = { agent, tools: { omca_session_search: {}, omca_evidence_log: {} }, system: [] as Rec[] }
  await fake.hooks["session.context"]!(event)
  return event
}

const inactiveLine = (system: Rec[]) => system.some((s) => String(s.text).startsWith("OMCA guardrails are inactive on this host"))

const modelErrors = () =>
  errorSpy.mock.calls.filter((args: unknown[]) => String(args[0]).startsWith("omca: ignoring models."))

test("a valid sonnet model ref sets the agent model", async () => {
  const fake = fakeContext({ models: { sonnet: "anthropic/claude-sonnet-5-5" } })
  await plugin.setup(fake.ctx)
  expect(fake.agents.get("omca-explore")?.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-5-5" })
  expect(fake.agents.get("omca-explore")?.mode).toBe("subagent")
  expect(fake.agents.get("omca-explore")?.permissions).toContainEqual({ action: "edit", resource: "*", effect: "deny" })
  expect(modelErrors()).toHaveLength(0)
})

test("an invalid model ref is ignored with exactly one error line", async () => {
  const fake = fakeContext({ models: { sonnet: "bad" } })
  await plugin.setup(fake.ctx)
  expect(fake.agents.get("omca-explore")).toBeDefined()
  expect(fake.agents.get("omca-explore")?.model).toBeUndefined()
  expect(modelErrors()).toHaveLength(1)
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
  const momus = fake.commands.find((c) => c.name === "omca-momus")
  expect(momus).toBeDefined()
  await momus!.execute({ sessionID: "ses_1", prompt: { text: "p.md" }, delivery: "queue" })
  expect(fake.prompts).toHaveLength(1)
  expect(fake.prompts[0]).toMatchObject({ sessionID: "ses_1", delivery: "queue" })
  expect(String(fake.prompts[0]!.text)).toContain("omca-momus")
  expect(String(fake.prompts[0]!.text)).toContain("p.md")
})

test("the context hook pushes the output style only for a primary agent and hides tools for all", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  const fire = (agent: string) => fireContext(fake, agent)
  const primary = await fire("build")
  expect(primary.system).toHaveLength(1)
  expect(primary.system[0]).toMatchObject({ type: "text" })
  expect(primary.tools).not.toHaveProperty("omca_session_search")
  expect(primary.tools).toHaveProperty("omca_evidence_log")
  const sub = await fire("omca-explore")
  expect(sub.system).toHaveLength(0)
  expect(sub.tools).not.toHaveProperty("omca_session_search")
})

test("the context hook looks up an agent's mode once and never for omca subagents", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  await fireContext(fake, "build")
  await fireContext(fake, "build")
  await fireContext(fake, "omca-explore")
  expect(fake.gets).toEqual(["build"])
})

test("a primary agent is told when the guard self-test fails", async () => {
  const shim = mkdtempSync(join(tmpdir(), "omca-shim-"))
  dirs.push(shim)
  writeFileSync(join(shim, "jq"), "#!/bin/sh\nexit 127\n")
  chmodSync(join(shim, "jq"), 0o755)
  const savedPath = process.env.PATH
  process.env.PATH = `${shim}:${savedPath}`
  try {
    const fake = fakeContext()
    await plugin.setup(fake.ctx)
    expect(inactiveLine((await fireContext(fake, "build")).system)).toBe(true)
  } finally {
    process.env.PATH = savedPath
  }
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  expect(inactiveLine((await fireContext(fake, "build")).system)).toBe(false)
})

test("command arguments are substituted literally", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  const momus = fake.commands.find((c) => c.name === "omca-momus")!
  await momus.execute({ sessionID: "ses_1", prompt: { text: "p.md $& $$" }, delivery: "queue" })
  expect(String(fake.prompts[0]!.text)).toContain("p.md $& $$")
})

test("the tool hook denies a destructive git command and allows git status", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.ctx)
  const fire = (command: string) => fake.hooks["tool.execute.before"]!({ tool: "shell", input: { command } })
  await expect(fire("git reset --hard HEAD~1")).rejects.toThrow("omca guard: ")
  await expect(fire("git status")).resolves.toBeUndefined()
})

test("a throwing agent transform does not stop setup or the hooks", async () => {
  const fake = fakeContext({}, true)
  await expect(plugin.setup(fake.ctx)).resolves.toBeUndefined()
  expect(Object.keys(fake.hooks).sort()).toEqual(["session.context", "shell.create.before", "tool.execute.before"])
  expect(fake.agents.size).toBe(0)
})
