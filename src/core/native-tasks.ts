import { sha256Hex } from "./sha256.ts";
import { clean } from "./text.ts";
import { joinPath, type Platform } from "./path.ts";
import { isRecord } from "./tool-input.ts";

export type TaskStatus = "pending" | "in_progress" | "completed";

/** One task, as Claude Code stores it under `<config dir>/tasks/<list id>/<id>.json` and the OpenCode adapter under `.omca/state/tasks/<id>.json`. */
export type NativeTask = {
  id: string;
  subject: string;
  description: string;
  activeForm: string;
  status: TaskStatus;
  owner: string;
  blocks: readonly string[];
  blockedBy: readonly string[];
  /** The run a planned task belongs to, from `metadata.run`; empty for a task Claude made on its own. */
  run: string;
  /** From `metadata.final`: closing this task needs a passing final verification logged for its id. */
  isFinal: boolean;
  /** From `metadata.blocked`: why the task was given up on, which closes it without completing it. */
  blockedReason: string;
  details: readonly { name: string; text: string }[];
};

export type TaskGroup = { name: "Now" | "Next" | "Waiting" | "Done"; tasks: readonly NativeTask[] };

/** OMCA requires the task tools and turns them on itself, so a session without them has something set against them. */
export const TASK_TOOLS_OFF =
  "Claude Code's task tools are off in this session, and OMCA requires them. OMCA turns them on at session start unless something keeps them off: CLAUDE_CODE_ENABLE_TODO_TOOLS set to a value other than 1, CLAUDE_CODE_ENABLE_TASKS=0, a deny rule on TaskCreate or TaskUpdate, or a --tools list without them.";

const INTERNAL = "_internal";
const RUN = "run";
const FINAL = "final";
const BLOCKED = "blocked";
const OWN_KEYS: ReadonlySet<string> = new Set([RUN, FINAL, BLOCKED]);

const isStatus = (value: unknown): value is TaskStatus => value === "pending" || value === "in_progress" || value === "completed";
const textOf = (value: unknown): string => (typeof value === "string" ? clean(value) : "");
const idsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);

const detailsOf = (metadata: Record<string, unknown>) =>
  Object.entries(metadata).flatMap(([name, value]) => {
    if (value === null || value === undefined || OWN_KEYS.has(name)) return [];
    return [{ name: clean(name), text: clean(typeof value === "string" ? value : JSON.stringify(value)) }];
  });

/** A stored task, or undefined for a file that is not one and for a task Claude Code keeps out of its own list. */
export function parseTask(text: string): NativeTask | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(data) || typeof data.id !== "string" || typeof data.subject !== "string" || !isStatus(data.status)) return undefined;
  const metadata = isRecord(data.metadata) ? data.metadata : {};
  if (metadata[INTERNAL]) return undefined;
  return {
    id: data.id,
    subject: clean(data.subject),
    description: textOf(data.description),
    activeForm: textOf(data.activeForm),
    status: data.status,
    owner: textOf(data.owner),
    blocks: idsOf(data.blocks),
    blockedBy: idsOf(data.blockedBy),
    run: textOf(metadata[RUN]),
    isFinal: metadata[FINAL] === true,
    blockedReason: textOf(metadata[BLOCKED]),
    details: detailsOf(metadata),
  };
}

/** The directory Claude Code keeps a list in; an id is cut to the characters it allows in a directory name. */
export const taskListDir = (platform: Platform, config: string, listId: string): string =>
  joinPath(platform, config, "tasks", listId.replace(/[^a-zA-Z0-9_-]/g, "-"));

const byId = (a: NativeTask, b: NativeTask): number => {
  const [left, right] = [Number(a.id), Number(b.id)];
  return Number.isNaN(left) || Number.isNaN(right) ? a.id.localeCompare(b.id) : left - right;
};

/**
 * The list as read, with the finished tasks an earlier read saw and this one did not. Claude Code
 * deletes every file of a list about 5 s after its last task completes and never reuses an id, so
 * those tasks stay in the session's record; `forgotten` is the id of a task deleted on purpose.
 */
