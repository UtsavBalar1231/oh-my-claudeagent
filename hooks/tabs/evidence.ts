import type { RenderElement, RenderSurface } from "claude-code";
import { resolveBoundPlan } from "../../src/core/boulder.ts";
import {
  clockOf,
  dayLabel,
  dayOf,
  type EvidenceType,
  type Filter,
  parseLedger,
  placeEntries,
  recentLevels,
  rerunPrompt,
  sha256Hex,
  shownIndices,
  tallies,
  TYPE_LABELS,
  verdictOf,
} from "../../src/core/evidence.ts";
import { BOULDER, LEDGER } from "../../src/core/omca-paths.ts";
import { displayWidth, fitEnd, fitMiddle, padEnd, shortType, wrapText } from "../../src/core/ui-kit.ts";
import { agentKey, chip, type ChipTone, dots, type Piece, redact, rule, TONE_KEYS } from "../../src/core/visual.ts";
import type { Input } from "../dispatch.ts";
import { type Host, reason, type State } from "../host.ts";
import { noticeRow, PANE, type TabView, type View } from "../pane.ts";
import { Card, CodeBlock, Field, Line, Row } from "../ui.ts";

type Ledger = State["ledger"];
type Entry = Ledger["entries"][number];
type Bound = { name: string; path: string } | { name: string; error: string } | null;
type Block = { element: RenderElement; height: number };

const TYPE_TONES: Readonly<Record<EvidenceType, ChipTone>> = {
  test: "info",
  build: "active",
  lint: "warn",
  manual: "muted",
  final_verification: "plan",
};
const TYPE_KEYS: readonly (readonly [hotkey: string, type: EvidenceType, label: string])[] = [
  ["b", "build", "Build"],
  ["e", "test", "Test"],
  ["l", "lint", "Lint"],
  ["m", "manual", "Manual"],
  ["v", "final_verification", "Final"],
];
const RECENT = 30;
const TYPE_CELLS = 6;
const AGENT_CELLS = 12;
const KEY_GAP = 2;
const SEARCH = "search";
// Pointer, `09:30 `, the type chip and a space, the exit chip and a space.
const FIXED_CELLS = 2 + 6 + (TYPE_CELLS + 2) + 1 + 5 + 1;
const MIN_ROOM = 3;
const MIN_COMMAND = 28;
const COMMAND_ROWS = 3;
const DOCK_SNIPPET_ROWS = 8;
const INLINE_SNIPPET_ROWS = 2;
const MASTER_SHARE = 0.53;
const DETAIL_INDENT = 4;

let seen: string | undefined;
let boulder: { stamp: string; bound: Bound } | undefined;
let filter: Filter = { type: null, isFailuresOnly: false, query: "" };
let isSearching = false;
let focused: number | undefined;
let first = 0;
let note = "";
let laid: { shown: readonly number[]; perPage: number } | undefined;

async function stamp(host: Host, path: string): Promise<string> {
  if (!(await host.fs.exists(path))) return "missing";
  const { mtimeMs, size } = await host.fs.stat(path);
  return `${mtimeMs}:${size}`;
}

async function boundPlan(host: Host, root: string): Promise<{ stamp: string; bound: Bound }> {
  const path = `${root}/${BOULDER}`;
  try {
    const at = await stamp(host, path);
    if (boulder?.stamp === at) return boulder;
    const plan = at === "missing" ? {} : resolveBoundPlan(JSON.parse(await host.fs.read(path)), await host.session.id(), true);
    boulder = { stamp: at, bound: "plan_name" in plan && plan.active_plan !== "" ? { name: plan.plan_name, path: plan.active_plan } : null };
    return boulder;
  } catch (error) {
    boulder = undefined;
    return { stamp: "failed", bound: { name: "", error: `Could not read ${BOULDER}: ${reason(error)}` } };
  }
}

async function planOf(host: Host, bound: Bound): Promise<Ledger["plan"]> {
  if (bound === null || "error" in bound) return bound;
  try {
    return { name: bound.name, sha: await sha256Hex(await host.fs.read(bound.path)) };
  } catch (error) {
    return { name: bound.name, error: `Could not read the plan file: ${reason(error)}` };
  }
}

