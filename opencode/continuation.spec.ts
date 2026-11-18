import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import type { NativeTask, TaskStatus } from "../src/core/native-tasks.ts"
import { COMMAND_SOURCE, CONTINUATION_SOURCE, createContinuation, MAX_ROUNDS, MAX_STALLS, nudge, type ContinuationHost } from "./continuation.ts"

type Message = Awaited<ReturnType<ContinuationHost["messages"]>>[number]
type Admitted = Parameters<ContinuationHost["admit"]>[0]

const ROOT = "/repo"
const savedSwitch = process.env.OMCA_DISABLED_HOOKS
let errorSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  delete process.env.OMCA_DISABLED_HOOKS
  errorSpy = spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  if (savedSwitch === undefined) delete process.env.OMCA_DISABLED_HOOKS
  else process.env.OMCA_DISABLED_HOOKS = savedSwitch
  errorSpy.mockRestore()
})

const task = (id: string, status: TaskStatus, extra: Partial<NativeTask> = {}): NativeTask => ({
  id, subject: `Task ${id}`, description: "", activeForm: "", status, owner: "", blocks: [], blockedBy: [], run: "work", isFinal: false, blockedReason: "", details: [], ...extra,
})

function fake(stored = new Map<string, unknown>()) {
  const session = { parentID: undefined as string | undefined, agent: "omca", location: { directory: ROOT } }
  const state = {
    session,
    tasks: [task("1", "completed"), task("2", "in_progress"), task("3", "pending", { blockedBy: ["2"], isFinal: true })],
    messages: [{ type: "user", text: "/omca-start-work" }] as Message[],
    admitted: [] as Admitted[],
    changed: [] as string[],
    fail: false,
  }
  const host: ContinuationHost = {
    session: async () => state.session,
    messages: async () => {
      if (state.fail) throw new Error("context unavailable")
      return state.messages
    },
    tasks: () => state.tasks,
    rootOf: (directory) => directory,
    admit: async (input) => {
      state.admitted.push(input)
      state.messages.push({ type: "synthetic", text: input.text, metadata: input.metadata })
    },
    changed: async (sessionID) => { state.changed.push(sessionID) },
    load: async (sessionID) => {
      if (state.fail) throw new Error("storage unavailable")
      return stored.get(sessionID)
    },
    save: async (sessionID, record) => {
      if (state.fail) throw new Error("storage unavailable")
      if (record === undefined) stored.delete(sessionID)
      else stored.set(sessionID, structuredClone(record))
    },
  }
  const continuation = createContinuation(host)
  const idle = (background: { kind: string; sessionID: string; command?: string }[] = []) => continuation.idle({ sessionID: "ses", background })
  const say = (text: string, metadata?: Record<string, unknown>) => continuation.prompt({ sessionID: "ses", prompt: { text }, metadata })
  const reply = (tool: boolean) => state.messages.push({ type: "assistant", content: tool ? [{ type: "tool" }, { type: "text" }] : [{ type: "text" }] })
  return { state, continuation, idle, reply, say, stored, host }
}

test("an armed coordinator session with open tasks gets one continuation naming the run and the next task", async () => {
  const f = fake()
  await f.continuation.touch("ses", ROOT)
  await f.idle()
  expect(f.state.admitted).toEqual([{
    sessionID: "ses",
    text: nudge("work", 2, f.state.tasks[1]!),
    description: "OMCA continues work: 2 open, next #2",
    metadata: { source: CONTINUATION_SOURCE, run: "work" },
  }])
  expect(f.state.admitted[0]?.text).toStartWith('[OMCA CONTINUATION] Run "work" was approved with /omca-start-work and still has 2 open tasks; the next is #2 Task 2.')
  expect(f.state.changed).toEqual(["ses"])
  expect(await f.continuation.status("ses")).toEqual({ state: "on", reason: "" })
})

test("a session that never took the run on is left idle", async () => {
  const f = fake()
  await f.idle()
  expect(f.state.admitted).toEqual([])
  expect(await f.continuation.status("ses")).toEqual({ state: "off", reason: "" })
})