export function withHistory(previous: readonly NativeTask[], read: readonly NativeTask[], forgotten?: string): NativeTask[] {
  const current = new Set(read.map((task) => task.id));
  const finished = previous.filter((task) => task.status === "completed" && !current.has(task.id) && task.id !== forgotten);
  return [...read, ...finished].sort(byId);
}

/** Still to do: not completed and not given up on. */
export const isOpen = (task: NativeTask): boolean => task.status !== "completed" && task.blockedReason === "";

/** The tasks that hold this one back: named in `blockedBy`, on the list and still open. */
export const openBlockers = (task: NativeTask, tasks: readonly NativeTask[]): string[] =>
  task.blockedBy.filter((id) => tasks.some((other) => other.id === id && isOpen(other)));

const rootSpelling = (root: string): string => {
  const slashed = root.replaceAll("\\", "/").replace(/^[a-z]:/, (drive) => drive.toUpperCase());
  const trimmed = slashed.replace(/\/+$/, "");
  return trimmed === "" ? "/" : /^[A-Z]:$/.test(trimmed) ? `${trimmed}/` : trimmed;
};

/** The list a checkout's sessions share, so tasks outlive `/clear` and a new session. Both spellings of a Windows root name one list. */
export function taskListIdFor(root: string): string {
  const name = root.split(/[\\/]/).filter((part) => part !== "").at(-1) ?? "project";
  return `omca-${name.replace(/[^a-zA-Z0-9_-]/g, "-")}-${sha256Hex(new TextEncoder().encode(rootSpelling(root))).slice(0, 8)}`;
}

/** A run's tasks still to do, and the first of them nothing holds back. */
export function runState(tasks: readonly NativeTask[]): { name: string; open: readonly NativeTask[]; next: NativeTask | undefined; blocked: readonly NativeTask[] } | undefined {
  const planned = tasks.filter((task) => task.run !== "");
  const name = planned.find(isOpen)?.run ?? planned.at(-1)?.run;
  if (name === undefined) return undefined;
  const open = planned.filter((task) => task.run === name && isOpen(task));
  return {
    name,
    open,
    next: open.find((task) => openBlockers(task, tasks).length === 0),
    blocked: planned.filter((task) => task.run === name && task.blockedReason !== ""),
  };
}

/** One line per task under its run's name, with what the client's own task tools leave out: which task is final and which were given up on. */
export function formatTasks(tasks: readonly NativeTask[]): string {
  if (tasks.length === 0) return "The task list is empty.";
  const lines: string[] = [];
  for (const run of new Set(tasks.map((task) => task.run))) {
    lines.push(run === "" ? "In no run:" : `Run ${run}:`);
    for (const task of tasks.filter((other) => other.run === run)) {
      const open = openBlockers(task, tasks);
      lines.push(`#${task.id} [${task.status}] ${task.subject}${task.isFinal ? " [final]" : ""}${open.length > 0 ? ` [waiting on ${open.map((id) => `#${id}`).join(", ")}]` : ""}${task.blockedReason === "" ? "" : ` [closed as blocked: ${task.blockedReason}]`}`);
    }
  }
  return lines.join("\n");
}

/** One task in full. `blockedBy` also names tasks completed or given up on, so `openBlockers` says which still hold it back. */
export const formatTask = (task: NativeTask, tasks: readonly NativeTask[]): string => JSON.stringify({ ...task, openBlockers: openBlockers(task, tasks) }, null, 2);

/** The list in the order the work will run: what runs now, what can start next, what waits on another task, what is done. */
export function groupTasks(tasks: readonly NativeTask[]): TaskGroup[] {
  const pending = tasks.filter((task) => task.status === "pending" && task.blockedReason === "");
  const groups: TaskGroup[] = [
    { name: "Now", tasks: tasks.filter((task) => task.status === "in_progress" && task.blockedReason === "") },
    { name: "Next", tasks: pending.filter((task) => openBlockers(task, tasks).length === 0) },
    { name: "Waiting", tasks: tasks.filter((task) => task.status !== "completed" && (task.blockedReason !== "" || (task.status === "pending" && openBlockers(task, tasks).length > 0))) },
    { name: "Done", tasks: tasks.filter((task) => task.status === "completed") },
  ];
  return groups.filter((group) => group.tasks.length > 0);
}
