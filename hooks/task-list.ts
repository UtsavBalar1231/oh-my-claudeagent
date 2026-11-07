import type { CommandRunResult, RenderElement, Timer } from "claude-code";
import { windowEnd } from "../src/core/list-window.ts";
import { markdownPieces } from "../src/core/markdown.ts";
import { groupTasks, type NativeTask, openBlockers, parseTask, runState, TASK_TOOLS_OFF, type TaskGroup, taskListDir, withHistory } from "../src/core/native-tasks.ts";
import { COLUMN_GAP, displayWidth, fitEnd, glyphs, oneLine, usableColumns } from "../src/core/ui-kit.ts";
import { bar, fitPieces, ON_SURFACE, type Piece, redact, type ThemeKey, TONE_KEYS, widthTier, wrapPieces } from "../src/core/visual.ts";
import type { Features, Input } from "./dispatch.ts";
import { type Host, reason, resolvedSession, sessionOf, update } from "./host.ts";
import { blanks, bodyRows, dockColumns, INLINE_REQUEST_ROWS, keyButton, noticeRow, remoteTree, type View } from "./pane.ts";
import { aimKeys, commitLayout, committedLayout, hasOverflow, markdownUnits, newLayout, resetOffset, scrollAt, scrollKeyed, ScrollRegion, type Unit } from "./regions.ts";
import { hasTaskTools } from "./task-tools.ts";
import { isRemote, kitOf, Line, rowsAtLeast, type TextStyle } from "./ui.ts";

const TASK_PANE = "tasklist";
export const TASK_COMMAND = "tasklist";
const READ_EVERY_MS = 2000;
const ROW = "task-";
const PAGE = "tasklist-page";
const BACK = "b";
const WORDS = { loading: "Reading the task list", empty: "No tasks yet." };
const EMPTY_HINT = "Claude adds tasks here when it plans multi-step work.";
const CLEARED = "Finished. Claude Code cleared its list; the record stays here.";
const BAR_CELLS = 16;
const MIN_BAR_ROOM = 44;
const STATUS_WORD: Readonly<Record<TaskGroup["name"], string>> = { Now: "Running", Next: "Ready", Waiting: "Waiting", Done: "Done" };

type Item = { kind: "label"; text: string; rows: number } | { kind: "blank"; rows: number } | { kind: "task"; task: NativeTask; group: TaskGroup["name"]; rows: number };

let opened: string | undefined;
let cursor: string | undefined;
let first = 0;
let timer: Timer | undefined;
let laid: { ids: readonly string[]; itemOf: (id: string) => number; stopFrom: (from: number) => number; last: number } | undefined;