async function entriesOf(host: Host, path: string, at: string): Promise<Pick<Ledger, "entries" | "error">> {
  if (at === "missing") return { entries: [], error: null };
  try {
    return { entries: parseLedger(await host.fs.read(path)), error: null };
  } catch (error) {
    return { entries: [], error: `Could not read ${LEDGER}: ${reason(error)}` };
  }
}

/** Reads the ledger and the bound plan's bytes into the ledger atom when either changed since the last read. */
export async function sync(host: Host, root: string): Promise<void> {
  if ((await host.state.ledger.get()).value === undefined) seen = undefined;
  const path = `${root}/${LEDGER}`;
  const { stamp: boulderAt, bound } = await boundPlan(host, root);
  const planPath = bound !== null && "path" in bound ? bound.path : "";
  const [ledgerAt, planAt] = await Promise.all([
    stamp(host, path).catch((error: unknown) => `failed:${reason(error)}`),
    planPath === "" ? "" : stamp(host, planPath).catch(() => "failed"),
  ]);
  const key = JSON.stringify([ledgerAt, boulderAt, planPath, planAt]);
  if (key === seen) return;
  const [ledger, plan, readAt] = await Promise.all([entriesOf(host, path, ledgerAt), planOf(host, bound), host.clock.now()]);
  await host.state.ledger.set({ ...ledger, plan, readAt });
  seen = key;
}

function resetWindow(host: Host): void {
  first = 0;
  note = "";
  host.ui.invalidate();
}

// The engine raises ui.scroll for this tab because its drawing is one row taller than the body:
// an arrow moves the focus one entry, a page key a window's worth, Home and End to the ends.
export function scroll(host: Host, e: Input<"ui.scroll">): boolean {
  if (laid === undefined || laid.shown.length === 0) return false;
  const { shown, perPage } = laid;
  const at = Math.max(0, shown.indexOf(focused ?? -1));
  const isPage = Math.abs(e.by) === e.bodyRows;
  const isEnd = !isPage && Math.abs(e.by) >= e.contentRows;
  const by = isEnd ? Math.sign(e.by) * shown.length : isPage ? Math.sign(e.by) * Math.max(1, perPage) : e.by;
  focused = shown[Math.max(0, Math.min(shown.length - 1, at + by))];
  note = "";
  host.ui.invalidate();
  return true;
}

function focusSearch(host: Host): void {
  host.clock.after(0, async () => {
    try {
      const { deny } = await host.ui.focus({ requestId: PANE, key: SEARCH });
      if (deny !== undefined) host.log(`omca evidence could not focus the search: ${deny}`);
    } catch (error) {
      host.log(`omca evidence could not focus the search: ${reason(error)}`);
    }
  });
}

const masked = (view: View, text: string) => redact(text, view.home, view.g.mask);
const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ");
const when = (at: number) => `${dayOf(at).slice(5)} ${clockOf(at)}`;
const width = (pieces: readonly Piece[]) => pieces.reduce((sum, piece) => sum + displayWidth(piece.text), 0);

// Cut where the room ends, with an ellipsis, so no row leans on the engine's truncation.
function fitPieces(pieces: readonly Piece[], room: number, ellipsis: string): Piece[] {
  const out: Piece[] = [];
  let used = 0;
  for (const piece of pieces) {
    const cells = displayWidth(piece.text);
    if (used + cells <= room) {
      if (cells > 0) out.push(piece);
      used += cells;
      continue;
    }
    const text = fitEnd(piece.text, room - used, ellipsis);
    if (!ellipsis.startsWith(text)) out.push({ ...piece, text });
    break;
  }
  return out;
}

const line = (view: View, pieces: readonly Piece[], room: number) => Line(view.kit, fitPieces(pieces, room, view.g.ellipsis));

function exitChip(view: View, code: number): Piece {
  const glyph = code === 0 ? view.g.check : view.g.cross;
  return chip(`${glyph}${String(code).padStart(2)}`, code === 0 ? "ok" : "fail", view.isAscii);
}

