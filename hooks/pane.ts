import type { CommandRunResult, RenderElement, Timer } from "claude-code";
import type { Platform } from "../src/core/path.ts";
import { COLUMN_GAP, displayWidth, fitEnd, type Glyphs, glyphs, padEnd, usableColumns } from "../src/core/ui-kit.ts";
import { notice, TONE_KEYS, type ViewState, type WidthTier, widthTier } from "../src/core/visual.ts";
import { reconcile } from "./agents-tracker.ts";
import type { Features, Input } from "./dispatch.ts";
import { type Host, reason, resolvedSession, sessionOf, type State, update } from "./host.ts";
import type { Subcommand } from "./omca-router.ts";
import * as agents from "./tabs/agents.ts";
import * as doctor from "./tabs/doctor.ts";
import * as evidence from "./tabs/evidence.ts";
import * as feedback from "./tabs/feedback.ts";
import * as notepad from "./tabs/notepad.ts";
import * as plan from "./tabs/plan.ts";
import * as stats from "./tabs/stats.ts";
import { type Kit, kitOf, Rule, rowsAtLeast } from "./ui.ts";

export const PANE = "omca";
// The Agents tab's elapsed clocks tick each second; files are read again every second tick.
const TICK_MS = 1000;
const READ_EVERY = 2;
// An inline pane gets about a third of the window less two rows (11 body rows at 40 terminal
// rows, 8 at 30, measured) and follows its content's height below that, so every inline
// drawing is at least that tall: sized from the viewport first, then to what the pane got.
// A drawing that changes height moves the focus ring, which the engine keeps by position.
const INLINE_ROWS = 12;
const MIN_INLINE_ROWS = 7;
// A dock opened at 100 columns in a 120-column terminal left the transcript 24 columns.
const DOCK_SHARE = 0.45;
const DOCK_MIN_COLUMNS = 56;
const DOCK_MAX_COLUMNS = 96;

type Pane = State["pane"];
export type Tab = Pane["tab"];
export type Press = (work: () => unknown) => () => Promise<void>;
export type View = {
  kit: Kit;
  g: Glyphs;
  isAscii: boolean;
  width: number;
  tier: WidthTier;
  rows: number;
  isInline: boolean;
  home: string;
  platform: Platform;
  now: number;
  press: Press;
};
export type TabView = (host: Host, view: View) => Promise<readonly RenderElement[]>;

const TABS: readonly (readonly [Tab, string])[] = [
  ["agents", "Agents"],
  ["plan", "Plan"],
  ["evidence", "Evidence"],
  ["notepad", "Notepad"],
  ["feedback", "Feedback"],
  ["stats", "Stats"],
  ["doctor", "Doctor"],
];

// Resolved at call time: the tab modules import this one, so whichever loads first would
// otherwise read the other's exports before they exist.
function viewOf(tab: Tab): TabView {
  switch (tab) {
    case "agents":
      return agents.view;
    case "plan":
      return plan.view;
    case "evidence":
      return evidence.view;
    case "notepad":
      return notepad.view;
    case "feedback":
      return feedback.view;
    case "stats":
      return stats.view;
    case "doctor":
      return doctor.view;
  }
}

let timer: Timer | undefined;
let isTicking = false;
let ticks = 0;
let now = 0;
let inlineRows = INLINE_ROWS;
let viewportRows = 0;
// The tabs whose trees the engine scrolls with no cue of its own, and the height the engine last
// reported for the tree drawn as `shape`; ui.scroll carries it, the render event does not.
const CUED: readonly Tab[] = ["notepad", "stats"];
let drawnShape = "";
let measured: { shape: string; rows: number } | undefined;

// A tree's content as data: closures and the press handles the runtime stamps change every draw.
const shapeOf = (children: readonly RenderElement[]): string =>
  JSON.stringify(children, (key, value: unknown) => (key === "press" || typeof value === "function" ? undefined : value));

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export function patchPane(host: Host, change: (pane: Pane) => Pane): Promise<void> {
  return update(host.state.pane, (pane) =>
    change(
      pane ?? {
        tab: "agents",
        notepad: null,
        plans: null,
        errors: { notepad: null, plans: null },
        readAt: 0,
      },
    ),
  );
}

async function refresh(host: Host, tab?: Tab): Promise<void> {
  const root = await host.session.root();
  if ((await host.state.pane.get()).value === undefined) notepad.reset();
  const [, pad] = await Promise.all([evidence.sync(host, root), notepad.read(host, root)]);
  await plan.sync(host);
  if (tab === undefined && pad === undefined) return;
  const readAt = await host.clock.now();
  await patchPane(host, (pane) => ({
    ...pane,
    ...(tab === undefined ? {} : { tab }),
    ...(pad === undefined ? {} : { notepad: pad.notepad }),
    errors: {
      ...pane.errors,
      ...(pad === undefined ? {} : { notepad: pad.error }),
    },
    readAt,
  }));
}

