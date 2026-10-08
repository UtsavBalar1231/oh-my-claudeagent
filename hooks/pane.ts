import type { CommandRunResult, RenderElement, Timer } from "claude-code";
import type { Platform } from "../src/core/path.ts";
import { COLUMN_GAP, displayWidth, fitEnd, type Glyphs, glyphs, padEnd, usableColumns } from "../src/core/ui-kit.ts";
import { notice, TONE_KEYS, type ViewState, type WidthTier, widthTier } from "../src/core/visual.ts";
import { reconcile } from "./agents-tracker.ts";
import type { Features, Input } from "./dispatch.ts";
import { type Host, reason, resolvedSession, sessionOf, type State, update } from "./host.ts";
import * as mascots from "./mascot-player.ts";
import { hasOverflow, resetRegions, scrollKeyed, scrollRegionAt } from "./regions.ts";
import type { Subcommand } from "./omca-router.ts";
import * as agents from "./tabs/agents.ts";
import * as doctor from "./tabs/doctor.ts";
import * as evidence from "./tabs/evidence.ts";
import * as notepad from "./tabs/notepad.ts";
import * as plan from "./tabs/plan.ts";
import * as stats from "./tabs/stats.ts";
import { type Kit, kitOf, Rule, rowsAtLeast } from "./ui.ts";

export const PANE = "omca";
// The Agents tab's elapsed clocks tick each second, only while a terminal draws them: on Desktop every
// state write already redraws every site. Files are read again every second tick.
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
const DOCK_WIDE_MAX_COLUMNS = 120;
const DOCK_TRANSCRIPT_COLUMNS = 100;
// Below this many body rows a dock gives the rule under the tab bar to the tab.
const RULE_MIN_ROWS = 30;

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
// The latest drawing's tab rows above the tab, the engine's own offset, and whether the tree runs
// past the body only for a region's sake.
let chromeRows = 0;
let shownOffset = 0;
let isPadded = false;

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
        auto: "pending",
        readAt: 0,
      },
    ),
  );
}

async function refresh(host: Host, tab?: Tab, within?: object): Promise<void> {
  const root = await host.session.root();
  if ((await host.state.pane.get()).value === undefined) notepad.reset();
  const [, pad] = await Promise.all([evidence.sync(host, root), notepad.read(host, root)]);
  await plan.sync(host, within);
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
    await mascots.ensure(host);
  }
  const [pane, rows] = await Promise.all([host.state.pane.get(), host.state.agents.get()]);
  const isRunning = Object.values(rows.value ?? {}).some((row) => row.status === "running");
  if (pane.value?.tab !== "agents" || !isRunning) return;
  if ((await host.session.surfaces()).includes("terminal")) host.ui.invalidate();
}

async function start(host: Host): Promise<void> {
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
  await mascots.ensure(host);
}

function stop(): void {
  timer?.cancel();
  timer = undefined;
  ticks = 0;
  mascots.stop();
}