const typeChip = (view: View, type: EvidenceType) => chip(padEnd(TYPE_LABELS[type], TYPE_CELLS), TYPE_TONES[type], view.isAscii);

function agentPieces(view: View, verifiedBy: string | null, cells: number): Piece[] {
  if (cells === 0) return [];
  if (verifiedBy === null) return [{ text: " ".repeat(cells) }];
  const color = agentKey(verifiedBy);
  if (cells <= 2) return [{ text: ` ${view.g.agent}`, color }];
  return [{ text: ` ${view.g.agent} ${padEnd(fitEnd(shortType(verifiedBy), cells - 3, view.g.ellipsis), cells - 3)}`, color }];
}

// The program bold, each mask dim, so a reader sees what ran and what was hidden at a glance.
function commandPieces(text: string, mask: string): Piece[] {
  const pieces: Piece[] = [];
  for (const [index, part] of text.split(mask).entries()) {
    if (index > 0) pieces.push({ text: mask, color: TONE_KEYS.muted });
    if (part === "") continue;
    const head = index === 0 ? (/^\S+/.exec(part)?.[0] ?? "") : "";
    if (head !== "") pieces.push({ text: head, bold: true });
    if (part.length > head.length) pieces.push({ text: part.slice(head.length) });
  }
  return pieces;
}

function wrapGroups(groups: readonly (readonly Piece[])[], room: number, sep: Piece): Piece[][] {
  const lines: Piece[][] = [];
  for (const group of groups) {
    const line = lines.at(-1);
    if (line !== undefined && width(line) + width([sep]) + width(group) <= room) line.push(sep, ...group);
    else lines.push([...group]);
  }
  return lines;
}

function verdictLine(view: View, ledger: Ledger): { tone: ChipTone; title: string; groups: Piece[][] } {
  const { plan } = ledger;
  const mark = (label: string, tone: ChipTone, text: string): Piece[] => [chip(label, tone, view.isAscii), { text: ` ${text}` }];
  if (plan === null) {
    return { tone: "muted", title: "FINAL VERIFICATION", groups: [mark("NO PLAN", "muted", "no plan is bound to this session")] };
  }
  const title = `FINAL VERIFICATION ${view.g.dot} ${plan.name}`;
  if ("error" in plan) return { tone: "warn", title, groups: [mark("UNKNOWN", "warn", masked(view, plan.error).text)] };
  const verdict = verdictOf(ledger.entries, plan.sha);
  const agent = (entry: Entry): Piece[][] =>
    entry.verifiedBy === null ? [] : [[{ text: `${view.g.agent} ${shortType(entry.verifiedBy)}`, color: agentKey(entry.verifiedBy) }]];
  switch (verdict.kind) {
    case "complete":
      return {
        tone: "ok",
        title,
        groups: [mark("COMPLETE", "ok", "matches the plan as it is now"), [{ text: when(verdict.entry.at) }], ...agent(verdict.entry)],
      };
    case "stale":
      return { tone: "warn", title, groups: [mark("STALE", "warn", "the plan changed after it passed"), [{ text: when(verdict.entry.at) }]] };
    case "missing":
      return {
        tone: "fail",
        title,
        groups: [
          mark("MISSING", "fail", "no passing final verification"),
          ...(verdict.failed === null ? [] : [[{ text: `the last one exited ${verdict.failed.exitCode} at ${when(verdict.failed.at)}` }]]),
        ],
      };
  }
}

function tallyGroups(view: View, entries: readonly Entry[]): Piece[][] {
  const levels = recentLevels(entries, RECENT);
  const strip: Piece[] = [...dots(levels, view.isAscii), { text: ` last ${levels.length}`, color: TONE_KEYS.muted }];
  const counts = tallies(entries).map((tally): Piece[] => [
    { text: TYPE_LABELS[tally.type].toLowerCase(), color: TONE_KEYS[TYPE_TONES[tally.type]] },
    { text: ` ${tally.runs}` },
    ...(tally.failed === 0 ? [] : [{ text: ` ${view.g.cross}${tally.failed}`, color: TONE_KEYS.fail }]),
  ]);
  return levels.length === 0 ? [] : [strip, ...counts];
}

