import type { RenderElement, RenderSurface } from "claude-code";
import {
  dayLabel,
  type EvidenceType,
  type Filter,
  latestByType,
  nextTypeFilter,
  parseLedger,
  placeEntries,
  rerunPrompt,
  shownIndices,
  TYPE_WORDS,
  verdictOf,
} from "../../src/core/evidence.ts";
import { BOULDER, LEDGER } from "../../src/core/omca-paths.ts";
import { sha256Hex } from "../../src/core/sha256.ts";
import { agentGlyph, clockOf, COLUMN_GAP, dayOf, displayWidth, fitEnd, fitMiddle, oneLine, padEnd, shortType, wrapText } from "../../src/core/ui-kit.ts";
import { agentKey, chip, type ChipTone, fitPieces, ON_SURFACE, type Piece, piecesWidth, redact, rule, TONE_KEYS } from "../../src/core/visual.ts";
import type { Input } from "../dispatch.ts";
import { boundPlanOf, bytesOf, type Host, reason, type State } from "../host.ts";
import { blanks, noticeRow, refocus, type TabView, type View, wrapAt } from "../pane.ts";
import { codeUnits, resetOffset, ScrollRegion, type Unit } from "../regions.ts";
import { Card, Field, Line, Pieces } from "../ui.ts";

type Ledger = State["ledger"];
type Entry = Ledger["entries"][number];
type Bound = { name: string; path: string } | { name: string; error: string } | null;
type Block = { element: RenderElement; height: number };

const POINTER_CELLS = 2;
const MARK_CELLS = 1;
const CLOCK_CELLS = 5;
const TYPE_CELLS = 6;
const AGENT_CELLS = 12;
const SEARCH = "search";
const FIXED_CELLS = POINTER_CELLS + MARK_CELLS + COLUMN_GAP + CLOCK_CELLS + COLUMN_GAP + TYPE_CELLS + COLUMN_GAP;
const MIN_COMMAND = 28;
const MASTER_SHARE = 0.53;
const DETAIL_INDENT = 4;
const OPENED_REGION = "evidence-opened";
const CARD_CHROME_ROWS = 3;
const CARD_INSET = 2;
// An entry with its two cue rows; the verdict, the filter state and the key row each give way before it.
const MIN_TIMELINE_ROWS = 3;
const NEIGHBOURS = 2;
// The card's chrome and enough rows inside it to carry both scroll cues and some content.
const MIN_CARD_ROWS = CARD_CHROME_ROWS + 5;
const MIN_OPENED_ROWS = 2;
// A docked body shorter than this draws the verdict as one line, as the Plan header does.
const CARD_FROM_ROWS = 24;

let seen: string | undefined;
let boulder: { stamp: string; bound: Bound } | undefined;
let filter: Filter = { type: null, isFailuresOnly: false, query: "" };
let isSearching = false;
let focused: number | undefined;
let cardFor: number | undefined;
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
    const bound = (await boundPlanOf(host)) ?? null;
    boulder = { stamp: at, bound };
    return boulder;
  } catch (error) {
    boulder = undefined;
    return { stamp: "failed", bound: { name: "", error: `Could not read ${BOULDER}: ${reason(error)}` } };
  }
}

