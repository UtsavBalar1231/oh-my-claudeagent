import { Agent, Plugin, type Skill } from "@opencode/plugin"
import type { CommandInvocation } from "@opencode/plugin/promise/command"
import { realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { LEDGER } from "../src/core/omca-paths.ts"
import { NOTEPAD_SECTIONS, toPlanName } from "../src/core/notepad.ts"
import { projectRoot } from "../servers/io.ts"
import { checkEdit, checkShell, type GuardResult } from "./guard.ts"
import { generate, parseModelRef } from "./lib.ts"
import { Omca } from "./rpc.ts"
import { operationScope } from "./permissions.ts"
import { currentRun, readSnapshot, readTaskFiles, TASKS_DIR } from "./state.ts"
import { registerTools } from "./tools.ts"
import { COORDINATOR, EXECUTION, PLANNING, READ_ONLY_AGENTS } from "./workflows.ts"

type Context = Plugin.Context
type ModelRef = NonNullable<Agent.Info["model"]>

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const TIERS = ["opus", "sonnet", "fable"]
const HIDDEN_TOOLS = ["omca_session_search", "omca_agents_list", "omca_categories_list", "omca_omca_hook", "omca_agents_migrate"]
const TASK_WRITERS = ["omca_task_create", "omca_task_update"]
const EDIT_TOOLS = ["write", "edit", "patch"]

class GuardDeny extends Error {
  constructor(reason: string) {
    super(`omca guard: ${reason}`)
  }
}

function enforce(result: GuardResult) {
  if (result.deny) throw new GuardDeny(result.reason)
}

// The plugin API does not expose the shell the shell tool runs in. OpenCode falls back to $SHELL
// when none is configured; without one on Windows this assumes PowerShell. The shell hook that
// fires for the same command carries the real shell.
const toolShell = (): string => process.env.SHELL ?? (process.platform === "win32" ? "powershell" : "bash")

// Mention offsets index the typed text, which the template replaces, so only the attachments carry over.
function expand(prompt: CommandInvocation["prompt"], template: string) {
  return {
    text: template.replaceAll("$ARGUMENTS", () => prompt.text),
    ...(prompt.files && { files: prompt.files.map(({ uri, name, description }) => ({ uri, ...(name !== undefined && { name }), ...(description !== undefined && { description }) })) }),
    ...(prompt.agents && { agents: prompt.agents.map(({ name }) => ({ name })) }),
    ...(prompt.skills && { skills: prompt.skills.map(({ id }) => ({ id })) }),
  }
}

function validModels(raw: unknown): Record<string, ModelRef> {
  const out: Record<string, ModelRef> = {}
  if (raw === undefined) return out
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("omca: models must be an object with opus, sonnet and/or fable keys")
  }
  for (const [tier, ref] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = parseModelRef(ref)
    if (!TIERS.includes(tier)) throw new Error(`omca: unknown model tier ${tier}`)
    else if (!parsed) throw new Error(`omca: models.${tier} must be provider/model[#variant]`)
    else out[tier] = parsed as ModelRef
  }
  return out
}

