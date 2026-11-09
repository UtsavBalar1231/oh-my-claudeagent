import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type NativeTask, parseTask, runState, taskListDir, taskListIdFor, withHistory } from "../../src/core/native-tasks.ts";
import { LEDGER, statusPath as sessionStatusPath } from "../../src/core/omca-paths.ts";
import { configDir, toPlatform } from "../../src/core/path.ts";
import { isSafeId } from "../../src/core/session-id.ts";
import { isRecord } from "../../src/core/tool-input.ts";
import { gitWorktreeRoots, isMissing, writeFileAtomic } from "../io.ts";
import { MAIN_THREAD, type Session } from "./session-state.ts";

export const STAMP_INTERVAL_MS = 5_000;

export function statusPath(root: string, sessionId: string): string {
  const path = sessionStatusPath(root, sessionId);
  if (path === undefined) throw new Error(`unsafe session id in a state path: ${JSON.stringify(sessionId)}`);
  return join(path);
}

export const ledgerPath = (root: string): string => join(root, LEDGER);

/** The mod's marker for the session, or undefined when the id cannot name a file or the mod never wrote one. */
export function readMarker(root: string, sessionId: string): Record<string, unknown> | undefined {
  if (!isSafeId(sessionId)) return undefined;
  let text: string;
  try {
    text = readFileSync(join(root, ".omca", "state", "mod", `${sessionId}.json`), "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const marker: unknown = JSON.parse(text);
  return isRecord(marker) ? marker : undefined;
}

const writtenAtOf = (marker: Record<string, unknown> | undefined): number | undefined =>
  typeof marker?.written_at === "number" ? marker.written_at : undefined;

/**
 * The mod's newest marker for the session, or undefined when it never wrote one. The mod writes the
 * marker under its session root, which a worktree move changes, so a root marker not newer than
 * `after` sends the search through every worktree of the repository.
 */
export function latestMarker(root: string, sessionId: string, after = -Infinity): Record<string, unknown> | undefined {
  const own = readMarker(root, sessionId);
  const ownAt = writtenAtOf(own);
  if (ownAt !== undefined && ownAt > after) return own;
  let latest = ownAt === undefined ? undefined : own;
  let latestAt = ownAt;
  for (const worktree of new Set(gitWorktreeRoots(root))) {
    let marker: Record<string, unknown> | undefined;
    try {
      marker = readMarker(worktree, sessionId);
    } catch {
      continue;
    }
    const at = writtenAtOf(marker);
    if (at !== undefined && (latestAt === undefined || at > latestAt)) {
      latest = marker;
      latestAt = at;
    }
  }
  return latest;
}

/** When the mod last marked the session, or undefined when it never has. */
export const markerWrittenAt = (root: string, sessionId: string, after = -Infinity): number | undefined => writtenAtOf(latestMarker(root, sessionId, after));

export type ReadOptions = { atPrompt?: boolean };

function taskListIdOf(root: string, sessionId: string, atPrompt: boolean): string {
  let marker: Record<string, unknown> | undefined;
  try {
    marker = latestMarker(root, sessionId);
  } catch (error) {
    console.error(`omca: could not read the mod marker of session ${sessionId}:`, error);
  }
  // With no marker, a prompt is a session's first, as after `/clear`: the mod is about to name the list as it always does.
  // On any later event the mod is not running, and the client keeps tasks under the session id.
  if (marker === undefined) return process.env.CLAUDE_CODE_TASK_LIST_ID || (atPrompt ? taskListIdFor(root) : sessionId);
  const named = marker.task_list;
  return typeof named === "string" && named !== "" ? named : sessionId;
}

export type TaskList = { id: string; tasks: NativeTask[] };

/**
 * The session's native task list and its tasks in id order, as `runState` needs them. The client deletes a
 * finished list on its own, so a missing directory is an empty list and a file gone or torn mid-read is skipped.
 */
export function readTaskList(root: string, sessionId: string, { atPrompt = false }: ReadOptions = {}): TaskList {
  const id = taskListIdOf(root, sessionId, atPrompt);
  const config = configDir(process.env);
  if (config === undefined) return { id, tasks: [] };
  const dir = taskListDir(toPlatform(process.platform), config, id);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (!isMissing(error)) console.error(`omca: could not list the tasks in ${dir}:`, error);
    return { id, tasks: [] };
  }
  const tasks = names
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .flatMap((name) => {
      try {
        return parseTask(readFileSync(join(dir, name), "utf8")) ?? [];
      } catch {
        return [];
      }
    });
  return { id, tasks: withHistory([], tasks) };
}

export const readTasks = (root: string, sessionId: string, options: ReadOptions = {}): NativeTask[] => readTaskList(root, sessionId, options).tasks;

export type OpenRun = { name: string; open: readonly NativeTask[]; next: NativeTask };

/** The session's run while it has tasks still to do. Every open task may wait on another, and `next` then names the first. */
export function readOpenRun(root: string, sessionId: string, options: ReadOptions = {}): OpenRun | undefined {
  const run = runState(readTasks(root, sessionId, options));
  const next = run?.next ?? run?.open[0];
  return run === undefined || next === undefined ? undefined : { name: run.name, open: run.open, next };
}

export const seconds = (ms: number): number => Math.floor(ms / 1000);

/** The status file shows the main conversation's own slot: a subagent's run is that subagent's to log. */
export function writeStatus(root: string, session: Session, now: number): void {
  const status = {
    session_id: session.id,
    last_hook_at: seconds(now),
    verification: session.verifications?.get(MAIN_THREAD) ?? null,
  };
  writeFileAtomic(statusPath(root, session.id), `${JSON.stringify(status)}\n`);
  session.stampedAt = now;
}

export function stampIfDue(root: string, session: Session, now: number): void {
  if (session.stampedAt === undefined || now - session.stampedAt >= STAMP_INTERVAL_MS) writeStatus(root, session, now);
}
