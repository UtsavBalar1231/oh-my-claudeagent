import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { entriesOf, readLedger, treeMovedSince, type Evidence } from "../src/core/evidence.ts";
import { type NativeTask, parseTask, runState } from "../src/core/native-tasks.ts";
import { NOTEPAD_SECTIONS, parseEntries, toPlanName } from "../src/core/notepad.ts";
import { LEDGER } from "../src/core/omca-paths.ts";
import { redact } from "../src/core/visual.ts";
import { hasCode, projectRoot } from "../servers/io.ts";

export type Run = { name: string; tasks: NativeTask[] };

export interface Snapshot {
  sessionID: string;
  directory: string;
  run: Run | null;
  evidence: {
    entries: Array<{ type: string; command: string; exitCode: number; at: number; snippet: string; verifiedBy: string | null; taskId: string; tree: string }>;
    verdict: "missing" | "historical" | "stale" | "verified";
  };
  notepads: Array<{ section: string; content: string }>;
  health: Array<{ name: string; state: "ok" | "warning" | "error"; detail: string }>;
}

export const TASKS_DIR = ".omca/state/tasks";
/** Registry-free state ceiling for the ledger and each notepad section; oversized files are refused. */
export const STATE_FILE_BYTE_LIMIT = 4 * 1024 * 1024;
/** Checked before allocating a task file's read buffer or parsing it. */
export const TASK_FILE_BYTE_LIMIT = 256 * 1024;
/** Bounds how many files one read of the list opens. */
export const TASK_LIMIT = 1_000;
const NOTE_LIMIT = 8_000;
const EVIDENCE_LIMIT = 50;
const TASK_FILE = /^\d+\.json$/;

function requireSession(sessionID: string): void {
  if (sessionID.trim() === "" || /[\r\n\0]/.test(sessionID)) throw new Error("A native session ID is required");
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Dangling symlinks are not allowed");
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonical(parent), basename(path));
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

export const rootOf = (directory: string): string => realpathSync.native(projectRoot(resolve(directory)));

/** The path with its symlinks resolved, refused when it would land outside the checkout. */
export function contained(path: string, root: string): string {
  if (!inside(root, path)) throw new Error("Path is outside the allowed checkout");
  const actual = canonical(path);
  if (!inside(root, actual)) throw new Error("Path escapes its allowed directory through a symlink");
  return actual;
}

function readBoundedFile(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Expected a regular file");
    if (stat.size > limit) throw new Error(`File exceeds the ${limit}-byte native read limit`);
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > stat.size) throw new Error("File grew during inspection; refresh before reading it");
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