test("the session waits on its own subagent, image, script or check, but not on another shell or another session's work", async () => {
  const f = fake()
  await f.continuation.touch("ses", ROOT)
  for (const kind of ["subagent", "image", "codemode"]) await f.idle([{ kind, sessionID: "ses" }])
  await f.idle([{ kind: "shell", sessionID: "ses", command: "cd web && bun test" }])
  expect(f.state.admitted).toEqual([])
  await f.idle([{ kind: "shell", sessionID: "ses", command: "bun run dev" }, { kind: "shell", sessionID: "child", command: "just ci" }, { kind: "subagent", sessionID: "child" }])
  expect(f.state.admitted).toHaveLength(1)
})

test.each([
  ["a child session", { parentID: "parent" }],
  ["another agent", { agent: "build" }],
  ["a session that moved to another checkout", { location: { directory: "/elsewhere" } }],
])("%s is not continued and stops being armed", async (_name, change) => {
  const f = fake()
  await f.continuation.touch("ses", ROOT)
  Object.assign(f.state.session, change)
  await f.idle()
  expect(f.state.admitted).toEqual([])
  expect(await f.continuation.status("ses")).toEqual({ state: "off", reason: "" })
})

test("a run with no open task disarms the session and refreshes the panel", async () => {
  const f = fake()
  await f.continuation.touch("ses", ROOT)
  f.state.tasks = [task("1", "completed"), task("2", "pending", { blockedReason: "needs hardware" })]
  await f.idle()
  expect(f.state.admitted).toEqual([])
  expect(await f.continuation.status("ses")).toEqual({ state: "off", reason: "" })
  expect(f.state.changed).toEqual(["ses"])
})

test("a run whose open tasks all wait on each other still continues with the first open task", async () => {
  const f = fake()
  await f.continuation.touch("ses", ROOT)
  f.state.tasks = [task("1", "pending", { blockedBy: ["2"] }), task("2", "pending", { blockedBy: ["1"] })]
  await f.idle()
  expect(f.state.admitted[0]?.description).toBe("OMCA continues work: 2 open, next #1")
})

test.each(["ok, stop here", "Let's pause for now.", "thats enough for today"])("the user's pause request %p holds the run", async (text) => {
  const f = fake()
  await f.continuation.touch("ses", ROOT)
  f.state.messages.push({ type: "user", text })
  await f.idle()
  await f.idle()
  expect(f.state.admitted).toEqual([])
  expect(f.state.changed).toEqual(["ses"])
  expect(await f.continuation.status("ses")).toEqual({ state: "paused", reason: "the last message asked to pause" })
  f.state.messages.push({ type: "user", text: "go on" })
  await f.idle()
  expect(f.state.admitted).toHaveLength(1)
  expect(await f.continuation.status("ses")).toEqual({ state: "on", reason: "" })
})

test("a plan quoted by /omca-start-work is not the user asking to pause, and a typed request still is", async () => {
  const f = fake()
  await f.continuation.touch("ses", ROOT)
  f.state.messages = [{ type: "user", text: "Run the plan.\nIf tests fail, stop here.", metadata: { source: COMMAND_SOURCE } }]
  await f.idle()
  expect(f.state.admitted).toHaveLength(1)
  f.state.messages.push({ type: "user", text: "If tests fail, stop here." })
  await f.idle()
  expect(f.state.admitted).toHaveLength(1)
  expect((await f.continuation.status("ses")).state).toBe("paused")
})

test("a pause request compaction folded out of view still holds the run, and a reply after it resumes", async () => {
  const f = fake()
  await f.continuation.touch("ses", ROOT)
  await f.say("ok, stop here")
  expect(f.state.changed).toEqual(["ses"])
  f.state.messages = [{ type: "compaction" }, { type: "assistant", content: [{ type: "text" }] }]
  await f.idle()
  expect(f.state.admitted).toEqual([])
  expect((await f.continuation.status("ses")).state).toBe("paused")
  await f.say("go on")
  f.state.messages = [{ type: "compaction" }]
  await f.idle()
  expect(f.state.admitted).toHaveLength(1)
  expect(await f.continuation.status("ses")).toEqual({ state: "on", reason: "" })
})