async function tick(host: Host): Promise<void> {
  now = await host.clock.now();
  ticks += 1;
  if (ticks % READ_EVERY === 0) {
    await reconcile(host, await host.agent.list(), now);
    await refresh(host);
  }
  const [pane, rows] = await Promise.all([host.state.pane.get(), host.state.agents.get()]);
  const isRunning = Object.values(rows.value ?? {}).some((row) => row.endedAt === null);
  if (pane.value?.tab === "agents" && isRunning) host.ui.invalidate();
}

function start(host: Host): void {
  timer ??= host.clock.every(TICK_MS, async () => {
    if (isTicking) return;
    isTicking = true;
    try {
      await tick(host);
    } catch (error) {
      host.log(`omca pane refresh failed: ${reason(error)}`);
    } finally {
      isTicking = false;
    }
  });
}

function stop(): void {
  timer?.cancel();
  timer = undefined;
  ticks = 0;
}

export async function open(host: Host, e: Input<"command.run">, tab: Tab): Promise<CommandRunResult> {
  await sessionOf(host);
  now = await host.clock.now();
  await refresh(host, tab);
  const columns = clamp(Math.round(e.presentation.columns * DOCK_SHARE), DOCK_MIN_COLUMNS, DOCK_MAX_COLUMNS);
  await host.ui.open({ id: PANE, title: "OMCA", focus: true, closeOnEscape: true, rows: INLINE_ROWS, columns });
  start(host);
  return {};
}

export const command: Subcommand = (host, e) => open(host, e, "agents");

export function noticeRow(
  view: View,
  state: Exclude<ViewState<unknown>, { kind: "populated" }>,
  words: { loading: string; empty: string },
): RenderElement {
  const { text, color, isDim } = notice(state, words, view.g, view.width);
  return view.kit.Text({ color, ...(isDim ? { dimColor: true } : {}), children: [text] });
}

export function keyButton(view: View, hotkey: string, label: string, work: () => unknown, isOff = false): RenderElement {
  return view.kit.Button({
    key: hotkey,
    hotkey,
    label,
    plain: true,
    ...(isOff ? { dimColor: true } : {}),
    onPress: view.press(work),
  });
}

export const rule = (view: View): RenderElement => Rule(view.kit, view.width, view.g, view.isAscii);

/** A dim line of `width` cells, a blank row when the text is empty. */
export const edge = (view: View, text: string, width = view.width): RenderElement =>
  view.kit.Text({ dimColor: true, children: [text === "" ? " " : fitEnd(text, width, view.g.ellipsis)] });

export const blanks = (view: View, count: number): RenderElement[] =>
  Array.from({ length: Math.max(0, count) }, () => view.kit.Text({ children: [" "] }));

/** Items in rows no wider than `width`, `gap` cells between neighbours; an item wider than the width has a row of its own. */
export function wrapAt<T>(items: readonly T[], width: number, gap: number, cellsOf: (item: T) => number): T[][] {
  const rows: T[][] = [];
  let used = 0;
  for (const item of items) {
    const cells = cellsOf(item);
    const row = rows.at(-1);
    if (row !== undefined && used + gap + cells <= width) {
      row.push(item);
      used += gap + cells;
    } else {
      rows.push([item]);
      used = cells;
    }
  }
  return rows;
}

// `$.ui.focus` lands on the next drawing, so the focus is sent after the invalidate it follows.
export function refocus(host: Host, key: string, tab: Tab): void {
  host.clock.after(0, async () => {
    try {
      host.ui.invalidate();
      const { deny } = await host.ui.focus({ requestId: PANE, key });
      if (deny !== undefined) host.log(`omca ${tab} could not focus ${key}: ${deny}`);
    } catch (error) {
      host.log(`omca ${tab} could not focus ${key}: ${reason(error)}`);
    }
  });
}

async function selectTab(host: Host, tab: Tab): Promise<void> {
  if (tab === "stats") await stats.load(host);
  await patchPane(host, (pane) => (pane.tab === tab ? pane : { ...pane, tab }));
}

// The narrower gap is used only when it keeps every tab on one row, which saves an inline row.
function tabRows(width: number): { gap: number; rows: (readonly [Tab, string, string])[][] } {
  const cells = TABS.map(([id, label], index) => [id, label, String(index + 1)] as const);
  const cellWidth = ([, label, key]: readonly [Tab, string, string]) => displayWidth(`${key}: ${label}`);
  const oneRow = (gap: number) => cells.reduce((sum, cell) => sum + cellWidth(cell), 0) + gap * (cells.length - 1);
  const gap = oneRow(COLUMN_GAP) <= width || oneRow(1) > width ? COLUMN_GAP : 1;
  return { gap, rows: wrapAt(cells, width, gap, cellWidth) };
}

function bodyRows(host: Host, e: Input<"ui.render Pane">, isInline: boolean): number {
  const shown = e.props.scroll.bodyRows;
  const rows = e.viewport?.rows ?? 0;
  if (rows !== viewportRows) {
    viewportRows = rows;
    inlineRows = rows > 0 ? clamp(Math.floor(rows / 3) - 2, MIN_INLINE_ROWS, INLINE_ROWS) : INLINE_ROWS;
  } else if (isInline && shown > 0 && shown < inlineRows) {
    inlineRows = shown;
    host.ui.invalidate();
  }
  return isInline ? inlineRows : shown;
}

