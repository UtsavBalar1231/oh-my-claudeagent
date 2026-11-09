import type { CommandRunResult, RenderElement, Timer } from "claude-code";
import { namesTask } from "../src/core/evidence.ts";
import { windowEnd } from "../src/core/list-window.ts";
import { groupTasks, isOpen, type NativeTask, openBlockers, parseTask, runState, TASK_TOOLS_OFF, type TaskGroup, taskListDir, withHistory } from "../src/core/native-tasks.ts";
import { arrange, COLUMN_GAP, displayWidth, fitEnd, formatWhen, type Glyphs, glyphs, KEYS, oneLine, padStart, usableColumns, wrapText } from "../src/core/ui-kit.ts";
import { fitPieces, ON_SURFACE, type Piece, piecesWidth, redact, type ThemeKey, TONE_KEYS, widthTier, wrapPieces } from "../src/core/visual.ts";
import type { Features, Input } from "./dispatch.ts";
import { type Host, reason, resolvedSession, sessionOf, type State, update } from "./host.ts";
import { blanks, bodyRows, dockColumns, INLINE_REQUEST_ROWS, keyButton, noticeRow, remoteTree, type View } from "./pane.ts";
import { aimKeys, commitLayout, committedLayout, hasOverflow, markdownUnits, newLayout, resetOffset, scrollAt, scrollKeyed, ScrollRegion, type Unit } from "./regions.ts";
import * as evidence from "./tabs/evidence.ts";
import { hasTaskTools } from "./task-tools.ts";
import { isRemote, kitOf, Line, rowsAtLeast, type TextStyle } from "./ui.ts";

const TASK_PANE = "tasklist";
export const TASK_COMMAND = "tasklist";
const READ_EVERY_MS = 2000;
const ROW = "task-";
const LINK = "link-";
const FOLD = "fold-";
const PAGE = "tasklist-page";
const BACK = "b";
const DONE_KEY = "d";
const WORDS = { loading: "Reading the task list", empty: "No tasks yet." };
const EMPTY_HINT = "Claude adds tasks here when it plans multi-step work.";
const CLEARED = "Finished. Claude Code cleared its list; the record stays here.";
const HINT_GAP = 3;
const ASIDE_SHARE = 0.4;
const TITLE_ROWS = 2;
const STATE_WORD: Readonly<Record<GroupName, string>> = { Running: "Running", Ready: "Ready", Blocked: "Blocked", Waiting: "Waiting", Done: "Done" };

type GroupName = TaskGroup["name"];
type Mark = { text: string; color: ThemeKey };
type Run = { name: string; tasks: readonly NativeTask[] };
type Item = { kind: "blank" | "rule" | "fold" | "task"; rows: number; id?: string; draw: (current: string | undefined) => RenderElement[] };
type Ledger = State["ledger"];

let opened: string | undefined;
let cursor: string | undefined;
let first = 0;
let timer: Timer | undefined;
let laid: { ids: readonly string[]; itemOf: (id: string) => number; stopFrom: (from: number) => number; last: number } | undefined;
let isDoneShown = false;
let unfolded = new Set<string>();
let revealing: readonly string[] = [];
// The list as the last successful sync read it, for a row that must not redraw on each write to the tasks atom.
let synced: readonly NativeTask[] = [];

export const taskSubject = (id: string): string | undefined => synced.find((task) => task.id === id)?.subject;

const reset = (): void => {
  opened = undefined;
  cursor = undefined;
  first = 0;
  laid = undefined;
  isDoneShown = false;
  unfolded = new Set();
  revealing = [];
  resetOffset(PAGE);
};

async function readList(host: Host, dir: string): Promise<NativeTask[]> {
  if (!(await host.fs.exists(dir))) return [];
  const entries = await host.fs.list(dir);
  const names = entries.filter(({ name, kind }) => kind === "file" && name.endsWith(".json") && !name.startsWith(".")).map(({ name }) => name);
  // Claude Code deletes a finished list's files on its own, so one can go between the listing and its read.
  const texts = await Promise.all(names.map((name) => host.fs.read(`${dir}/${name}`).catch(() => "")));
  return texts.flatMap((text) => parseTask(text) ?? []);
}

/**
 * Reads this session's list into the tab's atom. Claude Code stores it under the id
 * `CLAUDE_CODE_TASK_LIST_ID` names, else under the session's own.
 */