function header(view: View, ledger: Ledger): Block {
  const { tone, title, groups } = verdictLine(view, ledger);
  const tally = tallyGroups(view, ledger.entries);
  const sep = { text: ` ${view.g.dot} `, color: TONE_KEYS.muted };
  if (view.isInline) {
    const [lead, ...rest] = groups;
    const [strip, ...counts] = tally;
    const pieces: Piece[] = [...(lead?.slice(0, 1) ?? []), ...(ledger.plan === null ? [] : [{ text: ` ${ledger.plan.name}`, bold: true as const }])];
    const more = { text: ` ${view.g.ellipsis}`, color: TONE_KEYS.muted };
    for (const group of [...(strip === undefined ? [] : [strip]), ...rest, ...counts]) {
      const next = [{ text: "  " }, ...group];
      if (width(pieces) + width(next) > view.width) {
        if (width(pieces) + width([more]) <= view.width) pieces.push(more);
        break;
      }
      pieces.push(...next);
    }
    return { element: line(view, pieces, view.width), height: 1 };
  }
  const inner = view.width - 4;
  const lines = [...wrapGroups(groups, inner, sep), ...wrapGroups(tally, inner, { text: "  " })];
  return {
    element: Card(view.kit, { key: "verdict", title: fitEnd(title, inner, view.g.ellipsis), tone, children: lines.map((pieces) => line(view, pieces, inner)) }),
    height: 3 + lines.length,
  };
}

type Layout = { command: number; agent: number };

// The agent is named only while the command keeps room to read; otherwise its glyph alone carries its color.
function layoutOf(entries: readonly Entry[], rowWidth: number): Layout {
  const longest = Math.max(0, ...entries.map((entry) => (entry.verifiedBy === null ? 0 : displayWidth(shortType(entry.verifiedBy)))));
  const named = 3 + Math.min(AGENT_CELLS, longest);
  const agent = longest === 0 ? 0 : rowWidth - FIXED_CELLS - named >= MIN_COMMAND ? named : 2;
  return { command: Math.max(8, rowWidth - FIXED_CELLS - agent), agent };
}

function entryRow(view: View, entry: Entry, index: number, layout: Layout, isFocused: boolean): { element: RenderElement; isCut: boolean } {
  const command = oneLine(masked(view, entry.command).text);
  const fitted = fitMiddle(command, layout.command, view.g.ellipsis);
  const pieces: Piece[] = [
    { text: isFocused ? `${view.g.pointer} ` : "  " },
    { text: `${clockOf(entry.at)} `, color: TONE_KEYS.muted },
    typeChip(view, entry.type),
    { text: " " },
    exitChip(view, entry.exitCode),
    { text: " " },
    ...commandPieces(fitted, view.g.mask),
    { text: " ".repeat(Math.max(0, layout.command - displayWidth(fitted))) },
    ...agentPieces(view, entry.verifiedBy, layout.agent),
  ];
  const row = Row(view.kit, { key: `entry-${index}`, pieces: fitPieces(pieces, layout.command + FIXED_CELLS + layout.agent, view.g.ellipsis), isFocused });
  return { element: row, isCut: fitted !== command };
}

function cutLines(text: string, room: number, rows: number, ellipsis: string): { source: string; rows: number; more: number } {
  const lines = text.replace(/\s+$/, "").split("\n");
  const shown = lines.slice(0, Math.max(1, rows)).map((line) => fitEnd(line.replaceAll("\t", "  "), room, ellipsis));
  return { source: shown.join("\n"), rows: shown.length, more: lines.length - shown.length };
}

/**
 * The focused entry opened, in at most `budget` rows: its command highlighted, its output, then
 * when, by whom and how many secrets were masked.
 */