test("a plan quoted by a command prompt does not pause the run", async () => {
  const f = fake()
  await f.continuation.touch("ses", ROOT)
  await f.say("Run the plan.\nIf tests fail, stop here.", { source: COMMAND_SOURCE })
  f.state.messages = [{ type: "compaction" }]
  await f.idle()
  expect(f.state.admitted).toHaveLength(1)
  expect(f.state.changed).toEqual(["ses"])
})

test("a message that only mentions stopping is not a pause request", async () => {
  const f = fake()
  await f.continuation.touch("ses", ROOT)
  f.state.messages.push({ type: "user", text: "do the stop button later in task 3" })
  await f.idle()
  expect(f.state.admitted).toHaveLength(1)
})

test(`${MAX_STALLS} continuations answered without a tool call stop the nudging until a task is touched again`, async () => {
  const f = fake()
  await f.continuation.touch("ses", ROOT)
  for (let i = 0; i < MAX_STALLS; i++) {
    await f.idle()
    f.reply(false)
  }
  expect(f.state.admitted).toHaveLength(MAX_STALLS)
  await f.idle()
  expect(f.state.admitted).toHaveLength(MAX_STALLS)
  expect(await f.continuation.status("ses")).toEqual({ state: "stopped", reason: `${MAX_STALLS} continuations in a row got no tool call` })
  await f.idle()
  expect(f.state.admitted).toHaveLength(MAX_STALLS)
  await f.continuation.touch("ses", ROOT)
  await f.idle()
  expect(f.state.admitted).toHaveLength(MAX_STALLS + 1)
})

test("a user message after a stop resumes the continuation with a fresh budget", async () => {
  const f = fake()
  await f.continuation.touch("ses", ROOT)
  for (let i = 0; i < MAX_STALLS; i++) {
    await f.idle()
    f.reply(false)
  }
  await f.idle()
  expect((await f.continuation.status("ses")).state).toBe("stopped")
  f.state.messages.push({ type: "user", text: "keep going" })
  f.reply(true)
  await f.idle()
  expect(f.state.admitted).toHaveLength(MAX_STALLS + 1)
  expect(await f.continuation.status("ses")).toEqual({ state: "on", reason: "" })
})

test("a user reply compaction folded out of view still resumes a stopped continuation with a fresh budget", async () => {
  const f = fake()
  await f.continuation.touch("ses", ROOT)
  for (let i = 0; i < MAX_STALLS; i++) {
    await f.idle()
    f.reply(false)
  }
  await f.idle()
  expect((await f.continuation.status("ses")).state).toBe("stopped")
  f.state.messages = [{ type: "compaction" }, { type: "assistant", content: [{ type: "text" }] }]
  await f.idle()
  expect(f.state.admitted).toHaveLength(MAX_STALLS)
  await f.say("keep going")
  await f.idle()
  f.reply(false)
  await f.idle()
  expect(f.state.admitted).toHaveLength(MAX_STALLS + 2)
  expect(await f.continuation.status("ses")).toEqual({ state: "on", reason: "" })
})

test("a tool call after a continuation clears the stall count", async () => {
  const f = fake()
  await f.continuation.touch("ses", ROOT)
  for (let i = 0; i < MAX_STALLS * 2; i++) {
    await f.idle()
    f.reply(i % MAX_STALLS === MAX_STALLS - 1)
  }
  await f.idle()
  expect(f.state.admitted).toHaveLength(MAX_STALLS * 2 + 1)
})

test(`${MAX_ROUNDS} continuations with no task changing stop the nudging, and a task change resets the count`, async () => {
  const f = fake()
  await f.continuation.touch("ses", ROOT)
  for (let i = 0; i < MAX_ROUNDS - 1; i++) {
    await f.idle()
    f.reply(true)
  }
  f.state.tasks = [...f.state.tasks.slice(0, 2), task("3", "in_progress", { isFinal: true })]
  for (let i = 0; i < MAX_ROUNDS; i++) {
    await f.idle()
    f.reply(true)
  }
  expect(f.state.admitted).toHaveLength(MAX_ROUNDS * 2 - 1)
  await f.idle()
  expect(f.state.admitted).toHaveLength(MAX_ROUNDS * 2 - 1)
  expect(await f.continuation.status("ses")).toEqual({ state: "stopped", reason: `${MAX_ROUNDS} continuations passed with no task changing` })
})

