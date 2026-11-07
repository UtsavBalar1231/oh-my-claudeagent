import { type NativeTask, runState } from "./native-tasks.ts";
import type { Glyphs } from "./ui-kit.ts";
import { fitPieces, type Piece, piecesWidth, type ThemeKey, TONE_KEYS } from "./visual.ts";

/** A run as the band and the transcript name it: done of total, the running ids, the ids closed as blocked. */
export type RunSummary = {
  name: string;
  done: number;
  total: number;
  running: readonly string[];
  blocked: readonly string[];
  isOpen: boolean;
};

/** What one turn did to a run's tasks. A task created already past pending counts as created and under its new state too. */
export type TaskChanges = {
  created: number;
  completed: readonly string[];
  started: readonly string[];
  blocked: readonly string[];
  isFinalDone: boolean;
};

export const TASK_LIST_COMMAND = "/tasklist";
const SHOWN_IDS = 3;
const BAR_CELLS = 14;

const isBlocked = (task: NativeTask): boolean => task.blockedReason !== "";
const isRunning = (task: NativeTask): boolean => task.status === "in_progress" && !isBlocked(task);
const isDone = (task: NativeTask): boolean => task.status === "completed" && !isBlocked(task);

/** The run `runState` names, counted over all its tasks; undefined when the list holds no run. */
export function runSummary(tasks: readonly NativeTask[]): RunSummary | undefined {
  const state = runState(tasks);
  if (state === undefined) return undefined;
  const own = tasks.filter((task) => task.run === state.name);
  return {
    name: state.name,
    done: own.filter(isDone).length,
    total: own.length,
    running: own.filter(isRunning).map((task) => task.id),
    blocked: own.filter(isBlocked).map((task) => task.id),
    isOpen: state.open.length > 0,
  };
}

/** The changes to the run named `run` between two reads of the list. */
export function taskChanges(before: readonly NativeTask[], after: readonly NativeTask[], run: string): TaskChanges {
  const previous = new Map(before.map((task) => [task.id, task]));
  const own = after.filter((task) => task.run === run);
  const became = (now: (task: NativeTask) => boolean) =>
    own.filter((task) => {
      const was = previous.get(task.id);
      return now(task) && (was === undefined || !now(was));
    });
  const finished = became(isDone);
  return {
    created: own.filter((task) => !previous.has(task.id)).length,
    completed: finished.filter((task) => !task.isFinal).map((task) => task.id),
    started: became(isRunning).map((task) => task.id),
    blocked: became(isBlocked).map((task) => task.id),
    isFinalDone: finished.some((task) => task.isFinal),
  };
}

export const hasChanges = (changes: TaskChanges): boolean =>
  changes.created > 0 || changes.completed.length > 0 || changes.started.length > 0 || changes.blocked.length > 0 || changes.isFinalDone;

const muted = (text: string): Piece => ({ text, color: TONE_KEYS.muted });

function idList(ids: readonly string[]): string {
  const shown = ids.slice(0, SHOWN_IDS).map((id) => `#${id}`);
  return [...shown, ...(ids.length > SHOWN_IDS ? [`+${ids.length - SHOWN_IDS}`] : [])].join(" ");
}

const marked = (mark: string, color: ThemeKey, text: string): Piece[] => [{ text: `${mark} `, color }, { text }];

const joined = (head: readonly Piece[], parts: readonly (readonly Piece[])[], g: Glyphs): Piece[] => [...head, ...parts.flatMap((part) => [muted(` ${g.dot} `), ...part])];

// The first candidate that fits; when none does, the last one cut to the width.
function firstFitting(candidates: readonly (readonly Piece[])[], columns: number, g: Glyphs): Piece[] {
  const fitting = candidates.find((pieces) => piecesWidth(pieces) <= columns);
  return fitting === undefined ? fitPieces(candidates.at(-1) ?? [], columns, g.ellipsis) : [...fitting];
}

const prefixes = <T>(parts: readonly T[]): T[][] => parts.map((_, index) => parts.slice(0, parts.length - index)).concat([[]]);

/**
 * The transcript row for a turn that changed a run: its name, done of total, then each kind of
 * change with its mark, then the `/tasklist` hint. Parts leave whole from the end as the row narrows.
 */
export function changeRow(summary: RunSummary, changes: TaskChanges, g: Glyphs, columns: number): Piece[] {
  const head: Piece[] = [{ text: `${g.final} `, color: TONE_KEYS.plan }, { text: summary.name, bold: true }, { text: `  ${summary.done}/${summary.total}` }];
  const parts: Piece[][] = [
    ...(changes.created > 0 ? [[muted(`+${changes.created} ${changes.created === 1 ? "task" : "tasks"}`)]] : []),
    ...(changes.completed.length > 0 ? [marked(g.check, TONE_KEYS.ok, idList(changes.completed))] : []),
    ...(changes.started.length > 0 ? [marked(g.progress, TONE_KEYS.active, idList(changes.started))] : []),
    ...(changes.blocked.length > 0 ? [[...marked(g.blocked, TONE_KEYS.fail, idList(changes.blocked)), muted(" blocked")]] : []),
    ...(changes.isFinalDone ? [[{ text: `${g.final} `, color: TONE_KEYS.plan }, muted("final done")]] : []),
    [muted(TASK_LIST_COMMAND)],
  ];
  return firstFitting(
    prefixes(parts).map((kept) => joined(head, kept, g)),
    columns,
    g,
  );
}

function thinBar({ done, running, total }: RunSummary, g: Glyphs): Piece[] {
  const [full, rest] = g.tier === "ascii" ? ["=", "-"] : ["━", "─"];
  const cellsOf = (count: number, room: number) => (count === 0 ? 0 : Math.min(room, Math.max(1, Math.round((count * BAR_CELLS) / total))));
  const doneCells = done < total ? Math.min(cellsOf(done, BAR_CELLS), BAR_CELLS - 1) : cellsOf(done, BAR_CELLS);
  const runningCells = cellsOf(running.length, BAR_CELLS - doneCells);
  const restCells = BAR_CELLS - doneCells - runningCells;
  return [
    { text: full.repeat(doneCells), color: TONE_KEYS.ok },
    { text: full.repeat(runningCells), color: TONE_KEYS.active },
    { text: rest.repeat(restCells), color: TONE_KEYS.muted },
  ].filter((piece) => piece.text !== "");
}

/**
 * The band's run line: name, a bar, done of total, the running ids and how many tasks were closed
 * as blocked. As it narrows the bar leaves first, then the running ids, then the blocked count.
 */
export function bandRunLine(summary: RunSummary, g: Glyphs, columns: number): Piece[] {
  const name: Piece[] = [{ text: `${g.final} `, color: TONE_KEYS.plan }, { text: summary.name }];
  const count: Piece = { text: `${summary.done}/${summary.total}` };
  const running = summary.running.length > 0 ? [marked(g.progress, TONE_KEYS.active, idList(summary.running))] : [];
  const blocked = summary.blocked.length > 0 ? [marked(g.blocked, TONE_KEYS.fail, String(summary.blocked.length))] : [];
  const withBar = [...name, { text: " " }, ...thinBar(summary, g), { text: " " }, count];
  const withoutBar = [...name, { text: " " }, count];
  return firstFitting(
    [joined(withBar, [...running, ...blocked], g), joined(withoutBar, [...running, ...blocked], g), joined(withoutBar, blocked, g), withoutBar],
    columns,
    g,
  );
}