function detail(view: View, entry: Entry, room: number, budget: number, withCommand: boolean): Block[] {
  const { Text } = view.kit;
  const ellipsis = view.g.ellipsis;
  const command = masked(view, entry.command);
  const output = masked(view, entry.snippet);
  const hidden = command.masked + output.masked;
  const meta: Piece[][] = [
    [{ text: `${dayOf(entry.at)} ${clockOf(entry.at, true)}`, color: TONE_KEYS.muted }],
    ...(entry.verifiedBy === null ? [] : [[{ text: `${view.g.agent} ${shortType(entry.verifiedBy)}`, color: agentKey(entry.verifiedBy) }]]),
    ...(hidden === 0 ? [] : [[{ text: `${view.g.mask} ${hidden} masked`, color: TONE_KEYS.warn }]]),
  ];
  const metaLines = wrapGroups(meta, room, { text: ` ${view.g.dot} `, color: TONE_KEYS.muted });
  const blocks: Block[] = [];
  let left = budget - metaLines.length;
  if (withCommand) {
    const cut = cutLines(command.text, room, Math.min(COMMAND_ROWS, left - 1), ellipsis);
    blocks.push({ element: CodeBlock(view.kit, { source: cut.source, language: "bash" }), height: cut.rows });
    left -= cut.rows;
  }
  if (output.text.trim() === "") {
    blocks.push({ element: Text({ dimColor: true, children: [fitEnd("No output was logged with this run.", room, ellipsis)] }), height: 1 });
  } else {
    const whole = cutLines(output.text, room, left, ellipsis);
    const cut = whole.more > 0 && left > 1 ? cutLines(output.text, room, left - 1, ellipsis) : whole;
    blocks.push({ element: CodeBlock(view.kit, { source: cut.source }), height: cut.rows });
    if (cut.more > 0 && cut !== whole) {
      const more = `${ellipsis} ${cut.more} more line${cut.more === 1 ? "" : "s"}`;
      blocks.push({ element: Text({ dimColor: true, children: [fitEnd(more, room, ellipsis)] }), height: 1 });
    }
  }
  blocks.push(...metaLines.map((pieces) => ({ element: line(view, pieces, room), height: 1 })));
  return blocks;
}

type Key = readonly [hotkey: string, label: string, work: (surface: RenderSurface) => unknown, isOff?: boolean];

function keyRows(view: View, keys: readonly Key[], status: string): RenderElement[] {
  const { Box, Button, Text } = view.kit;
  const rows: Key[][] = [];
  let used = 0;
  for (const key of keys) {
    const cells = displayWidth(`${key[0]}: ${key[1]}`);
    const row = rows.at(-1);
    if (row !== undefined && used + KEY_GAP + cells <= view.width) {
      row.push(key);
      used += KEY_GAP + cells;
    } else {
      rows.push([key]);
      used = cells;
    }
  }
  const room = view.width - used - KEY_GAP;
  const isBeside = displayWidth(status) <= room;
  const statusText = (cells: number) => Text({ dimColor: true, children: [fitEnd(status, cells, view.g.ellipsis)] });
  const button = ([hotkey, label, work, isOff]: Key) =>
    Button({
      key: hotkey,
      hotkey,
      label,
      plain: true,
      ...(isOff === true ? { dimColor: true } : {}),
      onPress: (press) => view.press(() => work(press.surface))(),
    });
  return [
    ...rows.map((row, index) =>
      Box({
        key: `keys-${index}`,
        flexDirection: "row",
        columnGap: KEY_GAP,
        children: [...row.map(button), ...(isBeside && index === rows.length - 1 ? [statusText(room)] : [])],
      }),
    ),
    ...(isBeside ? [] : [statusText(view.width)]),
  ];
}

async function copyCommand(host: Host, text: string, surface: RenderSurface): Promise<void> {
  const copied = await host.ui.copy({ text, surface });
  note = copied.isCopied ? "copied the command" : `could not copy: ${copied.reason}`;
  host.ui.invalidate();
}

