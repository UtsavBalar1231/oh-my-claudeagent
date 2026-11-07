import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { provesTask, readLedger } from "../src/core/evidence.ts";
import { isHookDisabled } from "../src/core/kill-switch.ts";
import { isOpen, type NativeTask } from "../src/core/native-tasks.ts";
import { LEDGER } from "../src/core/omca-paths.ts";
import { isRecord } from "../src/core/tool-input.ts";
import { INVALID_LEDGER_REASON } from "../src/core/verification.ts";
import { withLock, writeFileAtomic } from "../servers/io.ts";
import { contained, readLocal, readTaskFiles, TASK_FILE_BYTE_LIMIT, TASK_LIMIT, TASKS_DIR } from "./state.ts";

export const TASK_STATUSES = ["pending", "in_progress", "completed", "deleted"] as const;
export type TaskStatusChange = typeof TASK_STATUSES[number];

export type NewTask = { subject: string; description: string; activeForm: string; metadata: Record<string, unknown> };
export type TaskChange = {
  taskId: string;
  status?: TaskStatusChange;
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  addBlocks?: readonly string[];
  addBlockedBy?: readonly string[];
  metadata?: Record<string, unknown>;
};

const HIGH_WATER = ".highwatermark";

export const tasksLock = (root: string): string => join(root, ".omca", "state", "tasks.lock");
const taskFile = (root: string, id: string): string => join(root, TASKS_DIR, `${id}.json`);

function writeTask(root: string, task: Record<string, unknown> & { id: string }): void {
  const text = `${JSON.stringify(task, null, 2)}\n`;
  if (Buffer.byteLength(text) > TASK_FILE_BYTE_LIMIT) throw new Error(`Task #${task.id} exceeds the ${TASK_FILE_BYTE_LIMIT}-byte limit; put long detail in a plan document and name it`);
  writeFileAtomic(contained(taskFile(root, task.id), root), text);
}

function readStored(root: string, id: string): Record<string, unknown> & { id: string } {
  const bytes = readLocal(root, taskFile(root, id), TASK_FILE_BYTE_LIMIT);
  const parsed: unknown = bytes === null ? null : JSON.parse(bytes.toString("utf8"));
  if (!isRecord(parsed)) throw new Error(`Task #${id} cannot be read`);
  return { ...parsed, id };
}

const idList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
const withId = (value: unknown, id: string): string[] => [...new Set([...idList(value), id])];

function nextId(root: string, tasks: readonly NativeTask[]): number {
  const highWater = Number.parseInt(readLocal(root, join(root, TASKS_DIR, HIGH_WATER), 64)?.toString("utf8") ?? "0", 10);
  return Math.max(Number.isNaN(highWater) ? 0 : highWater, ...tasks.map((task) => Number(task.id))) + 1;
}

/** Creating the first task after a finished run clears that run's files; the id counter survives, so an id never names two tasks. */
export async function createTask(root: string, input: NewTask, beforeWrite: () => Promise<void>): Promise<NativeTask> {
  contained(tasksLock(root), root);
  return withLock(tasksLock(root), async () => {
    await beforeWrite();
    mkdirSync(join(root, TASKS_DIR), { recursive: true });
    const { tasks } = readTaskFiles(root);
    const id = String(nextId(root, tasks));
    const finished = tasks.length > 0 && !tasks.some(isOpen);
    if (!finished && tasks.length >= TASK_LIMIT) throw new Error(`The task list is at its ${TASK_LIMIT}-task limit`);
    writeFileAtomic(contained(join(root, TASKS_DIR, HIGH_WATER), root), id);
    if (finished) for (const task of tasks) rmSync(contained(taskFile(root, task.id), root), { force: true });
    writeTask(root, { id, subject: input.subject, description: input.description, activeForm: input.activeForm, status: "pending", owner: "", blocks: [], blockedBy: [], metadata: input.metadata });
    return readTaskFiles(root).tasks.find((task) => task.id === id) ?? refuseUnreadable(id);
  });
}

function refuseUnreadable(id: string): never {
  throw new Error(`Task #${id} was written but cannot be read back`);
}

