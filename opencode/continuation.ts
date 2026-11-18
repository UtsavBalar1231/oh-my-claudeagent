import { isHookDisabled } from "../src/core/kill-switch.ts"
import { type NativeTask, runState } from "../src/core/native-tasks.ts"
import { isPauseRequest } from "../src/core/stop-ledger.ts"
import { isRecord } from "../src/core/tool-input.ts"
import { isVerificationCommand } from "../src/core/verification.ts"

export const CONTINUATION_SOURCE = "omca.continuation"
// Marks the prompts OMCA's commands send, which quote the user's plan and so are not the user speaking.
export const COMMAND_SOURCE = "omca.command"
// Continuations in a row the model answered without calling a tool, after which OMCA stops nudging.
export const MAX_STALLS = 3
// Continuations while no task of the run changed, which bounds a model that works without finishing anything.
export const MAX_ROUNDS = 10

type Message = {
  readonly type: string
  readonly text?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly content?: ReadonlyArray<{ readonly type: string }>
}

export interface ContinuationHost {
  session(sessionID: string): Promise<{ readonly parentID?: string | undefined; readonly agent?: string | undefined; readonly location: { readonly directory: string } }>
  messages(sessionID: string): Promise<readonly Message[]>
  tasks(root: string): readonly NativeTask[]
  rootOf(directory: string): string
  admit(input: { sessionID: string; text: string; description: string; metadata: Record<string, string> }): Promise<unknown>
  changed(sessionID: string): Promise<void>
  load(sessionID: string): Promise<unknown>
  save(sessionID: string, record: Armed | undefined): Promise<void>
}

export type ContinuationStatus = { state: "off" | "on" | "paused" | "stopped"; reason: string }

type Armed = { root: string; rounds: number; stalls: number; signature: string; paused: boolean; heard: boolean; stopped: string | null }
type Job = { readonly kind: string; readonly sessionID: string; readonly command?: string }

const switchedOff = () => {
  const disabled = process.env.OMCA_DISABLED_HOOKS
  return isHookDisabled(disabled, "task-continuation") || isHookDisabled(disabled, "stop-gates")
}
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 200)
const usedTool = (message: Message) => message.type === "assistant" && (message.content ?? []).some((part) => part.type === "tool")
const holds = (job: Job) => job.kind !== "shell" || isVerificationCommand(job.command ?? "")
const isArmed = (value: unknown): value is Armed =>
  isRecord(value) && typeof value.root === "string" && typeof value.rounds === "number" && typeof value.stalls === "number" &&
  typeof value.signature === "string" && typeof value.paused === "boolean" && typeof value.heard === "boolean" &&
  (value.stopped === null || typeof value.stopped === "string")

export function nudge(run: string, open: number, next: NativeTask): string {
  return `[OMCA CONTINUATION] Run "${oneLine(run)}" was approved with /omca-start-work and still has ${open} open ${open === 1 ? "task" : "tasks"}; the next is #${next.id} ${oneLine(next.subject)}. Keep working through the open tasks without waiting for a go-ahead. Complete a task with omca_task_update once its work is checked. If a decision only the user can make blocks the next task, ask it with the question tool; if the task cannot proceed, close it with omca_task_update metadata {"blocked": "<why>"}.`
}

/**
 * Keeps the coordinator working while its run has open tasks. A session takes the run on by
 * creating a task or starting or completing one; only that top-level omca session is continued.
 * Each record is kept in plugin storage as well, so a plugin reload or restart picks it up.
 */
