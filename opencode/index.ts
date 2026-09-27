import type { Agent, Mcp, Plugin, Skill } from "@opencode/plugin"
import type { CommandInvocation } from "@opencode/plugin/promise/command"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { checkEdit, checkShell, guardSelfTest, type GuardResult } from "./guard.ts"
import { generate, parseModelRef, type Prompts } from "./lib.ts"

type Context = Plugin.Context
type ModelRef = NonNullable<Agent.Info["model"]>

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const TIERS = ["opus", "fable"]
const HIDDEN_TOOLS = ["omca_session_search", "omca_agents_list", "omca_categories_list", "omca_validate_plan_write", "omca_boulder_write"]
const EDIT_TOOLS = ["write", "edit", "patch"]
const GUARDS_INACTIVE =
  "OMCA guardrails are inactive on this host (the guard scripts could not run). Ask the user for explicit confirmation before any destructive git or rm command."

let prompts: Prompts | undefined

function loadPrompts(): Prompts {
  if (prompts) return prompts
  try {
    prompts = generate(root)
  } catch (err) {
    console.error(`omca: prompt translation failed: ${err}`)
    prompts = { agents: [], skills: [], commands: [], outputStyle: "" }
  }
  return prompts
}

class GuardDeny extends Error {
  constructor(reason: string) {
    super(`omca guard: ${reason}`)
  }
}

function enforce(result: GuardResult) {
  if (result.deny) throw new GuardDeny(result.reason)
}

function validModels(raw: unknown): Record<string, ModelRef> {
  const out: Record<string, ModelRef> = {}
  if (raw === undefined) return out
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.error(`omca: ignoring models. Expected an object with opus and/or fable keys, got ${JSON.stringify(raw)}`)
    return out
  }
  for (const [tier, ref] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = parseModelRef(ref)
    if (!TIERS.includes(tier)) console.error(`omca: ignoring models.${tier}: unknown tier, expected opus or fable`)
    else if (!parsed) console.error(`omca: ignoring models.${tier}: ${JSON.stringify(ref)} is not provider/model[#variant]`)
    else out[tier] = parsed as ModelRef
  }
  return out
}

function astGrepAvailable() {
  const env = process.env.AST_GREP_BIN
  if ((env && Bun.which(env)) || Bun.which("ast-grep")) return true
  const sg = Bun.which("sg")
  return !!sg && Bun.spawnSync([sg, "--version"]).stdout.toString().toLowerCase().includes("ast-grep")
}

async function register(name: string, fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch (err) {
    console.error(`omca: ${name} registration failed: ${err}`)
  }
}

function guarded<T>(name: string, fn: (event: T) => Promise<void>) {
  return async (event: T) => {
    try {
      await fn(event)
    } catch (err) {
      if (err instanceof GuardDeny) throw err
      console.error(`omca: ${name} hook failed: ${err}`)
    }
  }
}

async function setup(ctx: Context) {
  const projectRoot = ctx.location.directory
  const data = loadPrompts()

  const guardsInactive = guardSelfTest(root).then(
    (failed) => {
      if (failed.length) console.error(`omca: guard self-test failed for ${failed.join(", ")}; the guards need bash 4.3+ and jq`)
      return failed.length > 0
    },
    (err) => {
      console.error(`omca: guard self-test failed; the guards need bash 4.3+ and jq: ${err}`)
      return true
    },
  )
  const omcaAgents = new Set(data.agents.map((a) => a.id))
  const getsOutputStyle = new Map<string, boolean>()

  // Transform callbacks only assign precomputed values: one throwing transform disables the whole plugin.
  await register("agents", async () => {
    const models = validModels(ctx.options.models)
    const agents = data.agents.map((a) => {
      const model = models[a.tier]
      const fields: Partial<Agent.Info> = {
        mode: "subagent",
        hidden: false,
        description: a.description,
        system: a.system,
        ...(a.steps === undefined ? {} : { steps: a.steps }),
        ...(a.color === undefined ? {} : { color: a.color }),
        ...(model ? { model } : {}),
      }
      const deny = a.deny.map((action) => ({ action, resource: "*", effect: "deny" as const }))
      return { id: a.id, fields, deny }
    })
    await ctx.agent.transform((editor) => {
      for (const { id, fields, deny } of agents) {
        editor.update(id, (agent) => {
          Object.assign(agent, fields)
          agent.permissions = [...agent.permissions, ...deny]
        })
      }
    })
  })

  await register("skills", async () => {
    const skills = data.skills.map(({ relPath, ...info }) => ({ ...info, path: join(root, relPath) }) as Skill.Info)
    await ctx.skill.transform((editor) => {
      for (const skill of skills) editor.add(skill)
    })
  })

  await register("commands", async () => {
    const commands = data.commands.map(({ name, description, template }) => ({
      name,
      description,
      execute: async ({ sessionID, prompt, delivery }: CommandInvocation) => {
        await ctx.session.prompt({ ...prompt, sessionID, delivery, text: template.replaceAll("$ARGUMENTS", () => prompt.text) })
      },
    }))
    await ctx.command.transform((editor) => {
      for (const command of commands) editor.add(command)
    })
  })

  await register("mcp", async () => {
    if (!Bun.which("uv") || !astGrepAvailable()) {
      console.error("omca: MCP server not registered; it needs uv and ast-grep on PATH")
      return
    }
    const config: Mcp.ServerConfig = {
      type: "local",
      command: ["uv", "run", "--project", join(root, "servers"), "python", join(root, "servers/omca-mcp.py")],
      environment: { CLAUDE_PROJECT_ROOT: projectRoot, CLAUDE_PROJECT_DIR: projectRoot, CLAUDE_PLUGIN_ROOT: root },
      codemode: false,
      timeout: { startup: 120000 },
    }
    await ctx.mcp.transform((editor) => editor.set("omca", config))
  })

  await register("context hook", () =>
    ctx.session.hook(
      "context",
      guarded("context", async (event) => {
        for (const tool of HIDDEN_TOOLS) delete event.tools[tool]
        if (!event.agent || omcaAgents.has(event.agent)) return
        let primary = getsOutputStyle.get(event.agent)
        if (primary === undefined) {
          const agent: Awaited<ReturnType<Context["agent"]["get"]>> = await ctx.agent.get({ agentID: event.agent })
          primary = agent.data.mode === "primary" || agent.data.mode === "all"
          getsOutputStyle.set(event.agent, primary)
        }
        if (!primary) return
        if (data.outputStyle) event.system.push({ type: "text", text: data.outputStyle })
        if (await guardsInactive) event.system.push({ type: "text", text: GUARDS_INACTIVE })
      }),
    ),
  )

  await register("shell guard hook", () =>
    ctx.shell.hook(
      "create.before",
      guarded("shell guard", async (event) => enforce(await checkShell(root, event.command, { cwd: event.cwd, projectRoot }))),
    ),
  )

  await register("tool guard hook", () =>
    ctx.tool.hook(
      "execute.before",
      guarded("tool guard", async (event) => {
        const input = (event.input ?? {}) as Record<string, unknown>
        if (event.tool === "shell") {
          const workdir = typeof input.workdir === "string" ? input.workdir : "."
          enforce(await checkShell(root, String(input.command ?? ""), { cwd: resolve(projectRoot, workdir), projectRoot }))
        } else if (EDIT_TOOLS.includes(event.tool)) {
          enforce(await checkEdit(root, event.tool, input, projectRoot))
        }
      }),
    ),
  )
}

export default { id: "omca", setup } satisfies Plugin.Plugin