async function draw(host: Host, e: Input<"ui.render Pane">): Promise<RenderElement> {
  const kit = kitOf(host.ui.resolve(e), e.surface);
  const { Box, Text, Button } = kit;
  const width = usableColumns(e.props.bodyColumns);
  const isInline = e.props.placement !== "dock";
  const rows = bodyRows(host, e, isInline);
  const { home, platform, glyphTier } = resolvedSession();
  const pane = await host.state.pane.get();
  const g = glyphs(glyphTier);
  const isAscii = g.tier === "ascii";
  const active = pane.value?.tab ?? "agents";
  const press: Press = (work) => async () => {
    try {
      await work();
    } catch (error) {
      host.log(`omca pane action failed: ${reason(error)}`);
    }
  };
  const bar = tabRows(width);
  const tabs = bar.rows.map((row, index) =>
    Box({
      key: `tabs-${index}`,
      flexDirection: "row",
      columnGap: bar.gap,
      children: row.map(([id, label, key]) =>
        Button({
          key,
          hotkey: key,
          label,
          plain: true,
          ...(id === active ? {} : { dimColor: true }),
          onPress: press(() => selectTab(host, id)),
        }),
      ),
    }),
  );
  const chrome = tabs.length + (isInline ? 0 : 1);
  const tier = widthTier(e.props.bodyColumns);
  const view: View = { kit, g, isAscii, width, tier, rows: Math.max(0, rows - chrome), isInline, home, platform, now, press };
  let body: readonly RenderElement[];
  try {
    body = await viewOf(active)(host, view);
  } catch (error) {
    host.log(`omca ${active} tab failed: ${reason(error)}`);
    body = [Text({ color: TONE_KEYS.fail, children: [`${g.cross} The ${active} tab failed: ${reason(error)}`] })];
  }
  const children = [...tabs, ...(isInline ? [] : [rule(view)]), ...body];
  drawnShape = CUED.includes(active) ? shapeOf(children) : "";
  const cue = drawnShape === "" ? undefined : moreCue(view, e.props.scroll, isInline ? rows : 0, children);
  return Box({ flexDirection: "column", width, ...(isInline ? { minHeight: rows } : {}), children: cue === undefined ? children : [...children, cue] });
}

// Drawn over the window's last row while the tree runs past it: the engine's exact height once a
// scroll has reported it for this very tree, else the fewest rows the tree can take.
function moreCue(
  view: View,
  { offset, bodyRows }: Input<"ui.render Pane">["props"]["scroll"],
  minHeight: number,
  children: readonly RenderElement[],
): RenderElement | undefined {
  const rows =
    measured?.shape === drawnShape
      ? measured.rows
      : Math.max(minHeight, children.reduce((sum, child) => sum + rowsAtLeast(child), 0));
  if (bodyRows <= 0 || offset + bodyRows >= rows) return undefined;
  const { g, width, kit } = view;
  const text = fitEnd(`  ${g.down} more ${g.dot} ${g.up}${g.down} scroll`, width, g.ellipsis);
  return kit.Box({
    key: "more-cue",
    position: "absolute",
    top: offset + bodyRows - 1,
    left: 0,
    width,
    children: [kit.Text({ dimColor: true, children: [padEnd(text, width)] })],
  });
}

export const pane: Features = {
  "session.start": {
    async post(host) {
      await host.command.register({
        name: "omca",
        description: "Open the OMCA pane: agents, plan, evidence, notepad, feedback, stats and doctor",
        argumentHint: "[plan [name|path]|stats|doctor]",
        immediate: true,
      });
      await sessionOf(host);
      if ((await host.ui.panes()).some((open) => open.id === PANE)) start(host);
      return undefined;
    },
  },
  "turn.complete": {
    async post(host) {
      if (timer !== undefined) await refresh(host);
      return undefined;
    },
  },
  "ui.close": {
    pre(_host, e) {
      if (e.id === PANE) stop();
      return undefined;
    },
  },
  "ui.focus": {
    async pre(host, e) {
      if (e.component !== "Pane" || e.requestId !== PANE) return undefined;
      return (await host.state.pane.get()).value?.tab === "plan" ? plan.focus(host, e) : undefined;
    },
  },
  "ui.scroll": {
    async pre(host, e) {
      if (e.requestId === PANE && drawnShape !== "") measured = { shape: drawnShape, rows: e.contentRows };
      if (e.requestId !== PANE || e.origin.kind !== "person") return undefined;
      const tab = (await host.state.pane.get()).value?.tab;
      if (tab === "plan") return (await plan.scroll(host, e)) ? { answer: {} } : undefined;
      if (tab === "evidence") return evidence.scroll(host, e) ? { answer: {} } : undefined;
      if (tab !== "doctor" || !doctor.scroll(e.by, e.contentRows)) return undefined;
      host.ui.invalidate();
      return { answer: {} };
    },
  },
  "ui.render Pane": {
    async pre(host, e) {
      if (e.requestId !== PANE) return undefined;
      return { answer: await draw(host, e) };
    },
  },
};