async function sync(host: Host, forgotten?: string): Promise<void> {
  const [{ platform, config }, sessionId, named] = await Promise.all([sessionOf(host), host.session.id(), host.env.CLAUDE_CODE_TASK_LIST_ID()]);
  const list = named === undefined || named === "" ? sessionId : named;
  let read: NativeTask[] = [];
  let error: string | null = null;
  if (config === undefined) {
    error = "None of HOME, USERPROFILE or CLAUDE_CONFIG_DIR is set";
  } else {
    try {
      read = await readList(host, taskListDir(platform, config, list));
    } catch (failure) {
      error = reason(failure);
    }
  }
  const hasTools = read.length > 0 || (await hasTaskTools(host));
  await update(host.state.tasks, (previous) => {
    const tasks = withHistory(previous?.tasks ?? [], read, forgotten);
    if (error === null) synced = tasks;
    const next = { tasks, hasTools, isCleared: read.length === 0 && tasks.length > 0, error, list };
    return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
  });
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const shownText = (view: View, text: string) => redact(text, view.home, view.g.mask).text;
const firstLine = (text: string) => text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
const sum = (heights: readonly number[]) => heights.reduce((total, rows) => total + rows, 0);
const muted = (text: string): Piece => ({ text, color: TONE_KEYS.muted });
const spaces = (cells: number): Piece => ({ text: " ".repeat(Math.max(0, cells)) });

const symbols = (g: Glyphs) => (g.tier === "ascii" ? { heavy: "=", back: "<-", enter: "enter" } : { heavy: "━", back: "←", enter: "⏎" });

function markOf(g: Glyphs, group: GroupName, task?: NativeTask): Mark {
  if (task?.isFinal === true) return { text: g.final, color: TONE_KEYS.plan };
  switch (group) {
    case "Running":
      return { text: g.progress, color: TONE_KEYS.active };
    case "Ready":
      return { text: g.pending, color: TONE_KEYS.info };
    case "Blocked":
      return { text: g.blocked, color: TONE_KEYS.fail };
    case "Waiting":
      return { text: g.dot, color: TONE_KEYS.muted };
    case "Done":
      return { text: g.check, color: TONE_KEYS.ok };
  }
}

/** The run with work left in full, and every other run, and the tasks in none, to fold under it. */
function runsOf(tasks: readonly NativeTask[]): { main: Run; others: Run[] } {
  const named = runState(tasks)?.name ?? "";
  const hasOpen = (name: string) => tasks.some((task) => task.run === name && isOpen(task));
  const main = named !== "" && !hasOpen(named) && hasOpen("") ? "" : named;
  const names = [...new Set(tasks.map((task) => task.run))].filter((name) => name !== main).sort((a, b) => Number(a === "") - Number(b === ""));
  const runOf = (name: string): Run => ({ name, tasks: tasks.filter((task) => task.run === name) });
  return { main: runOf(main), others: names.map(runOf) };
}

// Blockers are looked up on the whole list, so a task in one run can wait on another run's.
const groupsOf = (run: Run, tasks: readonly NativeTask[]): TaskGroup[] =>
  groupTasks(tasks)
    .map((group) => ({ ...group, tasks: group.tasks.filter((task) => task.run === run.name) }))
    .filter((group) => group.tasks.length > 0);

const groupOf = (task: NativeTask, tasks: readonly NativeTask[]): GroupName => groupTasks(tasks).find((group) => group.tasks.includes(task))?.name ?? "Ready";

/** Every task in the order the list draws them, folded ones included. */
function orderOf(tasks: readonly NativeTask[]): string[] {
  const { main, others } = runsOf(tasks);
  return [main, ...others].flatMap((run) => groupsOf(run, tasks).flatMap((group) => group.tasks.map((task) => task.id)));
}

const doneCount = (run: Run, tasks: readonly NativeTask[]) => groupsOf(run, tasks).find((group) => group.name === "Done")?.tasks.length ?? 0;
const tally = (run: Run, tasks: readonly NativeTask[]) => `${doneCount(run, tasks)} of ${run.tasks.length} done`;

// A waiting task names its first open blocker and how many more; the final task, how many are open.
function asideOf(view: View, task: NativeTask, group: GroupName, tasks: readonly NativeTask[], cap: number): string {
  if (group === "Running") return fitEnd(shownText(view, oneLine(task.owner)), cap, view.g.ellipsis);
  if (group !== "Waiting") return "";
  const { back } = symbols(view.g);
  const open = openBlockers(task, tasks);
  if (task.isFinal) return `${back} ${open.length} open`;
  const head = `${back} #${open[0] ?? ""}`;
  const full = open.length > 1 ? `${head} +${open.length - 1}` : head;
  return displayWidth(full) <= cap ? full : head;
}

/** A section divider of exactly the width: its label first, then the rule, then a muted tail such as a key. */
function rulePieces(view: View, head: readonly Piece[], tail = ""): Piece[] {
  const { g, width } = view;
  const end: Piece[] = tail === "" ? [] : [muted(` ${tail} `), muted(g.rule)];
  const label = fitPieces(head, Math.max(0, width - piecesWidth(end) - 2), g.ellipsis);
  return [...label, { text: " " }, muted(g.rule.repeat(Math.max(0, width - piecesWidth(label) - 1 - piecesWidth(end)))), ...end];
}

const label = (text: string): Piece => ({ text, color: ON_SURFACE, bold: true });

// `$.ui.focus` lands on the next drawing, so the focus is sent after the invalidate it follows.
function refocus(host: Host, key: string): void {
  host.clock.after(0, async () => {
    try {
      host.ui.invalidate();
      const { deny } = await host.ui.focus({ requestId: TASK_PANE, key });
      if (deny !== undefined) host.log(`omca tasks could not focus ${key}: ${deny}`);
    } catch (error) {
      host.log(`omca tasks could not focus ${key}: ${reason(error)}`);
    }
  });
}

async function press(host: Host, view: View, id: string, tasks: readonly NativeTask[]): Promise<void> {
  if (tasks.find((task) => task.id === id)?.isFinal === true) {
    try {
      await evidence.sync(host, await host.session.root());
    } catch (error) {
      host.log(`omca tasks could not read the ledger: ${reason(error)}`);
    }
  }
  opened = id;
  cursor = id;
  resetOffset(PAGE);
  aimKeys(PAGE);
  host.ui.invalidate();
  if (isRemote(view.kit)) refocus(host, BACK);
}

// The row it goes back to is drawn, its fold opened and the window carried to it.
function close(host: Host, id: string, tasks: readonly NativeTask[]): void {
  const task = tasks.find((one) => one.id === id);
  if (task !== undefined) {
    const { main } = runsOf(tasks);
    if (task.run !== main.name) unfolded.add(task.run);
    else if (groupOf(task, tasks) === "Done") isDoneShown = true;
  }
  opened = undefined;
  revealing = [id];
  aimKeys(undefined);
  host.ui.invalidate();
  refocus(host, `${ROW}${id}`);
}

async function stepTo(host: Host, view: View, id: string, tasks: readonly NativeTask[], by: number): Promise<void> {
  const order = orderOf(tasks);
  const to = order[clamp(order.indexOf(id) + by, 0, order.length - 1)];
  if (to !== undefined && to !== id) await press(host, view, to, tasks);
}

const isMarked = ({ color }: Piece): boolean => color !== undefined && color !== TONE_KEYS.muted;

type RowSpec = { key: string; label: string; lead: readonly Piece[]; body: readonly Piece[]; aside: readonly Piece[]; isCurrent: boolean; onPress: () => unknown };

/**
 * One pressable row. On the terminal the row is one Button whose Text children are the pieces, so a
 * click anywhere on it presses; a remote surface strips a Button's children, so there the label is the Button.
 */
function pressRow(view: View, spec: RowSpec): RenderElement {
  const { kit } = view;
  const { key, lead, body, aside, isCurrent } = spec;
  const onPress = view.press(spec.onPress);
  if (isRemote(kit)) {
    const text = (pieces: readonly Piece[]) => pieces.filter((piece) => piece.text.trim() !== "").map(({ text: value, ...style }) => kit.Text({ ...style, children: [value] }));
    return kit.Box({
      key: `line-${key}`,
      flexDirection: "row",
      columnGap: 1,
      children: [...text(lead), kit.Button({ key, label: spec.label, plain: true, onPress }), kit.Box({ flexGrow: 1 }), ...text(aside)],
    });
  }
  const pieces = [...lead, ...body, ...aside];
  const shown = isCurrent ? pieces.map((piece) => (isMarked(piece) ? { ...piece, bold: true as const } : { text: piece.text, color: ON_SURFACE, bold: true as const })) : pieces;
  const lit = (piece: Piece): TextStyle =>
    isCurrent ? { backgroundColor: TONE_KEYS.focus } : { hover: isMarked(piece) ? { backgroundColor: TONE_KEYS.focus } : { color: ON_SURFACE, backgroundColor: TONE_KEYS.focus } };
  return kit.Box({
    key: `line-${key}`,
    children: [
      kit.Button({
        key,
        label: spec.label,
        plain: true,
        // The pointer inverts a Button; the row shows the focus background under it instead.
        hover: { inverse: false },
        ...(isCurrent ? { autoFocus: true } : {}),
        onPress,
        children: shown.map(({ text, ...style }) => kit.Text({ ...style, ...lit({ text, ...style }), children: [text] })),
      }),
    ],
  });
}

type Columns = { id: number; aside: number };

function taskItem(host: Host, view: View, task: NativeTask, group: GroupName, columns: Columns, tasks: readonly NativeTask[]): Item {
  const { g, width } = view;
  const mark = markOf(g, group, task);
  const lead: Piece[] = [{ text: mark.text, color: mark.color }, muted(` ${padStart(`#${task.id}`, columns.id)}  `)];
  const leadCells = piecesWidth(lead);
  const aside = asideOf(view, task, group, tasks, columns.aside);
  const room = Math.max(1, width - leadCells - (columns.aside > 0 ? columns.aside + COLUMN_GAP : 0));
  const subject = fitEnd(shownText(view, task.subject), room, g.ellipsis);
  const subjectPiece: Piece = group === "Done" ? { text: subject, dimColor: true } : { text: subject };
  const body: Piece[] = [subjectPiece, spaces(width - leadCells - displayWidth(subject) - columns.aside)];
  const asidePieces = columns.aside > 0 ? [muted(aside), spaces(columns.aside - displayWidth(aside))] : [];
  const why = task.blockedReason === "" ? [] : [Line(view.kit, [spaces(leadCells), muted(fitEnd(shownText(view, oneLine(task.blockedReason)), width - leadCells, g.ellipsis))])];
  return {
    kind: "task",
    id: task.id,
    rows: 1 + why.length,
    draw: (current) => [
      pressRow(view, { key: `${ROW}${task.id}`, label: shownText(view, task.subject), lead, body, aside: asidePieces, isCurrent: current === task.id, onPress: () => press(host, view, task.id, tasks) }),
      ...why,
    ],
  };
}

function groupItems(host: Host, view: View, group: TaskGroup, idCells: number, tasks: readonly NativeTask[]): Item[] {
  const cap = Math.max(8, Math.floor(view.width * ASIDE_SHARE));
  const aside = Math.max(0, ...group.tasks.map((task) => displayWidth(asideOf(view, task, group.name, tasks, cap))));
  return group.tasks.map((task) => taskItem(host, view, task, group.name, { id: idCells, aside }, tasks));
}

function foldItem(view: View, key: string, head: readonly Piece[], tail: string, controlLabel: string, onPress: () => void): Item {
  const pieces = rulePieces(view, head, tail);
  return {
    kind: "fold",
    rows: 1,
    draw: () => [
      isRemote(view.kit)
        ? view.kit.Box({ key: `line-${key}`, flexDirection: "row", columnGap: COLUMN_GAP, children: [Line(view.kit, head), view.kit.Button({ key, label: controlLabel, plain: true, onPress: view.press(onPress) })] })
        : pressRow(view, { key, label: controlLabel, lead: [], body: pieces, aside: [], isCurrent: false, onPress }),
    ],
  };
}

function itemsOf(host: Host, view: View, tasks: readonly NativeTask[], isRelaxed: boolean): Item[] {
  const { kit, g } = view;
  const { main, others } = runsOf(tasks);
  const groups = groupsOf(main, tasks);
  const idCells = Math.max(0, ...tasks.map((task) => displayWidth(`#${task.id}`)));
  const items: Item[] = [];
  const gap = () => {
    if (isRelaxed && items.length > 0) items.push({ kind: "blank", rows: 1, draw: () => [kit.Text({ children: [" "] })] });
  };
  const rule = (head: readonly Piece[]) => items.push({ kind: "rule", rows: 1, draw: () => [Line(kit, rulePieces(view, head))] });
  const isOnlyDone = groups.every((group) => group.name === "Done");
  for (const group of groups) {
    const doneHead = [label(STATE_WORD.Done), { text: ` ${g.check}`, color: TONE_KEYS.ok }, muted(` ${group.tasks.length}`)];
    gap();
    if (group.name !== "Done") {
      rule([label(STATE_WORD[group.name])]);
    } else if (isOnlyDone) {
      rule(doneHead);
    } else {
      items.push(foldItem(view, `${FOLD}done`, doneHead, `${DONE_KEY}: ${isDoneShown ? "hide" : "show"}`, `${isDoneShown ? "Hide" : "Show"} done`, () => toggleDone(host, tasks)));
      if (!isDoneShown) continue;
    }
    items.push(...groupItems(host, view, group, idCells, tasks));
  }
  for (const run of others) {
    const isOpened = unfolded.has(run.name);
    const name = run.name === "" ? "No run" : oneLine(shownText(view, run.name));
    gap();
    items.push(
      foldItem(view, `${FOLD}run-${run.name}`, [label(name), muted(` ${tally(run, tasks)}`)], isOpened ? "hide" : "show", `${isOpened ? "Hide" : "Show"} ${name}`, () => toggleRun(host, run, tasks)),
    );
    if (isOpened) items.push(...groupsOf(run, tasks).flatMap((group) => groupItems(host, view, group, idCells, tasks)));
  }
  return items;
}

// A line of heavy cells for what is done and running, light for the rest, in their states' colors.
function progressLine(view: View, done: number, running: number, total: number): Piece[] {
  const { g, width } = view;
  const { heavy } = symbols(g);
  const cellsOf = (count: number) => (count <= 0 || total <= 0 ? 0 : Math.max(1, Math.round((count / total) * width)));
  const doneCells = Math.min(width, cellsOf(done));
  const runningCells = Math.min(width - doneCells, cellsOf(running));
  return [
    ...(doneCells > 0 ? [{ text: heavy.repeat(doneCells), color: TONE_KEYS.ok }] : []),
    ...(runningCells > 0 ? [{ text: heavy.repeat(runningCells), color: TONE_KEYS.active }] : []),
    muted(g.rule.repeat(width - doneCells - runningCells)),
  ];
}

const COUNTED: readonly (readonly [GroupName, string])[] = [
  ["Running", "running"],
  ["Ready", "ready"],
  ["Blocked", "blocked"],
  ["Waiting", "waiting"],
];

function countsPieces(view: View, groups: readonly TaskGroup[]): Piece[] {
  const parts = COUNTED.flatMap(([name, word]) => {
    const count = groups.find((group) => group.name === name)?.tasks.length ?? 0;
    if (count === 0) return [];
    const mark = markOf(view.g, name);
    return [[{ text: mark.text, color: mark.color }, muted(` ${count} ${word}`)]];
  });
  const out: Piece[] = [];
  for (const part of parts) {
    const next = out.length === 0 ? part : [spaces(HINT_GAP), ...part];
    if (piecesWidth(out) + piecesWidth(next) > view.width) break;
    out.push(...next);
  }
  return out;
}

/** The run's name in full, wrapped to two rows at most, with its count at the right of the last. */
function nameRows(view: View, run: Run, tasks: readonly NativeTask[]): RenderElement[] {
  const { kit, g, width } = view;
  const count = tally(run, tasks);
  const name = oneLine(shownText(view, run.name));
  if (name === "") return [Line(kit, [muted(count)])];
  const wrapped = wrapText(name, width);
  const rows = wrapped.length > TITLE_ROWS ? [...wrapped.slice(0, TITLE_ROWS - 1), fitEnd(wrapped.slice(TITLE_ROWS - 1).join(" "), width, g.ellipsis)] : wrapped;
  const last = rows.at(-1) ?? "";
  const isBeside = displayWidth(last) + COLUMN_GAP + displayWidth(count) <= width;
  const drawn = rows.map((row, index) =>
    Line(kit, index === rows.length - 1 && isBeside ? [label(row), spaces(width - displayWidth(row) - displayWidth(count)), muted(count)] : [label(row)]),
  );
  return isBeside ? drawn : [...drawn, Line(kit, [spaces(width - displayWidth(count)), muted(count)])];
}

function hintRow(host: Host, view: View, tasks: readonly NativeTask[], hasDoneFold: boolean): RenderElement {
  const { kit, g } = view;
  const { enter } = symbols(g);
  type Hint = { priority: number; min: number; element: RenderElement };
  const text = (value: string, priority: number): Hint => ({ priority, min: displayWidth(value), element: kit.Text({ dimColor: true, children: [value] }) });
  const done = `${DONE_KEY}: done`;
  const hints: Hint[] = [
    text(`${g.up}${g.down} move`, 3),
    text(`${enter} open`, 2),
    ...(hasDoneFold ? [{ priority: 1, min: displayWidth(done), element: keyButton(view, DONE_KEY, "done", () => toggleDone(host, tasks)) }] : []),
    text("esc close", 4),
  ];
  return kit.Box({ key: "hints", flexDirection: "row", columnGap: HINT_GAP, children: arrange(hints, view.width, HINT_GAP).map((hint) => hint.element) });
}

// The cursor moves into what opens, or out of what closes, and the window follows it: to the end of
// what opened first, then back up to the cursor if that left it above.
function revealCursor(host: Host, id: string | undefined, end?: string): void {
  cursor = id;
  revealing = id === undefined ? [] : [...(end === undefined ? [] : [end]), id];
  host.ui.invalidate();
  if (id !== undefined) refocus(host, `${ROW}${id}`);
}

function toggleDone(host: Host, tasks: readonly NativeTask[]): void {
  const groups = groupsOf(runsOf(tasks).main, tasks);
  const done = groups.find((group) => group.name === "Done")?.tasks.map((task) => task.id) ?? [];
  const before = groups.filter((group) => group.name !== "Done").flatMap((group) => group.tasks.map((task) => task.id));
  isDoneShown = !isDoneShown;
  if (isDoneShown) revealCursor(host, done[0], done.at(-1));
  else revealCursor(host, cursor !== undefined && done.includes(cursor) ? before.at(-1) : cursor);
}

function toggleRun(host: Host, run: Run, tasks: readonly NativeTask[]): void {
  const ids = groupsOf(run, tasks).flatMap((group) => group.tasks.map((task) => task.id));
  if (unfolded.delete(run.name)) revealCursor(host, cursor !== undefined && ids.includes(cursor) ? undefined : cursor);
  else {
    unfolded.add(run.name);
    revealCursor(host, ids[0], ids.at(-1));
  }
}

type Level = { isRelaxed: boolean; isSpaced: boolean; hasCounts: boolean };

const RELAXED: Level = { isRelaxed: true, isSpaced: true, hasCounts: true };
const COMPACT: Level = { isRelaxed: false, isSpaced: false, hasCounts: false };
// Blank rows give way first, the counts row next; a list still too long then windows its rows.
const LEVELS: readonly Level[] = [RELAXED, { isRelaxed: true, isSpaced: false, hasCounts: true }, { isRelaxed: false, isSpaced: false, hasCounts: true }, COMPACT];

function list(host: Host, view: View, tasks: readonly NativeTask[], isCleared: boolean): RenderElement[] {
  const { kit, g, width } = view;
  const isRemoteDrawing = isRemote(kit);
  const { main } = runsOf(tasks);
  const groups = groupsOf(main, tasks);
  const done = doneCount(main, tasks);
  const running = groups.find((group) => group.name === "Running")?.tasks.length ?? 0;
  const hasDoneFold = done > 0 && groups.some((group) => group.name !== "Done");
  const counts = countsPieces(view, groups);
  const note = isCleared ? [kit.Text({ dimColor: true, children: [fitEnd(CLEARED, width, g.ellipsis)] })] : [];
  const names = nameRows(view, main, tasks);
  const hints = isRemoteDrawing ? [] : [hintRow(host, view, tasks, hasDoneFold)];
  const headOf = (level: Level) => [...names, Line(kit, progressLine(view, done, running, main.tasks.length)), ...(level.hasCounts && counts.length > 0 ? [Line(kit, counts)] : []), ...note];
  const spacer = (level: Level) => (level.isSpaced ? 1 : 0);
  const fixedRows = (level: Level) => headOf(level).length + 2 * spacer(level) + hints.length;
  const relaxed = itemsOf(host, view, tasks, true);
  const compact = isRemoteDrawing ? relaxed : itemsOf(host, view, tasks, false);
  const itemsAt = (level: Level) => (level.isRelaxed ? relaxed : compact);
  const level = isRemoteDrawing ? RELAXED : (LEVELS.find((one) => fixedRows(one) + sum(itemsAt(one).map((item) => item.rows)) <= view.rows) ?? COMPACT);
  const items = itemsAt(level);
  const head = headOf(level);
  const top = head.length + spacer(level);
  const available = isRemoteDrawing ? Number.POSITIVE_INFINITY : Math.max(1, view.rows - fixedRows(level));
  const heights = items.map((item) => item.rows);
  const fits = sum(heights) <= available;
  const isRow = (item: Item | undefined) => item?.kind === "task" || item?.kind === "fold";
  // The window from an item: a row for the cue below always, one for the cue above past the first item,
  // and never a heading left as its last row with its tasks out of view.
  const stopFrom = (from: number): number => {
    let stop = windowEnd(heights, from, Math.max(1, available - 1 - (from > 0 ? 1 : 0)));
    while (stop > from + 1 && !isRow(items[stop - 1])) stop -= 1;
    while (stop < items.length && !isRow(items[stop - 1])) stop += 1;
    return stop;
  };
  const restFits = (from: number) => sum(heights.slice(from)) <= available - (from > 0 ? 1 : 0);
  const firstFitting = items.findIndex((_, from) => restFits(from));
  const last = fits ? 0 : firstFitting < 0 ? items.length - 1 : firstFitting;
  const tasksOnly = items.flatMap((item, index) => (item.kind === "task" && item.id !== undefined ? [{ id: item.id, index }] : []));
  const current = tasksOnly.some(({ id }) => id === cursor) ? cursor : tasksOnly[0]?.id;
  const itemOf = (id: string) => tasksOnly.find((one) => one.id === id)?.index ?? 0;
  first = clamp(first, 0, last);
  for (const id of fits ? [] : revealing.filter((one) => tasksOnly.some((task) => task.id === one))) {
    const at = itemOf(id);
    if (at <= first) first = Math.max(0, at - 1);
    while (at >= stopFrom(first) && first < last) first += 1;
  }
  revealing = [];
  const stop = fits || restFits(first) ? items.length : stopFrom(first);
  laid = fits || isRemoteDrawing ? undefined : { ids: tasksOnly.map(({ id }) => id), itemOf, stopFrom, last };
  const cue = (text: string) => kit.Text({ dimColor: true, children: [fitEnd(text, width, g.ellipsis)] });
  const rows = items.slice(first, stop).flatMap((item) => item.draw(current));
  const hidden = (part: readonly Item[]) => {
    const count = part.filter((item) => item.kind === "task").length;
    return count > 0 ? `${count} more` : "more";
  };
  const above = first > 0 ? [cue(`${g.up} ${hidden(items.slice(0, first))}`)] : [];
  const below = stop < items.length ? [cue(`${g.down} ${hidden(items.slice(stop))}`)] : [];
  const shownRows = above.length + sum(heights.slice(first, stop)) + below.length;
  if (!fits && !isRemoteDrawing) {
    view.layout.lists.push({
      left: 0,
      top,
      width,
      height: shownRows,
      move: (by) => {
        first = clamp(first + by, 0, last);
      },
    });
  }
  const spacing = blanks(view, spacer(level));
  if (isRemoteDrawing) return [...head, ...spacing, ...rows];
  // Hints sit on the pane's last row; a windowed list adds one row past the body so the arrows reach `ui.scroll`.
  const filler = blanks(view, view.rows - top - shownRows - spacer(level) - hints.length);
  return [...head, ...spacing, ...above, ...rows, ...below, ...filler, ...spacing, ...hints, ...(fits ? [] : blanks(view, 1))];
}

function linkUnits(host: Host, view: View, name: string, ids: readonly string[], task: NativeTask, tasks: readonly NativeTask[]): Unit[] {
  if (ids.length === 0) return [];
  const { kit, g, width } = view;
  const open = ids.filter((id) => tasks.some((other) => other.id === id && isOpen(other))).length;
  const idCells = Math.max(0, ...[...task.blockedBy, ...task.blocks].map((id) => displayWidth(`#${id}`)));
  const tail = name === "Waits on" && open > 0 ? `${open} open` : "";
  const rows = ids.map((id): Unit => {
    const other = tasks.find((one) => one.id === id);
    const number = muted(` ${padStart(`#${id}`, idCells)}  `);
    if (other === undefined) return { element: Line(kit, fitPieces([muted(g.dot), number, muted("not on the list")], width, g.ellipsis)), rows: 1 };
    const mark = markOf(g, groupOf(other, tasks), other);
    const lead: Piece[] = [{ text: mark.text, color: mark.color }, number];
    const subject = fitEnd(shownText(view, other.subject), width - piecesWidth(lead), g.ellipsis);
    const body: Piece[] = [{ text: subject, ...(other.status === "completed" ? { dimColor: true as const } : {}) }, spaces(width - piecesWidth(lead) - displayWidth(subject))];
    const element = pressRow(view, { key: `${LINK}${task.id}-${id}`, label: shownText(view, other.subject), lead, body, aside: [], isCurrent: false, onPress: () => press(host, view, id, tasks) });
    return { element, rows: 1 };
  });
  return [{ element: Line(kit, rulePieces(view, [label(name)], tail)), rows: 1 }, ...rows];
}

function verdictUnits(view: View, task: NativeTask, list: string, ledger: Ledger | undefined): Unit[] {
  const { kit, g, width } = view;
  const one = (pieces: readonly Piece[]): Unit => ({ element: Line(kit, fitPieces(pieces, width, g.ellipsis)), rows: 1 });
  const head = { element: Line(kit, rulePieces(view, [label("Verdict")])), rows: 1 };
  if (ledger === undefined) return [head, one([muted("The evidence ledger has not been read yet.")])];
  if (ledger.error !== null) return [head, ...wrapPieces([{ text: shownText(view, ledger.error), color: TONE_KEYS.fail }], width).map(one)];
  const entry = ledger.entries.findLast((each) => namesTask(each, { list, run: task.run, id: task.id }));
  if (entry === undefined) return [head, one([muted(`No verdict names #${task.id} yet`)])];
  const isPass = entry.exitCode === 0;
  const outcome: Piece[] = [
    { text: isPass ? g.check : g.cross, color: isPass ? TONE_KEYS.ok : TONE_KEYS.fail },
    { text: isPass ? " Passed" : " Failed", bold: true },
    muted(` ${g.dot} exit ${entry.exitCode} ${g.dot} ${formatWhen(entry.at)}`),
  ];
  const said = firstLine(shownText(view, entry.snippet));
  return [head, one(outcome), ...(said === "" ? [] : [one([muted(said)])])];
}

async function page(host: Host, view: View, task: NativeTask, tasks: readonly NativeTask[], list: string): Promise<RenderElement[]> {
  const { kit, g, width } = view;
  const group = groupOf(task, tasks);
  const mark = markOf(g, group, task);
  const wrapped = wrapPieces([muted(`#${task.id}`), { text: " " }, { text: shownText(view, task.subject), bold: true }], width);
  const title = wrapped.length > TITLE_ROWS ? [...wrapped.slice(0, TITLE_ROWS - 1), fitPieces(wrapped.slice(TITLE_ROWS - 1).flatMap((row) => [{ text: " " }, ...row]).slice(1), width, g.ellipsis)] : wrapped;
  const state: Piece[] = [
    { text: mark.text, color: mark.color },
    { text: ` ${STATE_WORD[group]}` },
    ...(task.isFinal ? [muted(` ${g.dot} final`)] : []),
    ...(task.owner === "" ? [] : [muted(` ${g.dot} ${shownText(view, oneLine(task.owner))}`)]),
  ];
  const head = [...title.map((row) => Line(kit, row)), Line(kit, fitPieces(state, width, g.ellipsis))];
  const blank = (): Unit => ({ element: kit.Text({ children: [" "] }), rows: 1 });
  const section = (units: readonly Unit[]): Unit[] => (units.length === 0 ? [] : [blank(), ...units]);
  const why = wrapPieces([muted(shownText(view, oneLine(task.blockedReason)))], width).map((row): Unit => ({ element: Line(kit, row), rows: 1 }));
  const ledger = task.isFinal ? (await host.state.ledger.get()).value : undefined;
  const description = markdownUnits(kit, shownText(view, task.description), width, PAGE);
  const details = task.details.map(({ name, text }) => ({
    element: Line(kit, fitPieces([muted(`${name}  `), { text: shownText(view, text) }], width, g.ellipsis)),
    rows: 1,
  }));
  const units: Unit[] = [
    ...(task.blockedReason === "" ? [] : why),
    ...(task.isFinal ? section(verdictUnits(view, task, list, ledger)) : []),
    ...section(linkUnits(host, view, "Waits on", task.blockedBy, task, tasks)),
    ...section(linkUnits(host, view, "Holds up", task.blocks, task, tasks)),
    ...section(description.length === 0 ? [] : [{ element: Line(kit, rulePieces(view, [label("Description")])), rows: 1 }, ...description]),
    ...section(details.length === 0 ? [] : [{ element: Line(kit, rulePieces(view, [label("Details")])), rows: 1 }, ...details]),
  ];
  const order = orderOf(tasks);
  const at = order.indexOf(task.id);
  const keys = kit.Box({
    key: "page-keys",
    flexDirection: "row",
    columnGap: COLUMN_GAP,
    children: [
      keyButton(view, BACK, "Back", () => close(host, task.id, tasks)),
      keyButton(view, KEYS.next, "Next", () => stepTo(host, view, task.id, tasks, 1), at >= order.length - 1),
      keyButton(view, KEYS.prev, "Previous", () => stepTo(host, view, task.id, tasks, -1), at <= 0),
    ],
  });
  const body = units.length === 0 ? [] : [ScrollRegion({ kit, g, key: PAGE, left: 0, top: head.length, width, height: view.rows - head.length - 1, units, layout: view.layout })];
  return isRemote(kit) ? [...head, keys, ...body] : [...head, ...body, keys];
}

/** Keeps the selection on screen; only a list too long for the pane reaches this. */
function scroll(host: Host, e: Input<"ui.scroll">): boolean {
  if (laid === undefined || opened !== undefined) return false;
  const { ids, itemOf, stopFrom, last } = laid;
  const at = cursor === undefined ? -1 : ids.indexOf(cursor);
  const isPage = Math.abs(e.by) === e.bodyRows;
  const isEnd = !isPage && Math.abs(e.by) === e.contentRows;
  const step = isPage ? Math.max(1, e.bodyRows - 1) : 1;
  const to = isEnd ? (e.by > 0 ? ids.length - 1 : 0) : clamp((at < 0 && e.by > 0 ? -1 : Math.max(at, 0)) + Math.sign(e.by) * step, 0, ids.length - 1);
  cursor = ids[to];
  if (cursor === undefined) return true;
  const item = itemOf(cursor);
  // Up to the group's label when it is the row above, so the top of the list shows its heading.
  if (item <= first) first = Math.max(0, item - 1);
  while (item >= stopFrom(first) && first < last) first += 1;
  host.ui.invalidate();
  refocus(host, `${ROW}${cursor}`);
  return true;
}

const content = async (host: Host, view: View): Promise<readonly RenderElement[]> => {
  const snapshot = (await host.state.tasks.get()).value;
  if (snapshot === undefined) return [noticeRow(view, { kind: "loading" }, WORDS)];
  if (snapshot.error !== null) return [noticeRow(view, { kind: "error", reason: snapshot.error }, WORDS)];
  const { tasks } = snapshot;
  if (tasks.length === 0) {
    laid = undefined;
    if (!snapshot.hasTools) return [view.kit.Text({ color: TONE_KEYS.warn, wrap: "wrap", children: [TASK_TOOLS_OFF] })];
    return [noticeRow(view, { kind: "empty" }, WORDS), view.kit.Text({ color: TONE_KEYS.muted, dimColor: true, wrap: "wrap", children: [EMPTY_HINT] })];
  }
  const shown = tasks.find((task) => task.id === opened);
  if (shown !== undefined) {
    laid = undefined;
    return page(host, view, shown, tasks, snapshot.list);
  }
  opened = undefined;
  return list(host, view, tasks, snapshot.isCleared);
};

async function draw(host: Host, e: Input<"ui.render Pane">): Promise<RenderElement> {
  const { home, platform, glyphTier } = resolvedSession();
  const kit = kitOf(host.ui.resolve(e), e.surface, { tier: glyphTier });
  const width = usableColumns(e.props.bodyColumns);
  const isInline = e.props.placement !== "dock";
  const rows = bodyRows(host, e, isInline);
  const g = glyphs(glyphTier);
  const layout = newLayout(0, e.props.scroll.offset);
  const pressed: View["press"] = (work) => async () => {
    try {
      await work();
    } catch (error) {
      host.log(`omca tasks action failed: ${reason(error)}`);
    }
  };
  const view: View = { kit, g, isAscii: g.tier === "ascii", width, tier: widthTier(e.props.bodyColumns), rows, isInline, home, platform, now: 0, press: pressed, layout, viewing: e.props.view.agentId };
  let body: readonly RenderElement[];
  try {
    body = await content(host, view);
  } catch (error) {
    host.log(`omca tasks failed: ${reason(error)}`);
    body = [kit.Text({ color: TONE_KEYS.fail, children: [`${g.cross} The task list failed: ${reason(error)}`] })];
  }
  if (isRemote(kit)) return remoteTree(host, kit, { width, above: [], body, label: "task list", cross: g.cross, surface: e.surface });
  const drawnRows = body.reduce((sum, child) => sum + rowsAtLeast(child), 0);
  // The engine raises the wheel only over a tree taller than the body, so a page that fits but holds
  // a region with more to show gets rows past the body, and those rows never scroll the pane.
  const isPadded = hasOverflow(layout) && drawnRows <= rows;
  if (isPadded) body = [...body, ...blanks(view, rows + 1 - drawnRows)];
  commitLayout(TASK_PANE, { ...layout, isPadded, treeRows: isPadded ? rows + 1 : drawnRows });
  return kit.Box({ flexDirection: "column", width, ...(isInline ? { minHeight: rows } : {}), children: body });
}

function startReading(host: Host): void {
  timer ??= host.clock.every(READ_EVERY_MS, async () => {
    try {
      await sync(host);
    } catch (error) {
      host.log(`omca tasks refresh failed: ${reason(error)}`);
    }
  });
}

function stopReading(): void {
  timer?.cancel();
  timer = undefined;
}

async function openPane(host: Host, e: Input<"command.run">): Promise<CommandRunResult> {
  await sessionOf(host);
  await sync(host);
  const opened = await host.ui.open({ id: TASK_PANE, title: "Tasks", focus: true, closeOnEscape: true, rows: INLINE_REQUEST_ROWS, columns: dockColumns(e.presentation.columns) });
  startReading(host);
  if (opened.isPlaced) return {};
  if (opened.reason.startsWith("no-surface")) return { text: "No surface is attached to this session, as under claude -p, so the task list is not drawn. Run /tasklist in a terminal or the Desktop app." };
  return { text: `The task list is open but not drawn yet: ${opened.reason}` };
}

export const taskList: Features = {
  "session.start": {
    async post(host) {
      await host.command.register({ name: TASK_COMMAND, description: "See Claude's task list whole: what runs now, what comes next, what waits, what is done", immediate: true });
      await sync(host);
      if ((await host.ui.panes()).some((pane) => pane.id === TASK_PANE)) startReading(host);
      return undefined;
    },
  },
  // A completed list is deleted seconds later, so its last state is read as the call that finished it returns.
  "tool.call": {
    async post(host, e) {
      await sync(host, e.tool === "TaskUpdate" && e.status === "deleted" ? e.taskId : undefined);
      return undefined;
    },
  },
  "turn.complete": {
    async post(host, e) {
      if (e.agentId === undefined) await sync(host);
      return undefined;
    },
  },
  "command.run": {
    async pre(host, e) {
      return { answer: await openPane(host, e) };
    },
  },
  "ui.close": {
    pre(_host, e) {
      if (e.id === TASK_PANE) {
        stopReading();
        reset();
      }
      return undefined;
    },
  },
  "ui.focus": {
    pre(_host, e) {
      if (e.component !== "Pane" || e.requestId !== TASK_PANE) return undefined;
      if (e.element?.startsWith(ROW)) cursor = e.element.slice(ROW.length);
      aimKeys(opened === undefined ? undefined : PAGE);
      return undefined;
    },
  },
  "ui.scroll": {
    async pre(host, e) {
      if (e.requestId !== TASK_PANE) return undefined;
      // A remote surface has already moved its own scroll container and sends no pointer.
      if (!(await host.session.surfaces()).includes("terminal") || e.origin.kind !== "person") return undefined;
      const layout = committedLayout(TASK_PANE);
      if (e.pointer !== undefined) {
        if (await scrollAt(layout, e.pointer, e.by)) {
          host.ui.invalidate();
          return { answer: {} };
        }
        return Math.max(layout.treeRows, e.contentRows) > e.bodyRows + 1 ? undefined : { answer: {} };
      }
      if (scroll(host, e)) return { answer: {} };
      const step = Math.abs(e.by) === e.bodyRows ? "page" : Math.abs(e.by) === e.contentRows ? "end" : "row";
      if (scrollKeyed(TASK_PANE, e.by, step)) {
        host.ui.invalidate();
        return { answer: {} };
      }
      return layout.isPadded ? { answer: {} } : undefined;
    },
  },
  "ui.render Pane": {
    async pre(host, e) {
      if (e.requestId !== TASK_PANE) return undefined;
      return { answer: await draw(host, e) };
    },
  },
};
