import { appendFileSync } from "node:fs"

type Json = Record<string, unknown>
type Tool = { function: { name: string; parameters?: { properties?: Record<string, Json>; required?: string[] } } }
type Message = { role: string; content?: unknown }
type Call = { name: string; arguments: string }

const log = process.env.STUB_LOG
if (!log) throw new Error("STUB_LOG is required")

const SCENARIOS: Record<string, { tool: string; args: Json }> = {
  "shell-reset": { tool: "shell", args: { command: "git reset --hard HEAD~1" } },
  subagent: { tool: "subagent", args: { description: "omca stub", prompt: "OMCA-SCENARIO:shell-reset" } },
  "skill-load": { tool: "skill", args: { id: "omca-handoff" } },
}
const SUBAGENT_ID = "omca-explore"

function text(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
  return ""
}

function fillArgs(tool: Tool, known: Json): Json {
  const params = tool.function.parameters ?? {}
  const props = params.properties ?? {}
  const args: Json = {}
  for (const key of params.required ?? []) {
    if (props[key]?.type === "string") args[key] = "omca-stub"
  }
  for (const [key, value] of Object.entries(known)) if (key in props) args[key] = value
  if (tool.function.name === "subagent") {
    const idKey = Object.keys(props).find((key) => !(key in known) && /agent|type/i.test(key))
    if (idKey) args[idKey] = SUBAGENT_ID
  }
  return args
}

function pickCall(body: Json): Call | undefined {
  const tools = (body.tools ?? []) as Tool[]
  const messages = (body.messages ?? []) as Message[]
  const last = messages.at(-1)
  if (!tools.length || last?.role !== "user") return undefined
  const name = text(last.content).match(/OMCA-SCENARIO:([\w-]+)/)?.[1]
  const scenario = name ? SCENARIOS[name] : undefined
  const tool = tools.find((t) => t.function.name === scenario?.tool)
  if (!scenario || !tool) return undefined
  return { name: tool.function.name, arguments: JSON.stringify(fillArgs(tool, scenario.args)) }
}

function chunk(id: string, model: string, delta: Json, finish: string | null = null) {
  const payload = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] }
  return `data: ${JSON.stringify(payload)}\n\n`
}

function stream(id: string, model: string, call: Call | undefined) {
  const parts = [chunk(id, model, { role: "assistant", content: "" })]
  if (call) {
    parts.push(chunk(id, model, { tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name: call.name, arguments: call.arguments } }] }))
    parts.push(chunk(id, model, {}, "tool_calls"))
  } else {
    parts.push(chunk(id, model, { content: "ok" }))
    parts.push(chunk(id, model, {}, "stop"))
  }
  parts.push("data: [DONE]\n\n")
  return new Response(parts.join(""), { headers: { "content-type": "text/event-stream" } })
}

function complete(id: string, model: string, call: Call | undefined) {
  const message = call
    ? { role: "assistant", content: null, tool_calls: [{ id: `call_${id}`, type: "function", function: call }] }
    : { role: "assistant", content: "ok" }
  return Response.json({
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: call ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

let seq = 0
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.STUB_PORT ?? process.argv[2] ?? 0),
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
    const body = (await req.json()) as Json
    appendFileSync(log, JSON.stringify(body) + "\n")
    const id = `stub${++seq}`
    const model = String(body.model ?? "scripted")
    const call = pickCall(body)
    return body.stream ? stream(id, model, call) : complete(id, model, call)
  },
})

console.log(`listening ${server.port}`)