function actions(host: Host, view: View, ledger: Ledger, entry: Entry | undefined): Key[] {
  const toggle = (type: EvidenceType) => () => {
    filter = { ...filter, type: filter.type === type ? null : type };
    resetWindow(host);
  };
  const failures = () => {
    filter = { ...filter, isFailuresOnly: !filter.isFailuresOnly };
    resetWindow(host);
  };
  const search = () => {
    isSearching = true;
    host.ui.invalidate();
    focusSearch(host);
  };
  const filters: Key[] = [
    ...TYPE_KEYS.map(([hotkey, type, label]): Key => [hotkey, label, toggle(type), filter.type !== type]),
    ["x", "Fails", failures, !filter.isFailuresOnly],
  ];
  if (entry === undefined) return [...filters, ["f", "Find", search, filter.query === ""]];
  const command = masked(view, entry.command).text;
  const planSha = ledger.plan !== null && "sha" in ledger.plan ? ledger.plan.sha : null;
  return [
    ...filters,
    ["c", "Copy", (surface) => copyCommand(host, command, surface)],
    ["r", "Rerun", () => host.prompt.fill({ text: rerunPrompt(entry.type, command, planSha) })],
    ["f", "Find", search, filter.query === ""],
  ];
}

function statusOf(view: View, at: number, total: number): string {
  const parts = [
    `${at + 1}/${total}`,
    ...(filter.type === null ? [] : [`${TYPE_LABELS[filter.type].toLowerCase()} only`]),
    ...(filter.isFailuresOnly ? ["failures only"] : []),
    ...(filter.query.trim() === "" ? [] : [`"${filter.query.trim()}"`]),
    `${view.g.up}${view.g.down} move`,
    ...(note === "" ? [] : [note]),
  ];
  return parts.join(` ${view.g.dot} `);
}

function searchField(host: Host, view: View): RenderElement[] {
  if (!isSearching && filter.query === "") return [];
  return [
    Field(view.kit, {
      key: SEARCH,
      label: "search ",
      placeholder: "command, agent or type",
      value: filter.query,
      onInput: (value) => {
        filter = { ...filter, query: value };
        resetWindow(host);
      },
      onSubmit: (value) => {
        filter = { ...filter, query: value };
        isSearching = value.trim() !== "";
        resetWindow(host);
      },
    }),
  ];
}

type Drawn = { elements: RenderElement[]; height: number };

// Newest first, a rule with the day's pass tally above each day, the window kept on the focused
// entry. `isExpanded` opens that entry under its row; the split tier shows it beside the list.
function timeline(view: View, ledger: Ledger, shown: readonly number[], current: number, room: number, list: { width: number; isExpanded: boolean }): Drawn {
  const { Box } = view.kit;
  const items = shown.flatMap((index) => {
    const entry = ledger.entries[index];
    return entry === undefined ? [] : [{ index, entry }];
  });
  if (items.length === 0) {
    const empty = "No entry matches the filter. Press its key again to clear it.";
    return { elements: [view.kit.Text({ dimColor: true, wrap: "wrap", children: [empty] })], height: wrapText(empty, list.width).length };
  }
  const layout = layoutOf(ledger.entries, list.width);
  const days = items.map(({ entry }) => dayOf(entry.at));
  const opensDay = days.map((day, position) => position === 0 || days[position - 1] !== day);
  const rows = items.map(({ index, entry }, position) => entryRow(view, entry, index, layout, position === current));
  const open = items[current];
  const budget = Math.min(room - 2, (view.isInline ? INLINE_SNIPPET_ROWS : DOCK_SNIPPET_ROWS) + COMMAND_ROWS + 2);
  const expanded =
    list.isExpanded && open !== undefined
      ? detail(view, open.entry, list.width - DETAIL_INDENT, budget, !view.isInline || rows[current]?.isCut === true)
      : [];
  const expandedRows = expanded.reduce((sum, block) => sum + block.height, 0);
  const heights = items.map((_, position) => 1 + (opensDay[position] === true ? 1 : 0) + (position === current ? expandedRows : 0));
  const placed = placeEntries(heights, opensDay, first, current, room);
  first = placed.start;
  laid = { shown, perPage: Math.max(1, placed.end - placed.start) };

  const tally = new Map<string, { done: number; total: number }>();
  for (const [position, { entry }] of items.entries()) {
    const day = days[position] ?? "";
    const count = tally.get(day) ?? { done: 0, total: 0 };
    tally.set(day, { done: count.done + (entry.exitCode === 0 ? 1 : 0), total: count.total + 1 });
  }
  const elements: RenderElement[] = [];
  let height = 0;
  for (let position = placed.start; position < placed.end; position += 1) {
    const item = items[position];
    const row = rows[position];
    if (item === undefined || row === undefined) continue;
    if (position === placed.start || opensDay[position] === true) {
      elements.push(line(view, rule(list.width, view.g, view.isAscii, dayLabel(item.entry.at), tally.get(days[position] ?? "")), list.width));
      height += 1;
    }
    elements.push(row.element);
    height += 1;
    if (position === current && expanded.length > 0) {
      elements.push(
        Box({ key: `detail-${item.index}`, flexDirection: "column", paddingLeft: DETAIL_INDENT, children: expanded.map((block) => block.element) }),
      );
      height += expandedRows;
    }
  }
  return { elements, height };
}