export async function open(host: Host, e: Input<"command.run">, tab: Tab): Promise<CommandRunResult> {
  await sessionOf(host);
  now = await host.clock.now();
  await refresh(host, tab);
  const terminal = e.presentation.columns;
  const columns = Math.max(
    clamp(Math.round(terminal * DOCK_SHARE), DOCK_MIN_COLUMNS, DOCK_MAX_COLUMNS),
    Math.min(DOCK_WIDE_MAX_COLUMNS, terminal - DOCK_TRANSCRIPT_COLUMNS),
  );
  // The first drawing must already know whether the person prefers reduced motion.
  await mascots.ensure(host);
  const opened = await host.ui.open({ id: PANE, title: "OMCA", focus: true, closeOnEscape: true, rows: INLINE_ROWS, columns });
  await patchPane(host, (pane) => ((pane.auto ?? "pending") === "pending" ? { ...pane, auto: "opened" } : pane));
  await start(host);
  return opened.isPlaced ? {} : { text: `The OMCA pane is open but not drawn yet: ${opened.reason}` };
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

type TabCell = readonly [Tab, string, string];

// One row: the full labels when they fit, else only the active tab keeps its label and the rest shrink to their initial, which no two tabs share.
function tabBar(width: number, active: Tab): { gap: number; cells: TabCell[] } {
  const full = TABS.map(([id, label], index): TabCell => [id, label, String(index + 1)]);
  const across = (cells: readonly TabCell[], gap: number) =>
    cells.reduce((sum, [, label, key]) => sum + displayWidth(`${key}: ${label}`), 0) + gap * (cells.length - 1);
  const gap = [COLUMN_GAP, 1].find((candidate) => across(full, candidate) <= width);
  if (gap !== undefined) return { gap, cells: full };
  const cells = full.map(([id, label, key]): TabCell => [id, id === active ? label : label.charAt(0), key]);
  return { gap: across(cells, COLUMN_GAP) <= width ? COLUMN_GAP : 1, cells };
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
  const { home, platform, glyphTier } = resolvedSession();
  const kit = kitOf(host.ui.resolve(e), e.surface, glyphTier, mascots.still());
  const { Box, Text, Button } = kit;
  const width = usableColumns(e.props.bodyColumns);
  const isInline = e.props.placement !== "dock";
  const rows = bodyRows(host, e, isInline);
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
  const bar = tabBar(width, active);
  const tabs = [
    Box({
      key: "tabs-0",
      flexDirection: "row",
      columnGap: bar.gap,
      children: bar.cells.map(([id, label, key]) =>
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
  ];
  const hasRule = !isInline && rows >= RULE_MIN_ROWS;
  const chrome = tabs.length + (hasRule ? 1 : 0);
  const tier = widthTier(e.props.bodyColumns);
  const view: View = { kit, g, isAscii, width, tier, rows: Math.max(0, rows - chrome), isInline, home, platform, now, press };
  chromeRows = chrome;
  shownOffset = e.props.scroll.offset;
  resetRegions();
  let body: readonly RenderElement[];
  try {
    body = await viewOf(active)(host, view);
  } catch (error) {
    host.log(`omca ${active} tab failed: ${reason(error)}`);
    body = [Text({ color: TONE_KEYS.fail, children: [`${g.cross} The ${active} tab failed: ${reason(error)}`] })];
  }
  const drawnRows = [...tabs, ...body].reduce((sum, child) => sum + rowsAtLeast(child), hasRule ? 1 : 0);
  // The engine raises the wheel only over a tree taller than the body, so a tab that fits but holds
  // a region with more to show gets rows past the body, and those rows never scroll the pane.
  isPadded = hasOverflow() && drawnRows <= rows;
  if (isPadded) body = [...body, ...blanks(view, rows + 1 - drawnRows)];
  const children = [...tabs, ...(hasRule ? [rule(view)] : []), ...body];
  drawnShape = CUED.includes(active) && !isPadded ? shapeOf(children) : "";
  const cues =
    drawnShape === ""
      ? []
      : [lessCue(view, e.props.scroll.offset), moreCue(view, e.props.scroll, isInline ? rows : 0, children)].filter((cue) => cue !== undefined);
  return Box({ flexDirection: "column", width, ...(isInline ? { minHeight: rows } : {}), children: [...children, ...cues] });
}

// Drawn over the window's first row once the engine has scrolled past the tree's top.
function lessCue({ g, width, kit }: View, offset: number): RenderElement | undefined {
  if (offset <= 0) return undefined;
  const text = fitEnd(`  ${g.up} more`, width, g.ellipsis);
  return kit.Box({
    key: "less-cue",
    position: "absolute",
    top: offset,
    left: 0,
    width,
    children: [kit.Text({ dimColor: true, children: [padEnd(text, width)] })],
  });
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
        description: "Open the OMCA pane: agents, plan, evidence, notepad, stats and doctor",
        argumentHint: "[plan [name|path]|stats|doctor]",
        immediate: true,
      });
      await sessionOf(host);
      if ((await host.ui.panes()).some((open) => open.id === PANE)) await start(host);
      return undefined;
    },
  },
  "agent.spawn": {
    async post(host, e, result) {
      if (e.isTeammate === true || result.deny !== undefined) return undefined;
      if (((await host.state.pane.get()).value?.auto ?? "pending") !== "pending") return undefined;
      if (!(await host.session.surfaces()).includes("terminal")) return undefined;
      await mascots.ensure(host);
      await host.ui.open({ id: PANE, title: "OMCA", rows: INLINE_ROWS });
      await patchPane(host, (pane) => ({ ...pane, auto: "opened" }));
      await start(host);
      return undefined;
    },
  },
  "turn.complete": {
    async post(host, e) {
      if (timer === undefined) return undefined;
      await refresh(host, undefined, e);
      if ((await host.state.pane.get()).value?.tab === "stats") await stats.load(host);
      return undefined;
    },
  },
  "ui.close": {
    async pre(host, e) {
      if (e.id !== PANE) return undefined;
      stop();
      if (e.origin.kind === "person") await patchPane(host, (pane) => (pane.auto === "declined" ? pane : { ...pane, auto: "declined" }));
      return undefined;
    },
  },
  "ui.focus": {
    async pre(host, e) {
      if (e.component !== "Pane" || e.requestId !== PANE) return undefined;
      const tab = (await host.state.pane.get()).value?.tab;
      if (tab === "agents") agents.focus(e);
      if (tab === "notepad") notepad.focus(e);
      return tab === "plan" ? plan.focus(host, e) : undefined;
    },
  },
  "ui.scroll": {
    async pre(host, e) {
      if (e.requestId === PANE && drawnShape !== "") measured = { shape: drawnShape, rows: e.contentRows };
      if (e.requestId !== PANE || e.origin.kind !== "person") return undefined;
      // The pointer's row counts from the body's top as shown: past the engine's own scroll, less the tab rows above the tab.
      if (e.pointer !== undefined && scrollRegionAt({ column: e.pointer.column, row: e.pointer.row + shownOffset - chromeRows }, e.by)) {
        host.ui.invalidate();
        return { answer: {} };
      }
      const tab = (await host.state.pane.get()).value?.tab;
      if (tab === "agents" && agents.scroll(host, e)) return { answer: {} };
      if (tab === "plan") return (await plan.scroll(host, e)) ? { answer: {} } : undefined;
      if (tab === "evidence") return evidence.scroll(host, e) ? { answer: {} } : undefined;
      // A key no tab took moves a region: a page key asks for `bodyRows`, Home and End for `contentRows`.
      const step = Math.abs(e.by) === e.bodyRows ? "page" : Math.abs(e.by) === e.contentRows ? "end" : "row";
      if (e.pointer === undefined && scrollKeyed(e.by, step)) {
        host.ui.invalidate();
        return { answer: {} };
      }
      if (tab !== "doctor" || !doctor.scroll(e.by, e.contentRows)) return isPadded ? { answer: {} } : undefined;
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