export function readLocal(root: string, path: string, limit = STATE_FILE_BYTE_LIMIT): Buffer | null {
  const actual = contained(path, root);
  if (actual !== resolve(path)) throw new Error("OMCA state paths must not contain symlinks");
  try {
    return readBoundedFile(actual, limit);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

/** Every task on this checkout's list in id order, counting the files that do not hold the task they name. */
export function readTaskFiles(root: string): { tasks: NativeTask[]; unreadable: number } {
  const directory = join(root, TASKS_DIR);
  const actual = contained(directory, root);
  if (actual !== resolve(directory)) throw new Error("OMCA state paths must not contain symlinks");
  let names: string[];
  try {
    names = readdirSync(actual).filter((name) => TASK_FILE.test(name));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { tasks: [], unreadable: 0 };
    throw error;
  }
  if (names.length > TASK_LIMIT) throw new Error(`The task list exceeds the ${TASK_LIMIT}-task native read limit`);
  const tasks: NativeTask[] = [];
  let unreadable = 0;
  for (const name of names) {
    const bytes = readLocal(root, join(directory, name), TASK_FILE_BYTE_LIMIT);
    if (bytes === null) continue;
    const task = parseTask(bytes.toString("utf8"));
    if (task === undefined || `${task.id}.json` !== name) unreadable += 1;
    else tasks.push(task);
  }
  return { tasks: tasks.sort((a, b) => Number(a.id) - Number(b.id)), unreadable };
}

export function currentRun(tasks: readonly NativeTask[]): Run | null {
  const name = runState(tasks)?.name;
  return name === undefined ? null : { name, tasks: tasks.filter((task) => task.run === name) };
}

function evidenceVerdict(entries: Evidence[], run: Run | null): Snapshot["evidence"]["verdict"] {
  const final = run?.tasks.find((task) => task.isFinal);
  if (final === undefined) return "missing";
  const finals = entries.filter((entry) => entry.type === "final_verification" && entry.taskId !== "");
  const latest = finals.findLast((entry) => entry.taskId === final.id);
  if (latest === undefined) return finals.length === 0 ? "missing" : "stale";
  if (latest.exitCode !== 0 || treeMovedSince(entries, latest)) return "stale";
  const lastFinal = entries.lastIndexOf(latest);
  if (entries.slice(lastFinal + 1).some((entry) => entry.exitCode !== 0 && (entry.taskId === "" || entry.taskId === final.id))) return "stale";
  return "historical";
}

/** `expectedRun` is the run whose notepads were approved; a list that moved to another run since is refused. */
export function readSnapshot(directory: string, sessionID: string, expectedRun?: string | null): Snapshot {
  const snapshot: Snapshot = {
    directory, sessionID, run: null, evidence: { entries: [], verdict: "missing" }, notepads: [],
    health: [{ name: "verification", state: "warning", detail: "Native server-authored verification provenance is not supported yet; ledger successes are historical, not verified." }],
  };
  const report = (name: string, state: Snapshot["health"][number]["state"], detail: string): void => { snapshot.health.push({ name, state, detail: redact(detail, homedir(), "<masked>").text }); };
  let root: string;
  try {
    requireSession(sessionID);
    root = rootOf(directory);
  } catch (error) {
    report("context", "error", String(error));
    return snapshot;
  }
  try {
    const { tasks, unreadable } = readTaskFiles(root);
    const run = currentRun(tasks);
    if (expectedRun !== undefined && (run?.name ?? null) !== expectedRun) throw new Error("The task list changed during inspection; refresh before reading it");
    snapshot.run = run;
    if (unreadable > 0) report("tasks", "warning", `${unreadable} task files could not be read`);
    else report("tasks", run === null ? "warning" : "ok", run === null ? "This checkout has no run on its task list" : `${run.tasks.length} tasks in run ${run.name}`);
  } catch (error) {
    report("tasks", "error", String(error));
  }
  if (snapshot.run !== null) {
    for (const section of NOTEPAD_SECTIONS) {
      try {
        const bytes = readLocal(root, join(root, ".omca", "notepads", toPlanName(snapshot.run.name), `${section}.md`));
        if (bytes === null) continue;
        const entries = parseEntries(bytes.toString("utf8"));
        const text = entries.map((entry) => `${entry.at === null ? "" : `## ${new Date(entry.at).toISOString()}\n\n`}${entry.text}`).join("\n\n");
        const content = redact(text, homedir(), "<masked>").text;
        snapshot.notepads.push({ section, content: content.slice(-NOTE_LIMIT) });
        if (content.length > NOTE_LIMIT) report(`notepad:${section}`, "warning", "Older notepad content was omitted from this snapshot");
      } catch (error) {
        report(`notepad:${section}`, "error", String(error));
      }
    }
  }
  try {
    const bytes = readLocal(root, join(root, LEDGER));
    if (bytes === null) report("ledger", "warning", "Evidence ledger is missing");
    else {
      const ledger = readLedger(bytes.toString("utf8"));
      if (ledger.kind === "refused") throw new Error(`Evidence ledger cannot be read: ${ledger.reason}`);
      const raw = entriesOf(ledger.document);
      const malformed = raw === undefined || raw.length !== ledger.entries.length;
      report("ledger", malformed ? "warning" : "ok", malformed ? "Evidence entries are missing or malformed; unreadable entries were omitted" : "Evidence ledger is readable");
      snapshot.evidence.verdict = evidenceVerdict(ledger.entries, snapshot.run);
      snapshot.evidence.entries = ledger.entries.slice(-EVIDENCE_LIMIT).map((entry) => ({
        ...entry,
        command: redact(entry.command, homedir(), "<masked>").text.slice(0, 2_000),
        snippet: redact(entry.snippet, homedir(), "<masked>").text.slice(0, 2_000),
        verifiedBy: entry.verifiedBy === null ? null : redact(entry.verifiedBy, homedir(), "<masked>").text.slice(0, 200),
      }));
    }
  } catch (error) {
    report("ledger", "error", String(error));
  }
  return snapshot;
}