function detailCard(view: View, entry: Entry, index: number, width: number, room: number): Drawn {
  const blocks = detail(view, entry, width - 4, room - 3, true);
  const element = Card(view.kit, {
    key: `detail-${index}`,
    title: `${TYPE_LABELS[entry.type]} ${view.g.dot} exit ${entry.exitCode}`,
    tone: entry.exitCode === 0 ? "ok" : "fail",
    width,
    children: blocks.map((block) => block.element),
  });
  return { elements: [element], height: 3 + blocks.reduce((sum, block) => sum + block.height, 0) };
}

export const view: TabView = async (host, view) => {
  const { Box, Text } = view.kit;
  const ledger = (await host.state.ledger.get()).value;
  const words = { loading: "Reading the evidence ledger", empty: "No verification evidence has been logged here yet." };
  laid = undefined;
  if (ledger === undefined) return [noticeRow(view, { kind: "loading" }, words)];
  if (ledger.error !== null) {
    const why = "evidence_log refuses to write to it until it parses again, and no verdict can be read from it.";
    const failure = `${view.g.cross} ${masked(view, ledger.error).text}`;
    return [Text({ color: TONE_KEYS.fail, wrap: "wrap", children: [failure] }), Text({ dimColor: true, wrap: "wrap", children: [why] })];
  }
  const head = header(view, ledger);
  if (ledger.entries.length === 0) return [head.element, noticeRow(view, { kind: "empty" }, words)];

  const shown = shownIndices(ledger.entries, filter, view.home);
  const current = Math.max(0, shown.indexOf(focused ?? -1));
  const index = shown[current];
  focused = index;
  const entry = index === undefined ? undefined : ledger.entries[index];
  const status = shown.length === 0 ? `0/${ledger.entries.length} ${view.g.dot} nothing matches` : statusOf(view, current, shown.length);
  const keys = keyRows(view, actions(host, view, ledger, entry), status);
  const field = searchField(host, view);
  const room = Math.max(MIN_ROOM, view.rows - head.height - keys.length - field.length);
  const isSplit = view.tier === "split" && entry !== undefined && index !== undefined;
  const listWidth = isSplit ? Math.floor(view.width * MASTER_SHARE) : view.width;
  const list = timeline(view, ledger, shown, current, room, { width: listWidth, isExpanded: !isSplit });
  let body = list;
  if (isSplit) {
    const card = detailCard(view, entry, index, view.width - listWidth - KEY_GAP, room);
    body = {
      elements: [
        Box({
          key: "split",
          flexDirection: "row",
          columnGap: KEY_GAP,
          // The card sits in its own column so the row's height does not stretch it and spread its code blocks apart.
          children: [Box({ flexDirection: "column", width: listWidth, children: list.elements }), Box({ flexDirection: "column", children: card.elements })],
        }),
      ],
      height: Math.max(list.height, card.height),
    };
  }
  const blanks = (count: number) => Array.from({ length: Math.max(0, count) }, () => Text({ children: [" "] }));
  const filled = head.height + Math.max(room, body.height) + keys.length + field.length;
  // One row past the body brings the arrows and the wheel to `scroll` instead of the focus ring.
  return [head.element, ...body.elements, ...blanks(room - body.height), ...keys, ...field, ...blanks(view.rows + 1 - filled)];
};