async function setup(ctx: Context) {
  const data = generate(root)
  const models = validModels(ctx.options.models)

  const omcaAgents = new Set(data.agents.map((a) => a.id))
  const getsOutputStyle = new Map<string, boolean>()

  {
    const agents = data.agents.map((a) => {
      const model = models[a.tier]
      const fields: Partial<Agent.Info> = {
        mode: "subagent",
        hidden: false,
        description: a.description,
        system: a.system,
        ...(a.color === undefined ? {} : { color: a.color }),
        ...(model ? { model } : {}),
      }
      const actions = new Set([...a.deny, "subagent", ...(READ_ONLY_AGENTS.has(a.id) ? ["edit", "shell"] : [])])
      const deny = [...actions].map((action) => ({ action, resource: "*", effect: "deny" as const }))
      return { id: a.id, fields, deny }
    })
    await ctx.agent.transform((editor) => {
      for (const { id, fields, deny } of agents) {
        editor.update(id, (agent) => {
          const selectedModel = agent.model
          Object.assign(agent, fields)
          if (selectedModel) agent.model = selectedModel
          agent.permissions = [...agent.permissions, ...deny]
        })
      }
      editor.update("omca", (agent) => {
        agent.name = Agent.Name.make("OMCA")
        agent.mode = "primary"
        agent.hidden = false
        agent.description = "Coordinate specialist agents with a checkout's task list and verification evidence"
        agent.system = `${data.outputStyle}\n${COORDINATOR}`
        agent.color = "#f97316"
        agent.permissions = [...agent.permissions, ...["general", "explore"].map((resource) => ({ action: "subagent", resource, effect: "deny" as const }))]
        if (!agent.model && models.opus) agent.model = models.opus
      })
    })
  }

  {
    const skills = data.skills.map(({ relPath, ...info }) => ({ ...info, path: join(root, relPath) }) as Skill.Info)
    await ctx.skill.transform((editor) => {
      for (const skill of skills) editor.add(skill)
    })
  }

  const sessionAt = (sessionID: string) => ctx.session.get({ sessionID })
  const snapshotFor = async (sessionID: string, signal: AbortSignal) => {
    const session = await sessionAt(sessionID)
    const scope = await operationScope(ctx, { sessionID, ...(session.agent ? { agent: session.agent } : {}), signal })
    const { directory, root: owner } = scope
    if (realpathSync(owner) !== realpathSync(projectRoot(ctx.location.directory))) throw new Error("omca: session moved to another checkout; reopen OMCA at its current location")
    await scope.paths("read", [join(owner, TASKS_DIR), join(owner, LEDGER)], true)
    let run
    try {
      run = currentRun(readTaskFiles(owner).tasks)
    } catch {
      await scope.current()
      return readSnapshot(directory, sessionID)
    }
    if (run) {
      const pad = join(owner, ".omca", "notepads", toPlanName(run.name))
      await scope.paths("read", NOTEPAD_SECTIONS.map((section) => join(pad, `${section}.md`)), true)
    }
    await scope.current()
    return readSnapshot(directory, sessionID, run?.name ?? null)
  }
  const rpc = await ctx.rpc.register(Omca, {
    snapshot: async (input, context) => snapshotFor((input as { sessionID: string }).sessionID, context.signal),
  })
  const changed = async (sessionID: string) => {
    try {
      await rpc.events.emit("updated", { sessionID })
    } catch (error) {
      console.error("omca: could not publish state invalidation; refresh OMCA to reload saved state", error)
    }
  }
  await registerTools(ctx, changed)

  {
    const commands = data.commands.map(({ name, description, template }) => ({
      name,
      description,
      execute: async ({ sessionID, prompt, delivery }: CommandInvocation) => {
        await ctx.session.prompt({ ...expand(prompt, template), sessionID, delivery })
      },
    }))
    await ctx.command.transform((editor) => {
      for (const command of commands) editor.add(command)
      editor.add({
        name: "omca-plan",
        description: "Discuss an OMCA plan in native Plan mode without implementing it",
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.switchAgent({ sessionID, agent: "plan" })
          await ctx.session.prompt({ ...expand(prompt, PLANNING), sessionID, delivery })
        },
      })
      editor.add({
        name: "omca-start-work",
        description: "Approve and run a plan, or the open run on this checkout's task list, in Build or OMCA",
        execute: async ({ sessionID, prompt, delivery }) => {
          const session = await sessionAt(sessionID)
          if (session.agent === "plan") throw new Error("Switch to Build or OMCA before starting work")
          await ctx.permission.assert({ sessionID, action: "omca.start", resources: [prompt.text.trim() || "*"], save: [] })
          await ctx.session.switchAgent({ sessionID, agent: "omca" })
          await ctx.session.prompt({ ...expand(prompt, EXECUTION), sessionID, delivery })
        },
      })
    })
  }

  await ctx.permission.hook("evaluate", (event) => {
    if (event.action === "omca.start") {
      event.effect = "ask"
      event.message = "Start OMCA execution of this plan in the current session?"
    }
    if (event.agent === "plan" && event.action === "subagent" && event.resources.some((id) => id !== "explore" && !READ_ONLY_AGENTS.has(id))) {
      event.effect = "deny"
      event.message = "OMCA planning cannot launch execution-capable specialists"
    }
  })

  await ctx.session.hook("context", async (event) => {
    for (const tool of HIDDEN_TOOLS) delete event.tools[tool]
    if (event.agent === "omca") delete event.tools.todowrite
    else for (const tool of TASK_WRITERS) delete event.tools[tool]
    if (event.agent === "plan") {
      for (const tool of ["omca_evidence_log", "omca_notepad_write", "omca_notepad_compact"]) delete event.tools[tool]
    }
    if (!event.agent || event.agent === "omca" || omcaAgents.has(event.agent)) return
    let primary = getsOutputStyle.get(event.agent)
    if (primary === undefined) {
      const agent = await ctx.agent.get({ agentID: event.agent })
      primary = agent.data.mode === "primary" || agent.data.mode === "all"
      getsOutputStyle.set(event.agent, primary)
    }
    if (primary && data.outputStyle) event.system.push({ type: "text", text: data.outputStyle })
  })

  await ctx.session.hook("compaction", (event) => {
    if (event.agent === "omca") event.system.push({ type: "text", text: "Keep the approved objective, pending child work, blockers, and next task. Re-read omca_task_list after compaction; the stored task list and evidence remain authoritative." })
  })

  await ctx.shell.hook("create.before", async (event) => {
    enforce(checkShell(event.command, projectRoot(event.cwd), event.shell, event.cwd))
  })

  await ctx.tool.hook("execute.before", async (event) => {
    if (event.tool !== "shell" && !EDIT_TOOLS.includes(event.tool)) return
    const input = (event.input ?? {}) as Record<string, unknown>
    const session = await sessionAt(event.sessionID)
    const directory = session.location.directory
    if (event.tool === "shell") {
      const cwd = typeof input.workdir === "string" ? input.workdir : directory
      enforce(checkShell(String(input.command ?? ""), projectRoot(directory), toolShell(), cwd))
    } else {
      enforce(checkEdit(event.tool, input, directory))
    }
  })

  await ctx.tool.hook("execute.after", async (event) => {
    if (event.tool !== "shell" && !EDIT_TOOLS.includes(event.tool)) return
    await changed(event.sessionID)
    try {
      const { parentID } = await sessionAt(event.sessionID)
      if (parentID) await changed(parentID)
    } catch (error) {
      console.error("omca: could not refresh the parent session after a native mutation", error)
    }
  })
}

export default Plugin.define({ id: "omca", setup })