export function createContinuation(host: ContinuationHost) {
  const sessions = new Map<string, Armed | null>()

  async function armedFor(sessionID: string): Promise<Armed | undefined> {
    const held = sessions.get(sessionID)
    if (held !== undefined) return held ?? undefined
    const stored = await host.load(sessionID)
    const armed = isArmed(stored) ? stored : undefined
    sessions.set(sessionID, armed ?? null)
    return armed
  }

  async function disarm(sessionID: string) {
    sessions.set(sessionID, null)
    await host.save(sessionID, undefined)
  }

  async function decide(sessionID: string, armed: Armed): Promise<void> {
    const session = await host.session(sessionID)
    if (session.parentID !== undefined || session.agent !== "omca" || host.rootOf(session.location.directory) !== armed.root) return await disarm(sessionID)
    const tasks = host.tasks(armed.root)
    const run = runState(tasks)
    const next = run?.next ?? run?.open[0]
    if (run === undefined || next === undefined) {
      await disarm(sessionID)
      return await host.changed(sessionID)
    }
    const messages = await host.messages(sessionID)
    const lastUser = messages.findLastIndex((message) => message.type === "user")
    const said = messages[lastUser]
    // Compaction can fold the user's last message out of view; the prompt hook kept what it asked.
    if (said === undefined ? armed.paused : said.metadata?.source !== COMMAND_SOURCE && isPauseRequest(said.text ?? "")) {
      if (armed.paused) return
      armed.paused = true
      return await host.changed(sessionID)
    }
    armed.paused = false
    const lastNudge = messages.findLastIndex((message) => message.type === "synthetic" && message.metadata?.source === CONTINUATION_SOURCE)
    const spoke = armed.heard || lastUser > lastNudge
    armed.heard = false
    if (armed.stopped !== null && !spoke) return
    armed.stopped = null
    if (spoke) {
      armed.rounds = 0
      armed.stalls = 0
    } else if (lastNudge !== -1) {
      armed.stalls = messages.slice(lastNudge + 1).some(usedTool) ? 0 : armed.stalls + 1
    }
    const signature = JSON.stringify(tasks.filter((task) => task.run === run.name).map((task) => [task.id, task.status, task.blockedReason]))
    if (signature !== armed.signature) {
      armed.signature = signature
      armed.rounds = 0
    }
    const stop = armed.stalls >= MAX_STALLS ? `${MAX_STALLS} continuations in a row got no tool call`
      : armed.rounds >= MAX_ROUNDS ? `${MAX_ROUNDS} continuations passed with no task changing`
      : undefined
    if (stop !== undefined) {
      armed.stopped = stop
      return await host.changed(sessionID)
    }
    armed.rounds += 1
    const open = run.open.length
    await host.admit({
      sessionID,
      text: nudge(run.name, open, next),
      description: `OMCA continues ${oneLine(run.name)}: ${open} open, next #${next.id}`,
      metadata: { source: CONTINUATION_SOURCE, run: run.name },
    })
    await host.changed(sessionID)
  }

  return {
    async touch(sessionID: string, root: string): Promise<void> {
      try {
        const armed = await armedFor(sessionID)
        if (armed?.root === root && armed.stopped === null) return
        const fresh: Armed = { root, rounds: 0, stalls: 0, signature: "", paused: false, heard: false, stopped: null }
        sessions.set(sessionID, fresh)
        await host.save(sessionID, fresh)
      } catch (error) {
        console.error("omca: could not store that this session took the run on", error)
      }
    },

    async status(sessionID: string): Promise<ContinuationStatus> {
      if (switchedOff()) return { state: "off", reason: "OMCA_DISABLED_HOOKS turns continuation off" }
      let armed: Armed | undefined
      try {
        armed = await armedFor(sessionID)
      } catch (error) {
        console.error("omca: could not read this session's continuation", error)
      }
      if (armed === undefined) return { state: "off", reason: "" }
      if (armed.stopped !== null) return { state: "stopped", reason: armed.stopped }
      return armed.paused ? { state: "paused", reason: "the last message asked to pause" } : { state: "on", reason: "" }
    },

    async prompt(event: { readonly sessionID: string; readonly prompt: { readonly text: string }; readonly metadata?: Readonly<Record<string, unknown>> | undefined }): Promise<void> {
      try {
        const armed = await armedFor(event.sessionID)
        if (armed === undefined) return
        armed.heard = true
        const paused = event.metadata?.source !== COMMAND_SOURCE && isPauseRequest(event.prompt.text)
        const flipped = paused !== armed.paused
        armed.paused = paused
        await host.save(event.sessionID, armed)
        if (flipped) await host.changed(event.sessionID)
      } catch (error) {
        console.error("omca: could not record the prompt for the continuation", error)
      }
    },

    async idle(event: { readonly sessionID: string; readonly background: ReadonlyArray<Job> }): Promise<void> {
      const { sessionID } = event
      if (switchedOff()) return
      try {
        const armed = await armedFor(sessionID)
        if (armed === undefined) return
        // The session's own work wakes it when it finishes, and this hook runs again then. A shell is
        // waited on only for a check: a dev server left running would hold the run forever.
        if (event.background.some((job) => job.sessionID === sessionID && holds(job))) return
        await decide(sessionID, armed)
        if (sessions.get(sessionID) === armed) await host.save(sessionID, armed)
      } catch (error) {
        console.error("omca: task continuation failed, so the session goes idle", error)
      }
    },
  }
}

export type Continuation = ReturnType<typeof createContinuation>