const reset = (): void => {
  opened = undefined;
  cursor = undefined;
  first = 0;
  laid = undefined;
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
  let read: NativeTask[] = [];
  let error: string | null = null;
  if (config === undefined) {
    error = "None of HOME, USERPROFILE or CLAUDE_CONFIG_DIR is set";
  } else {
    try {
      read = await readList(host, taskListDir(platform, config, named === undefined || named === "" ? sessionId : named));
    } catch (failure) {
      error = reason(failure);
    }
  }
  const hasTools = read.length > 0 || (await hasTaskTools(host));
  await update(host.state.tasks, (previous) => {
    const tasks = withHistory(previous?.tasks ?? [], read, forgotten);
    const next = { tasks, hasTools, isCleared: read.length === 0 && tasks.length > 0, error };
    return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
  });
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const shownText = (view: View, text: string) => redact(text, view.home, view.g.mask).text;
const firstLine = (text: string) => text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
const summaryOf = (view: View, task: NativeTask) => shownText(view, firstLine(task.description) || task.activeForm);

function markOf(view: View, group: TaskGroup["name"]): { text: string; color: ThemeKey } {
  const { g } = view;
  if (group === "Now") return { text: g.progress, color: TONE_KEYS.active };
  if (group === "Waiting") return { text: g.blocked, color: TONE_KEYS.warn };
  if (group === "Done") return { text: g.check, color: TONE_KEYS.ok };
  return { text: g.pending, color: TONE_KEYS.muted };
}

const numbers = (ids: readonly string[]) => ids.map((id) => `#${id}`).join(", ");

// A final task usually waits on the rest of its run, so its mark leads and survives the cut.
function asideOf(view: View, task: NativeTask, tasks: readonly NativeTask[]): string {
  if (task.blockedReason !== "") return oneLine(task.blockedReason);
  const blockers = openBlockers(task, tasks);
  const rest = blockers.length > 0 ? `waits on ${numbers(blockers)}` : task.owner;
  return [...(task.isFinal ? ["final"] : []), ...(rest === "" ? [] : [rest])].join(` ${view.g.dot} `);
}

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

function press(host: Host, view: View, id: string): void {
  opened = id;
  cursor = id;
  resetOffset(PAGE);
  aimKeys(PAGE);
  host.ui.invalidate();
  if (isRemote(view.kit)) refocus(host, BACK);
}

function close(host: Host, id: string): void {
  opened = undefined;
  aimKeys(undefined);
  host.ui.invalidate();
  refocus(host, `${ROW}${id}`);
}

function taskRow(host: Host, view: View, item: Extract<Item, { kind: "task" }>, tasks: readonly NativeTask[], isCurrent: boolean): RenderElement[] {
  const { kit, g, width } = view;
  const { task, group, rows } = item;
  const isDone = group === "Done";
  const mark = markOf(view, group);
  const number = `#${task.id} `;
  const lead = `${mark.text} `;
  const aside = shownText(view, asideOf(view, task, tasks));
  const fixed = displayWidth(lead) + displayWidth(number);
  const asideCells = aside === "" ? 0 : Math.min(displayWidth(aside), Math.floor(width / 3));
  const room = Math.max(1, width - fixed - (asideCells === 0 ? 0 : asideCells + COLUMN_GAP));
  const subject = fitEnd(shownText(view, task.subject), room, g.ellipsis);
  const look = (style: TextStyle): TextStyle => (isCurrent ? { ...style, color: ON_SURFACE, bold: true } : { ...style, hover: { color: ON_SURFACE } });
  const tail = fitEnd(aside, asideCells, g.ellipsis);
  const pad = " ".repeat(Math.max(0, width - fixed - displayWidth(subject) - displayWidth(tail)));
  const after = isRemote(kit)
    ? [kit.Box({ flexGrow: 1 }), kit.Text({ color: TONE_KEYS.muted, children: [tail] })]
    : [kit.Text({ ...look({ color: group === "Waiting" ? TONE_KEYS.warn : TONE_KEYS.muted }), wrap: "truncate-end", children: [`${pad}${tail}`] })];
  const line = kit.Box({
    key: `line-${ROW}${task.id}`,
    flexDirection: "row",
    width,
    hover: { backgroundColor: TONE_KEYS.focus },
    ...(isCurrent ? { backgroundColor: TONE_KEYS.focus } : {}),
    children: [
      kit.Text({ color: mark.color, children: [lead] }),
      kit.Text({ ...look({ color: TONE_KEYS.muted }), children: [number] }),
      kit.Button({
        key: `${ROW}${task.id}`,
        label: subject,
        plain: true,
        hover: { color: ON_SURFACE },
        ...(isDone ? { dimColor: true } : {}),
        ...(isCurrent ? { autoFocus: true } : {}),
        onPress: view.press(() => press(host, view, task.id)),
      }),
      ...(tail === "" ? [] : after),
    ],
  });
  if (rows === 1) return [line];
  const summary = fitPieces(markdownPieces(summaryOf(view, task), { color: TONE_KEYS.muted }), Math.max(1, width - fixed), g.ellipsis);
  return [line, Line(kit, [{ text: " ".repeat(fixed) }, ...summary])];
}

function itemsOf(view: View, groups: readonly TaskGroup[], isRelaxed: boolean): Item[] {
  return groups.flatMap((group, index): Item[] => [
    ...(isRelaxed && index > 0 ? [{ kind: "blank" as const, rows: 1 }] : []),
    { kind: "label" as const, text: group.name, rows: 1 },
    ...group.tasks.map((task) => ({
      kind: "task" as const,
      task,
      group: group.name,
      rows: isRelaxed && group.name !== "Done" && summaryOf(view, task) !== "" ? 2 : 1,
    })),
  ]);
}

const sum = (heights: readonly number[]) => heights.reduce((total, rows) => total + rows, 0);

function headRow(view: View, tasks: readonly NativeTask[]): RenderElement {
  const done = tasks.filter((task) => task.status === "completed").length;
  const active = tasks.filter((task) => task.status === "in_progress" && task.blockedReason === "").length;
  const words = `${done} of ${tasks.length} done${active > 0 ? ` ${view.g.dot} ${active} running` : ""}`;
  const meter = view.width >= MIN_BAR_ROOM ? [...bar({ done, active, todo: tasks.length - done - active }, BAR_CELLS, view.isAscii), { text: " " }] : [];
  const run = runState(tasks)?.name;
  const named: Piece[] = run === undefined ? [] : [{ text: ` ${view.g.dot} `, color: TONE_KEYS.muted }, { text: oneLine(shownText(view, run)), bold: true }];
  return Line(view.kit, fitPieces([...meter, { text: words, color: TONE_KEYS.muted }, ...named], view.width, view.g.ellipsis));
}

function list(host: Host, view: View, tasks: readonly NativeTask[], isCleared: boolean): RenderElement[] {
  const { kit, g, width } = view;
  const groups = groupTasks(tasks);
  const isRemoteDrawing = isRemote(kit);
  const note = isCleared ? [kit.Text({ dimColor: true, children: [fitEnd(CLEARED, width, g.ellipsis)] })] : [];
  const top = 1 + note.length;
  const available = isRemoteDrawing ? Number.POSITIVE_INFINITY : Math.max(1, view.rows - top);
  // Relaxed rows when every task's summary and the blanks between the groups fit; plain rows otherwise.
  const roomy = itemsOf(view, groups, true);
  const items = sum(roomy.map((item) => item.rows)) <= available ? roomy : itemsOf(view, groups, false);
  const heights = items.map((item) => item.rows);
  const fits = sum(heights) <= available;
  // The window from an item: a row for the cue below always, one for the cue above past the first item,
  // and never a heading left as its last row with its tasks out of view.
  const stopFrom = (from: number): number => {
    let stop = windowEnd(heights, from, Math.max(1, available - 1 - (from > 0 ? 1 : 0)));
    while (stop > from + 1 && items[stop - 1]?.kind !== "task") stop -= 1;
    while (stop < items.length && items[stop - 1]?.kind !== "task") stop += 1;
    return stop;
  };
  const restFits = (from: number) => sum(heights.slice(from)) <= available - (from > 0 ? 1 : 0);
  const fitting = items.findIndex((_, from) => restFits(from));
  const last = fits ? 0 : fitting < 0 ? items.length - 1 : fitting;
  first = clamp(first, 0, last);
  const stop = fits || restFits(first) ? items.length : stopFrom(first);
  const tasksOnly = items.flatMap((item, index) => (item.kind === "task" ? [{ id: item.task.id, index }] : []));
  const current = tasksOnly.some(({ id }) => id === cursor) ? cursor : tasksOnly[0]?.id;
  laid = fits || isRemoteDrawing ? undefined : { ids: tasksOnly.map(({ id }) => id), itemOf: (id) => tasksOnly.find((one) => one.id === id)?.index ?? 0, stopFrom, last };
  const cue = (text: string) => kit.Text({ dimColor: true, children: [fitEnd(text, width, g.ellipsis)] });
  const rows = items.slice(first, stop).flatMap((item) => {
    if (item.kind === "blank") return [kit.Text({ children: [" "] })];
    if (item.kind === "label") return [kit.Text({ bold: true, children: [item.text] })];
    return taskRow(host, view, item, tasks, item.task.id === current);
  });
  const hidden = (part: readonly Item[]) => part.filter((item) => item.kind === "task").length;
  const above = first > 0 ? [cue(`${g.up} ${hidden(items.slice(0, first))} more`)] : [];
  const below = stop < items.length ? [cue(`${g.down} ${hidden(items.slice(stop))} more`)] : [];
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
  const end = top + shownRows;
  return [headRow(view, tasks), ...note, ...above, ...rows, ...below, ...(fits ? [] : blanks(view, view.rows + 1 - end))];
}

function relationUnits(view: View, name: string, ids: readonly string[], tasks: readonly NativeTask[]): Unit[] {
  return ids.map((id, index) => {
    const other = tasks.find((task) => task.id === id);
    const label = index === 0 ? name : "";
    const pieces: Piece[] = [{ text: `${label.padEnd(name.length)}  `, color: TONE_KEYS.muted }, { text: `#${id}` }, ...(other === undefined ? [] : [{ text: ` ${shownText(view, other.subject)}` }])];
    return { element: Line(view.kit, fitPieces(pieces, view.width, view.g.ellipsis)), rows: 1 };
  });
}

function page(host: Host, view: View, task: NativeTask, tasks: readonly NativeTask[]): RenderElement[] {
  const { kit, g, width } = view;
  const group = groupTasks(tasks).find((one) => one.tasks.includes(task))?.name ?? "Next";
  const mark = markOf(view, group);
  const title = wrapPieces([{ text: `${mark.text} `, color: mark.color }, { text: `#${task.id} `, color: TONE_KEYS.muted }, { text: shownText(view, task.subject), bold: true }], width);
  const status = [STATUS_WORD[group], ...(task.owner === "" ? [] : [shownText(view, task.owner)]), ...(group === "Now" && task.activeForm !== "" ? [shownText(view, task.activeForm)] : [])].join(` ${g.dot} `);
  const head = [...title.map((row) => Line(kit, row)), kit.Text({ color: TONE_KEYS.muted, children: [fitEnd(status, width, g.ellipsis)] })];
  const blank = (): Unit => ({ element: kit.Text({ children: [" "] }), rows: 1 });
  const relations = [...relationUnits(view, "Waits on", task.blockedBy, tasks), ...relationUnits(view, "Holds up", task.blocks, tasks)];
  const why = wrapPieces([{ text: "Blocked  ", color: TONE_KEYS.warn }, { text: shownText(view, oneLine(task.blockedReason)) }], width).map((row): Unit => ({ element: Line(kit, row), rows: 1 }));
  const details = task.details.map(({ name, text }) => ({
    element: Line(kit, fitPieces([{ text: `${name}  `, color: TONE_KEYS.muted }, { text: shownText(view, text) }], width, g.ellipsis)),
    rows: 1,
  }));
  const units: Unit[] = [
    ...(task.blockedReason === "" ? [] : [...why, blank()]),
    ...markdownUnits(kit, shownText(view, task.description), width, PAGE),
    ...(relations.length > 0 ? [blank(), ...relations] : []),
    ...(details.length > 0 ? [blank(), ...details] : []),
  ];
  const keys = keyButton(view, BACK, "Back", () => close(host, task.id));
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
    return page(host, view, shown, tasks);
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