function verdictRefusal(root: string, task: NativeTask, change: TaskChange): string | undefined {
  if (!task.isFinal || isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "final-verification")) return undefined;
  const metadata = change.metadata ?? {};
  if (Object.hasOwn(metadata, "final") && metadata.final !== true) return `Task #${task.id} is the final task of run '${task.run}', and it stays final.`;
  const blocked = metadata.blocked;
  const givesUp = change.status === "deleted" || (typeof blocked === "string" && blocked !== "");
  if (!givesUp && change.status !== "completed") return undefined;
  const ledger = readLedger(readLocal(root, join(root, LEDGER))?.toString("utf8") ?? "{}");
  if (ledger.kind === "refused") return INVALID_LEDGER_REASON;
  const log = `omca_evidence_log(evidence_type="final_verification", command="<what the review covered>", output_snippet="<the verdict>", task_id="${task.id}"`;
  if (givesUp) {
    if (ledger.entries.some((entry) => entry.type === "final_verification" && entry.taskId === task.id)) return undefined;
    return `Task #${task.id} is the final task of run '${task.run}', and no final verification names it. Record the verdict first: ${log}, exit_code=<0 for COMPLETE, 1 for INCOMPLETE>).`;
  }
  if (ledger.entries.some((entry) => provesTask(entry, task.id))) return undefined;
  return `Task #${task.id} '${task.subject}' is the final task of run '${task.run}', and no passing final verification names it. Review the run, then record the verdict: ${log}, exit_code=0). If the review finds a gap, fix it and review again.`;
}

export async function updateTask(root: string, change: TaskChange, beforeWrite: () => Promise<void>): Promise<NativeTask | null> {
  contained(tasksLock(root), root);
  return withLock(tasksLock(root), async () => {
    await beforeWrite();
    const { tasks } = readTaskFiles(root);
    const task = tasks.find(({ id }) => id === change.taskId);
    if (task === undefined) throw new Error(`Task #${change.taskId} is not on the list`);
    const refusal = verdictRefusal(root, task, change);
    if (refusal !== undefined) throw new Error(refusal);
    const links = [...(change.addBlocks ?? []), ...(change.addBlockedBy ?? [])];
    for (const id of links) {
      if (id === task.id) throw new Error(`Task #${id} cannot block itself`);
      if (!tasks.some((other) => other.id === id)) throw new Error(`Task #${id} is not on the list`);
    }
    if (change.status === "deleted") {
      for (const other of tasks) {
        if (other.id === task.id || (!other.blocks.includes(task.id) && !other.blockedBy.includes(task.id))) continue;
        const stored = readStored(root, other.id);
        writeTask(root, { ...stored, blocks: idList(stored.blocks).filter((id) => id !== task.id), blockedBy: idList(stored.blockedBy).filter((id) => id !== task.id) });
      }
      rmSync(contained(taskFile(root, task.id), root), { force: true });
      return null;
    }
    const stored = readStored(root, task.id);
    const metadata: Record<string, unknown> = { ...(isRecord(stored.metadata) ? stored.metadata : {}) };
    for (const [key, value] of Object.entries(change.metadata ?? {})) {
      if (value === null) delete metadata[key];
      else metadata[key] = value;
    }
    const { taskId: _taskId, addBlocks = [], addBlockedBy = [], metadata: _metadata, ...fields } = change;
    writeTask(root, {
      ...stored,
      ...fields,
      blocks: [...new Set([...idList(stored.blocks), ...addBlocks])],
      blockedBy: [...new Set([...idList(stored.blockedBy), ...addBlockedBy])],
      metadata,
    });
    for (const id of addBlocks) {
      const other = readStored(root, id);
      writeTask(root, { ...other, blockedBy: withId(other.blockedBy, task.id) });
    }
    for (const id of addBlockedBy) {
      const other = readStored(root, id);
      writeTask(root, { ...other, blocks: withId(other.blocks, task.id) });
    }
    return readTaskFiles(root).tasks.find(({ id }) => id === task.id) ?? refuseUnreadable(task.id);
  });
}