async function planOf(host: Host, bound: Bound): Promise<Ledger["plan"]> {
  if (bound === null || "error" in bound) return bound;
  try {
    return { name: bound.name, sha: sha256Hex(await bytesOf(host, bound.path)) };
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

function select(host: Host, index: number): void {
  focused = index;
  note = "";
  resetOffset(OPENED_REGION);
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

const masked = (view: View, text: string) => redact(text, view.home, view.g.mask);
const when = (at: number) => `${dayOf(at).slice(5)} ${clockOf(at)}`;

const line = (view: View, pieces: readonly Piece[], room: number) => Line(view.kit, fitPieces(pieces, room, view.g.ellipsis));
const gap: Piece = { text: " ".repeat(COLUMN_GAP) };
const words = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const capital = (word: string) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;

const outcome = (view: View, code: number): Piece =>
  code === 0 ? { text: view.g.check, color: TONE_KEYS.ok } : { text: view.g.cross, color: TONE_KEYS.fail };

// The final verification, the plan's own, reads bold; every other type is a muted category.
const typePiece = (type: EvidenceType): Piece =>
  type === "final_verification"
    ? { text: padEnd(TYPE_WORDS[type], TYPE_CELLS), color: ON_SURFACE, bold: true }
    : { text: padEnd(TYPE_WORDS[type], TYPE_CELLS), color: TONE_KEYS.muted };

// The agent's glyph carries its color and the name stays muted; `cells` counts the gap before them.
function agentPieces(view: View, verifiedBy: string | null, cells: number): Piece[] {
  if (cells === 0) return [];
  if (verifiedBy === null) return [{ text: " ".repeat(cells) }];
  const name = cells - COLUMN_GAP - 2;
  return [gap, { text: agentGlyph(verifiedBy, view.g), color: agentKey(verifiedBy) }, { text: ` ${padEnd(fitEnd(shortType(verifiedBy), name, view.g.ellipsis), name)}`, color: TONE_KEYS.muted }];
}

function agentMeta(view: View, verifiedBy: string): Piece[] {
  return [
    { text: agentGlyph(verifiedBy, view.g), color: agentKey(verifiedBy) },
    { text: ` ${shortType(verifiedBy)}`, color: TONE_KEYS.muted },
  ];
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
    if (line !== undefined && piecesWidth(line) + piecesWidth([sep]) + piecesWidth(group) <= room) line.push(sep, ...group);
    else lines.push([...group]);
  }
  return lines;
}

function verdictLine(view: View, ledger: Ledger): { tone: ChipTone; title: string; groups: Piece[][]; when: Piece[] } {
  const { plan } = ledger;
  const mark = (label: string, tone: ChipTone, text: string): Piece[] => [chip(label, tone, view.isAscii), { text: ` ${text}` }];
  const at = (time: number): Piece[] => [{ text: when(time), color: TONE_KEYS.muted }];
  if (plan === null) {
    return { tone: "muted", title: "Final verification", groups: [mark("NO PLAN", "muted", "no plan is bound to this session")], when: [] };
  }
  const title = `Final verification ${view.g.dot} ${plan.name}`;
  if ("error" in plan) return { tone: "warn", title, groups: [mark("UNKNOWN", "warn", masked(view, plan.error).text)], when: [] };
  const verdict = verdictOf(ledger.entries, plan.sha);
  switch (verdict.kind) {
    case "complete":
      return { tone: "ok", title, groups: [mark("COMPLETE", "ok", "matches the current plan"), at(verdict.entry.at)], when: at(verdict.entry.at) };
    case "stale":
      return { tone: "warn", title, groups: [mark("STALE", "warn", "plan edited since it passed"), at(verdict.entry.at)], when: at(verdict.entry.at) };
    case "missing":
      return verdict.failed === null
        ? { tone: "fail", title, groups: [mark("MISSING", "fail", "no passing run yet")], when: [] }
        : {
            tone: "fail",
            title,
            groups: [mark("MISSING", "fail", `last run exited ${verdict.failed.exitCode}`), at(verdict.failed.at)],
            when: at(verdict.failed.at),
          };
  }
}

// Each proving type's newest run as a checklist, so a reader sees what is broken now.
function latestGroups(view: View, entries: readonly Entry[]): Piece[][] {
  return latestByType(entries).map(({ type, isPassing }) => [outcome(view, isPassing ? 0 : 1), { text: ` ${TYPE_WORDS[type]}` }]);
}

function header(view: View, ledger: Ledger, isCard: boolean): Block {
  const { tone, title, groups, when: time } = verdictLine(view, ledger);
  const latest = latestGroups(view, ledger.entries);
  const sep = { text: ` ${view.g.dot} `, color: TONE_KEYS.muted };
  if (!isCard) {
    const pieces: Piece[] = [...(groups[0]?.slice(0, 1) ?? [])];
    if (ledger.plan !== null) pieces.push({ text: ` ${ledger.plan.name}`, bold: true });
    const more = { text: ` ${view.g.ellipsis}`, color: TONE_KEYS.muted };
    for (const group of [...latest, ...(time.length === 0 ? [] : [time])]) {
      const next = [gap, ...group];
      if (piecesWidth(pieces) + piecesWidth(next) > view.width) {
        if (piecesWidth(pieces) + piecesWidth([more]) <= view.width) pieces.push(more);
        break;
      }
      pieces.push(...next);
    }
    return { element: line(view, pieces, view.width), height: 1 };
  }
  const inner = view.width - 4;
  const lines = [...wrapGroups(groups, inner, sep), ...wrapGroups(latest, inner, gap)];
  return {
    element: Card(view.kit, { key: "verdict", title: fitEnd(title, inner, view.g.ellipsis), tone, isAscii: view.isAscii, children: lines.map((pieces) => line(view, pieces, inner)) }),
    height: 3 + lines.length,
  };
}

type Layout = { command: number; agent: number };

// The agent column shows only while the command keeps room to read; the focused entry's detail names it either way.
function layoutOf(entries: readonly Entry[], rowWidth: number): Layout {
  const longest = Math.max(0, ...entries.map((entry) => (entry.verifiedBy === null ? 0 : displayWidth(shortType(entry.verifiedBy)))));
  const named = COLUMN_GAP + 2 + Math.min(AGENT_CELLS, longest);
  const agent = longest === 0 || rowWidth - FIXED_CELLS - named < MIN_COMMAND ? 0 : named;
  return { command: Math.max(8, rowWidth - FIXED_CELLS - agent), agent };
}

function fitCommand(view: View, entry: Entry, layout: Layout): { fitted: string; isCut: boolean } {
  const command = oneLine(masked(view, entry.command).text);
  const fitted = fitMiddle(command, layout.command, view.g.ellipsis);
  return { fitted, isCut: fitted !== command };
}

function entryRow(host: Host, view: View, entry: Entry, index: number, layout: Layout, isFocused: boolean): RenderElement {
  const { Box, Button } = view.kit;
  const { fitted } = fitCommand(view, entry, layout);
  const lead: Piece[] = [{ text: isFocused ? `${view.g.pointer} ` : "  " }, outcome(view, entry.exitCode), gap];
  const rest: Piece[] = [
    gap,
    typePiece(entry.type),
    gap,
    ...commandPieces(fitted, view.g.mask),
    ...(layout.agent > 0 && displayWidth(fitted) < layout.command ? [{ text: " ".repeat(layout.command - displayWidth(fitted)) }] : []),
    ...agentPieces(view, entry.verifiedBy, layout.agent),
  ];
  const room = layout.command + FIXED_CELLS + layout.agent - piecesWidth(lead) - CLOCK_CELLS;
  return Box({
    key: `entry-${index}`,
    flexDirection: "row",
    hover: { backgroundColor: TONE_KEYS.focus },
    ...(isFocused ? { backgroundColor: TONE_KEYS.focus } : {}),
    children: [
      Pieces(view.kit, lead, { isFocused }),
      Button({ key: `entry-time-${index}`, label: clockOf(entry.at), plain: true, dimColor: true, onPress: view.press(() => select(host, index)) }),
      Pieces(view.kit, fitPieces(rest, room, view.g.ellipsis), { isFocused }),
    ],
  });
}

type Opened = { rows: number; element: (top: number) => RenderElement };

/**
 * The focused entry opened in the `left` rows its neighbours leave, or `MIN_OPENED_ROWS` of output
 * under `cap`: its command when the row cut it and its output in a region that wraps and scrolls,
 * then when, by whom and how many secrets were masked.
 */
function opened(view: View, entry: Entry, key: string, room: number, left: number, cap: number, withCommand: boolean): Opened {
  const { Box, Text } = view.kit;
  const command = masked(view, entry.command);
  const output = masked(view, entry.snippet);
  const hidden = command.masked + output.masked;
  const meta: Piece[][] = [
    [{ text: `${dayOf(entry.at)} ${clockOf(entry.at, true)}`, color: TONE_KEYS.muted }],
    ...(entry.verifiedBy === null ? [] : [agentMeta(view, entry.verifiedBy)]),
    ...(hidden === 0 ? [] : [[{ text: `${words(hidden, "secret")} masked`, color: TONE_KEYS.muted }]]),
  ];
  const wrappedMeta = wrapGroups(meta, room, { text: ` ${view.g.dot} `, color: TONE_KEYS.muted });
  const budget = Math.min(cap, Math.max(left, MIN_OPENED_ROWS + wrappedMeta.length));
  const metaLines = wrappedMeta.slice(0, Math.max(0, budget - MIN_OPENED_ROWS));
  const units: Unit[] = [
    ...(withCommand ? codeUnits(view.kit, command.text, room, "bash") : []),
    ...(output.text.trim() === ""
      ? [{ element: Text({ dimColor: true, children: [fitEnd("No output was logged with this run.", room, view.g.ellipsis)] }), rows: 1 }]
      : codeUnits(view.kit, output.text, room)),
  ];
  const height = Math.min(units.length, budget - metaLines.length);
  return {
    rows: Math.max(0, height) + metaLines.length,
    element: (top) =>
      Box({
        key,
        flexDirection: "column",
        paddingLeft: DETAIL_INDENT,
        children: [
          ...(height < 1 ? [] : [ScrollRegion({ kit: view.kit, g: view.g, key: OPENED_REGION, left: DETAIL_INDENT, top, width: room, height, units })]),
          ...metaLines.map((pieces) => line(view, pieces, room)),
        ],
      }),
  };
}

type Key = readonly [hotkey: string, label: string, work: (surface: RenderSurface) => unknown, isOff?: boolean];

// More rows than `maxRows` become one: the counter, then the keys that fit beside it.
function keyRows(view: View, keys: readonly Key[], status: string, maxRows: number): RenderElement[] {
  const { Box, Button, Text } = view.kit;
  const cellsOf = (key: Key) => displayWidth(`${key[0]}: ${key[1]}`);
  const wrapped = wrapAt(keys, view.width, COLUMN_GAP, cellsOf);
  const last = wrapped.at(-1) ?? [];
  const used = last.reduce((sum, key) => sum + cellsOf(key), 0) + COLUMN_GAP * Math.max(0, last.length - 1);
  const roomBeside = view.width - used - COLUMN_GAP;
  const isBeside = displayWidth(status) <= roomBeside;
  const isOneRow = wrapped.length + (isBeside ? 0 : 1) > maxRows;
  const counter = status.split(" ")[0] ?? status;
  const rows = isOneRow ? wrapAt(keys, view.width - displayWidth(counter) - COLUMN_GAP, COLUMN_GAP, cellsOf).slice(0, 1) : wrapped;
  const statusText = (text: string, cells: number) => Text({ dimColor: true, children: [fitEnd(text, cells, view.g.ellipsis)] });
  const button = ([hotkey, label, work, isOff]: Key) =>
    Button({
      key: hotkey,
      hotkey,
      label,
      plain: true,
      ...(isOff === true ? { dimColor: true } : {}),
      onPress: (press) => view.press(() => work(press.surface))(),
    });
  if (isOneRow) {
    return [Box({ key: "keys-0", flexDirection: "row", columnGap: COLUMN_GAP, children: [statusText(counter, displayWidth(counter)), ...(rows[0] ?? []).map(button)] })];
  }
  return [
    ...rows.map((row, index) =>
      Box({
        key: `keys-${index}`,
        flexDirection: "row",
        columnGap: COLUMN_GAP,
        children: [...row.map(button), ...(isBeside && index === rows.length - 1 ? [statusText(status, roomBeside)] : [])],
      }),
    ),
    ...(isBeside ? [] : [statusText(status, view.width)]),
  ];
}

async function copyCommand(host: Host, text: string, surface: RenderSurface): Promise<void> {
  const copied = await host.ui.copy({ text, surface });
  note = copied.isCopied ? "copied the command" : `could not copy: ${copied.reason}`;
  host.ui.invalidate();
}

function actions(host: Host, view: View, ledger: Ledger, entry: Entry | undefined): Key[] {
  const cycle = () => {
    filter = { ...filter, type: nextTypeFilter(ledger.entries, filter.type) };
    resetWindow(host);
  };
  const failures = () => {
    filter = { ...filter, isFailuresOnly: !filter.isFailuresOnly };
    resetWindow(host);
  };
  const search = () => {
    isSearching = true;
    host.ui.invalidate();
    refocus(host, SEARCH, "evidence");
  };
  // One key steps through the types, so the filters hold their places whatever is focused.
  const filters: Key[] = [
    ["t", filter.type === null ? "Type" : capital(TYPE_WORDS[filter.type]), cycle, filter.type === null],
    ["x", "Fails", failures, !filter.isFailuresOnly],
    ["f", "Find", search, filter.query === ""],
  ];
  if (entry === undefined) return filters;
  const command = masked(view, entry.command).text;
  const planSha = ledger.plan !== null && "sha" in ledger.plan ? ledger.plan.sha : null;
  return [
    ...filters,
    ["c", "Copy", (surface) => copyCommand(host, command, surface)],
    ["r", "Rerun", () => host.prompt.fill({ text: rerunPrompt(entry.type, command, planSha) })],
  ];
}

function statusOf(view: View, at: number, total: number): string {
  const parts = [
    `${at + 1}/${total}`,
    `${view.g.up}${view.g.down} move`,
    ...(note === "" ? [] : [note]),
  ];
  return parts.join(` ${view.g.dot} `);
}

function filterRow(host: Host, view: View, shown: number, total: number): RenderElement[] {
  const isFinding = isSearching || filter.query !== "";
  if (!isFinding && filter.type === null && !filter.isFailuresOnly) return [];
  const { Box } = view.kit;
  const flags: Piece[] = [
    ...(filter.type === null ? [] : [{ text: " " }, chip(TYPE_WORDS[filter.type].toUpperCase(), "info", view.isAscii)]),
    ...(filter.isFailuresOnly ? [{ text: " " }, chip("FAILING", "fail", view.isAscii)] : []),
    { text: ` ${shown} of ${total}`, color: TONE_KEYS.muted },
  ];
  const field = Field(view.kit, {
    key: SEARCH,
    label: "Find",
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
  });
  return [Box({ key: "filter-row", flexDirection: "row", width: view.width, children: [...(isFinding ? [Box({ flexGrow: 1, children: [field] })] : []), Line(view.kit, flags)] })];
}

type Drawn = { elements: RenderElement[]; height: number };

// Newest first, a rule naming the day above each day's entries, the window kept on the focused
// entry, `↑ n more` and `↓ n more` where entries are out of view. `isExpanded` opens that entry
// under its row with every row left after its neighbours; the split tier shows it beside the list.
function timeline(host: Host, view: View, ledger: Ledger, shown: readonly number[], current: number, room: number, list: { width: number; top: number; isExpanded: boolean }): Drawn {
  const items = shown.flatMap((index) => {
    const entry = ledger.entries[index];
    return entry === undefined ? [] : [{ index, entry }];
  });
  if (items.length === 0) {
    const empty = "No entry matches the filter. Press t or x to change it.";
    return { elements: [view.kit.Text({ dimColor: true, wrap: "wrap", children: [empty] })], height: wrapText(empty, list.width).length };
  }
  const layout = layoutOf(ledger.entries, list.width);
  const days = items.map(({ entry }) => dayOf(entry.at));
  const opensDay = days.map((day, position) => position === 0 || days[position - 1] !== day);
  const rowsAt = (position: number) => 1 + (opensDay[position] === true ? 1 : 0);
  const open = items[current];
  const above = Math.min(NEIGHBOURS, current);
  const below = Math.min(NEIGHBOURS, items.length - 1 - current);
  const rowsFrom = (from: number, count: number) => Array.from({ length: count }, (_, at) => rowsAt(from + at)).reduce((sum, rows) => sum + rows, 0);
  const around = rowsFrom(current - above, above) + rowsFrom(current + 1, below);
  const reserved = items.length > above + below + 1 ? 2 : 0;
  const lead = opensDay[current - above] === true ? 0 : 1;
  const own = rowsAt(current);
  const cap = room - (items.length > 1 ? (current > 0 && current < items.length - 1 ? 2 : 1) : 0) - own;
  const expansion =
    list.isExpanded && open !== undefined && cap > 0
      ? opened(view, open.entry, `detail-${open.index}`, list.width - DETAIL_INDENT, room - reserved - own - lead - around, cap, fitCommand(view, open.entry, layout).isCut)
      : undefined;
  const heights = items.map((_, position) => rowsAt(position) + (position === current ? (expansion?.rows ?? 0) : 0));
  const fit = (rows: number, from: number) => placeEntries(heights, opensDay, from, current, rows);
  let placed = fit(room, first);
  if (placed.end - placed.start < items.length) {
    placed = fit(room - 2, placed.start);
    if (placed.start === 0 || placed.end === items.length) placed = fit(room - 1, placed.start);
  }
  first = placed.start;
  laid = { shown, perPage: Math.max(1, placed.end - placed.start) };

  const isAbove = placed.start > 0;
  const isBelow = placed.end < items.length;
  const limit = room - (isAbove ? 1 : 0) - (isBelow ? 1 : 0);
  const edge = (text: string) => view.kit.Text({ dimColor: true, children: [fitEnd(text, list.width, view.g.ellipsis)] });
  const elements: RenderElement[] = isAbove ? [edge(`  ${view.g.up} ${placed.start} more`)] : [];
  let height = 0;
  for (let position = placed.start; position < placed.end; position += 1) {
    const item = items[position];
    if (item === undefined) continue;
    if ((position === placed.start || opensDay[position] === true) && height + 2 <= limit) {
      elements.push(line(view, rule(list.width, view.g, view.isAscii, dayLabel(item.entry.at)), list.width));
      height += 1;
    }
    elements.push(entryRow(host, view, item.entry, item.index, layout, position === current));
    height += 1;
    if (position === current && expansion !== undefined) {
      elements.push(expansion.element(list.top + (isAbove ? 1 : 0) + height));
      height += expansion.rows;
    }
  }
  if (isBelow) elements.push(...blanks(view, limit - height), edge(`  ${view.g.down} ${items.length - placed.end} more`));
  return { elements, height: isBelow ? room : height + (isAbove ? 1 : 0) };
}

// A final verification proves the plan whose hash it carries; one without a hash proves any plan.
function planLine(view: View, entry: Entry, plan: Ledger["plan"]): Piece[] {
  if (entry.planSha === "") return [{ text: "Proves any plan: it carries no plan hash", color: TONE_KEYS.muted }];
  if (plan === null || !("sha" in plan)) return [{ text: "For a plan this session no longer has bound", color: TONE_KEYS.muted }];
  if (entry.planSha === plan.sha) return [{ text: `${view.g.check} `, color: TONE_KEYS.ok }, { text: `For ${plan.name} as it is now`, color: TONE_KEYS.muted }];
  return [{ text: `${view.g.warn} `, color: TONE_KEYS.warn }, { text: `For an earlier version of ${plan.name}`, color: TONE_KEYS.muted }];
}

/**
 * The focused run in full: its exit code, when and by whom, the plan a final verification covers,
 * then its command and its output, both wrapped rather than cut.
 */
function cardUnits(view: View, entry: Entry, plan: Ledger["plan"], room: number): Unit[] {
  const { Text } = view.kit;
  const muted = TONE_KEYS.muted;
  const command = masked(view, entry.command);
  const output = masked(view, entry.snippet);
  const hidden = command.masked + output.masked;
  const facts = wrapGroups(
    [
      [{ text: `exit ${entry.exitCode}`, color: entry.exitCode === 0 ? TONE_KEYS.ok : TONE_KEYS.fail }],
      [{ text: `${dayOf(entry.at)} ${clockOf(entry.at, true)}`, color: muted }],
      ...(entry.verifiedBy === null ? [] : [agentMeta(view, entry.verifiedBy)]),
      ...(hidden === 0 ? [] : [[{ text: `${words(hidden, "secret")} masked`, color: muted }]]),
    ],
    room,
    { text: ` ${view.g.dot} `, color: muted },
  );
  const lead = [...facts, ...(entry.type === "final_verification" ? [planLine(view, entry, plan)] : [])];
  const units: Unit[] = lead.map((pieces) => ({ element: line(view, pieces, room), rows: 1 }));
  const section = (label: string) => units.push({ element: Text({ children: [" "] }), rows: 1 }, { element: Text({ color: muted, children: [label] }), rows: 1 });
  section("Command");
  units.push(...codeUnits(view.kit, command.text, room, "bash"));
  section("Output");
  if (output.text.trim() === "") {
    units.push({ element: Text({ dimColor: true, children: [fitEnd("No output was logged with this run.", room, view.g.ellipsis)] }), rows: 1 });
    return units;
  }
  units.push(...codeUnits(view.kit, output.text, room));
  return units;
}

/** The card's content scrolls inside its border; `at` is the card's own corner in the tab's rows and columns. */
function detailCard(view: View, entry: Entry, index: number, plan: Ledger["plan"], width: number, room: number, at: { left: number; top: number }): Drawn {
  const inner = width - 4;
  const units = cardUnits(view, entry, plan, inner);
  const height = Math.max(1, Math.min(units.length, room - CARD_CHROME_ROWS));
  const isPass = entry.exitCode === 0;
  const name = entry.type === "final_verification" ? "Final verification" : `${TYPE_WORDS[entry.type].replace(/^./, (first) => first.toUpperCase())} run`;
  const region = ScrollRegion({
    kit: view.kit,
    g: view.g,
    key: OPENED_REGION,
    left: at.left + CARD_INSET,
    top: at.top + CARD_INSET,
    width: inner,
    height,
    units,
  });
  const element = Card(view.kit, {
    key: `detail-${index}`,
    title: `${isPass ? view.g.check : view.g.cross} ${name} ${isPass ? "passed" : "failed"}`,
    tone: isPass ? "ok" : "fail",
    isAscii: view.isAscii,
    width,
    children: [region],
  });
  return { elements: [element], height: CARD_CHROME_ROWS + height };
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
  const head = header(view, ledger, !view.isInline && view.rows >= CARD_FROM_ROWS);
  if (ledger.entries.length === 0) {
    const how = "Record a run with an evidence_log call after a build, test or lint.";
    return [head.element, noticeRow(view, { kind: "empty" }, words), Text({ dimColor: true, wrap: "wrap", children: [how] })];
  }

  const shown = shownIndices(ledger.entries, filter, view.home);
  const current = Math.max(0, shown.indexOf(focused ?? -1));
  const index = shown[current];
  focused = index;
  if (index !== cardFor) resetOffset(OPENED_REGION);
  cardFor = index;
  const entry = index === undefined ? undefined : ledger.entries[index];
  const status = shown.length === 0 ? `0/${ledger.entries.length} ${view.g.dot} nothing matches` : statusOf(view, current, shown.length);
  const filters = filterRow(host, view, shown.length, ledger.entries.length);
  const spare = view.rows - head.height - filters.length - MIN_TIMELINE_ROWS;
  const allKeys = keyRows(view, actions(host, view, ledger, entry), status, Math.max(1, spare));
  const keys = spare < 1 ? [] : allKeys;
  const room = Math.max(MIN_TIMELINE_ROWS, view.rows - head.height - filters.length - keys.length);
  const top = head.height + filters.length;
  const isSplit = view.tier === "split" && entry !== undefined && index !== undefined && room >= MIN_CARD_ROWS;
  const listWidth = isSplit ? Math.floor(view.width * MASTER_SHARE) : view.width;
  const list = timeline(host, view, ledger, shown, current, room, { width: listWidth, top, isExpanded: !isSplit });
  let body = list;
  if (isSplit) {
    const card = detailCard(view, entry, index, ledger.plan, view.width - listWidth - COLUMN_GAP, room, { left: listWidth + COLUMN_GAP, top });
    body = {
      elements: [
        Box({
          key: "split",
          flexDirection: "row",
          columnGap: COLUMN_GAP,
          // The card sits in its own column so the row's height does not stretch it and spread its code blocks apart.
          children: [Box({ flexDirection: "column", width: listWidth, children: list.elements }), Box({ flexDirection: "column", children: card.elements })],
        }),
      ],
      height: Math.max(list.height, card.height),
    };
  }
  const filled = top + Math.max(room, body.height) + keys.length;
  // One row past the body brings the arrows and the wheel to `scroll` instead of the focus ring.
  return [head.element, ...filters, ...body.elements, ...blanks(view, room - body.height), ...keys, ...blanks(view, view.rows + 1 - filled)];
};