test("a user message after the last continuation starts a fresh budget", async () => {
  const f = fake()
  await f.continuation.touch("ses", ROOT)
  for (let i = 0; i < MAX_STALLS - 1; i++) {
    await f.idle()
    f.reply(false)
  }
  f.state.messages.push({ type: "user", text: "why did you stop?" })
  f.reply(false)
  for (let i = 0; i < MAX_STALLS; i++) {
    await f.idle()
    f.reply(false)
  }
  expect(f.state.admitted).toHaveLength(MAX_STALLS * 2 - 1)
  expect(await f.continuation.status("ses")).toEqual({ state: "on", reason: "" })
})

test.each(["task-continuation", "stop-gates", "all"])("OMCA_DISABLED_HOOKS=%s turns continuation off and reports it off", async (name) => {
  const f = fake()
  await f.continuation.touch("ses", ROOT)
  process.env.OMCA_DISABLED_HOOKS = `drift-guard, ${name}`
  await f.idle()
  expect(f.state.admitted).toEqual([])
  expect(await f.continuation.status("ses")).toEqual({ state: "off", reason: "OMCA_DISABLED_HOOKS turns continuation off" })
})

test("a reloaded plugin picks up the stored session and keeps its budget, pause and stop", async () => {
  const f = fake()
  await f.continuation.touch("ses", ROOT)
  for (let i = 0; i < MAX_STALLS - 1; i++) {
    await f.idle()
    f.reply(false)
  }
  const reloaded = createContinuation(f.host)
  await reloaded.idle({ sessionID: "ses", background: [] })
  expect(f.state.admitted).toHaveLength(MAX_STALLS)
  f.reply(false)
  await reloaded.idle({ sessionID: "ses", background: [] })
  expect(await createContinuation(f.host).status("ses")).toEqual({ state: "stopped", reason: `${MAX_STALLS} continuations in a row got no tool call` })
  await createContinuation(f.host).prompt({ sessionID: "ses", prompt: { text: "keep going" } })
  f.state.messages = [{ type: "compaction" }]
  await createContinuation(f.host).idle({ sessionID: "ses", background: [] })
  expect(f.state.admitted).toHaveLength(MAX_STALLS + 1)
  await createContinuation(f.host).prompt({ sessionID: "ses", prompt: { text: "ok, stop here" } })
  expect(await createContinuation(f.host).status("ses")).toEqual({ state: "paused", reason: "the last message asked to pause" })
})

test("a session that leaves the run loses its stored record, and a malformed record arms nothing", async () => {
  const f = fake()
  await f.continuation.touch("ses", ROOT)
  expect(f.stored.has("ses")).toBe(true)
  f.state.tasks = [task("1", "completed")]
  await f.idle()
  expect(f.stored.has("ses")).toBe(false)
  f.stored.set("other", { root: ROOT, rounds: "1" })
  expect(await createContinuation(f.host).status("other")).toEqual({ state: "off", reason: "" })
})

test("a storage failure is logged and never fails the task write that armed the session", async () => {
  const f = fake()
  f.state.fail = true
  await f.continuation.touch("ses", ROOT)
  await f.say("ok, stop here")
  expect(await f.continuation.status("ses")).toEqual({ state: "off", reason: "" })
  expect(errorSpy).toHaveBeenCalledTimes(3)
})

test("a host failure is logged and lets the session go idle instead of failing it", async () => {
  const f = fake()
  await f.continuation.touch("ses", ROOT)
  f.state.fail = true
  await f.idle()
  expect(f.state.admitted).toEqual([])
  expect(errorSpy).toHaveBeenCalledTimes(1)
})
