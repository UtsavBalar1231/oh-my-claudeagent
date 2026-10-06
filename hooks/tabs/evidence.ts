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
import { Card, CodeBlock, Field, Line, Row } from "../ui.ts";

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

function header(view: View, ledger: Ledger): Block {
  const { tone, title, groups, when: time } = verdictLine(view, ledger);
  const latest = latestGroups(view, ledger.entries);
  const sep = { text: ` ${view.g.dot} `, color: TONE_KEYS.muted };
  if (view.isInline) {
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

function entryRow(view: View, entry: Entry, index: number, layout: Layout, isFocused: boolean): RenderElement {
  const { fitted } = fitCommand(view, entry, layout);
  const pieces: Piece[] = [
    { text: isFocused ? `${view.g.pointer} ` : "  " },
    outcome(view, entry.exitCode),
    gap,
    { text: clockOf(entry.at), color: TONE_KEYS.muted },
    gap,
    typePiece(entry.type),
    gap,
    ...commandPieces(fitted, view.g.mask),
    ...(layout.agent > 0 && displayWidth(fitted) < layout.command ? [{ text: " ".repeat(layout.command - displayWidth(fitted)) }] : []),
    ...agentPieces(view, entry.verifiedBy, layout.agent),
  ];
  return Row(view.kit, { key: `entry-${index}`, pieces: fitPieces(pieces, layout.command + FIXED_CELLS + layout.agent, view.g.ellipsis), isFocused });
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
    ...(entry.verifiedBy === null ? [] : [agentMeta(view, entry.verifiedBy)]),
    ...(hidden === 0 ? [] : [[{ text: `${words(hidden, "secret")} masked`, color: TONE_KEYS.muted }]]),
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
  const cellsOf = (key: Key) => displayWidth(`${key[0]}: ${key[1]}`);
  const rows = wrapAt(keys, view.width, COLUMN_GAP, cellsOf);
  const last = rows.at(-1) ?? [];
  const used = last.reduce((sum, key) => sum + cellsOf(key), 0) + COLUMN_GAP * Math.max(0, last.length - 1);
  const room = view.width - used - COLUMN_GAP;
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
        columnGap: COLUMN_GAP,
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
    ...(filter.type === null ? [] : [`${TYPE_WORDS[filter.type]} only`]),
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

// Newest first, a rule naming the day above each day's entries, the window kept on the focused
// entry. `isExpanded` opens that entry under its row; the split tier shows it beside the list.
function timeline(view: View, ledger: Ledger, shown: readonly number[], current: number, room: number, list: { width: number; isExpanded: boolean }): Drawn {
  const { Box } = view.kit;
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
  const open = items[current];
  const budget = Math.min(room - 2, (view.isInline ? INLINE_SNIPPET_ROWS : DOCK_SNIPPET_ROWS) + COMMAND_ROWS + 2);
  const expanded =
    list.isExpanded && open !== undefined
      ? detail(view, open.entry, list.width - DETAIL_INDENT, budget, !view.isInline || fitCommand(view, open.entry, layout).isCut)
      : [];
  const expandedRows = expanded.reduce((sum, block) => sum + block.height, 0);
  const heights = items.map((_, position) => 1 + (opensDay[position] === true ? 1 : 0) + (position === current ? expandedRows : 0));
  const placed = placeEntries(heights, opensDay, first, current, room);
  first = placed.start;
  laid = { shown, perPage: Math.max(1, placed.end - placed.start) };

  const elements: RenderElement[] = [];
  let height = 0;
  for (let position = placed.start; position < placed.end; position += 1) {
    const item = items[position];
    if (item === undefined) continue;
    if (position === placed.start || opensDay[position] === true) {
      elements.push(line(view, rule(list.width, view.g, view.isAscii, dayLabel(item.entry.at)), list.width));
      height += 1;
    }
    elements.push(entryRow(view, item.entry, item.index, layout, position === current));
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

// A line cut into rows of at most `room` cells at its last space, or mid-word where a word is
// longer than a row, so a wrapped command or output keeps every character.
function wrapLine(line: string, room: number): string[] {
  const rows: string[] = [];
  let rest = line;
  while (displayWidth(rest) > room) {
    const head = fitEnd(rest, room, "");
    const space = head.lastIndexOf(" ");
    const cut = space > 0 ? space + 1 : Math.max(1, head.length);
    rows.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut);
  }
  return [...rows, rest];
}

const wrapCode = (text: string, room: number): string[] =>
  text
    .replace(/\s+$/, "")
    .split("\n")
    .flatMap((line) => wrapLine(line.replaceAll("\t", "  "), room));

// A final verification proves the plan whose hash it carries; one without a hash proves any plan.
function planLine(view: View, entry: Entry, plan: Ledger["plan"]): Piece[] {
  if (entry.planSha === "") return [{ text: "Proves any plan: it carries no plan hash", color: TONE_KEYS.muted }];
  if (plan === null || !("sha" in plan)) return [{ text: "For a plan this session no longer has bound", color: TONE_KEYS.muted }];
  if (entry.planSha === plan.sha) return [{ text: `${view.g.check} `, color: TONE_KEYS.ok }, { text: `For ${plan.name} as it is now`, color: TONE_KEYS.muted }];
  return [{ text: `${view.g.warn} `, color: TONE_KEYS.warn }, { text: `For an earlier version of ${plan.name}`, color: TONE_KEYS.muted }];
}

const LABELLED_ROWS = 10;
const CARD_COMMAND_ROWS = 6;

/**
 * The focused run in full, in at most `budget` rows: its exit code, when and by whom, the plan a
 * final verification covers, then its command and its output, both wrapped rather than cut. With
 * room, each part has a label and a blank row before it.
 */
function cardBlocks(view: View, entry: Entry, plan: Ledger["plan"], room: number, budget: number): Block[] {
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
  const blocks: Block[] = lead.map((pieces) => ({ element: line(view, pieces, room), height: 1 }));
  let left = budget - lead.length;
  const commandRows = wrapCode(command.text, room);
  const outputRows = output.text.trim() === "" ? [] : wrapCode(output.text, room);
  const isLabelled = left >= LABELLED_ROWS;
  const section = (label: string) => {
    if (!isLabelled) return;
    blocks.push({ element: Text({ children: [" "] }), height: 1 }, { element: Text({ color: muted, children: [label] }), height: 1 });
    left -= 2;
  };
  section("Command");
  const shownCommand = commandRows.slice(0, Math.max(1, Math.min(CARD_COMMAND_ROWS, left - (isLabelled ? 3 : 1))));
  const lastCommand = shownCommand.length < commandRows.length ? shownCommand.length - 1 : -1;
  const commandSource = shownCommand.map((row, at) => (at === lastCommand ? fitEnd(`${row}${view.g.ellipsis}`, room, view.g.ellipsis) : row)).join("\n");
  blocks.push({ element: CodeBlock(view.kit, { source: commandSource, language: "bash" }), height: shownCommand.length });
  left -= shownCommand.length;
  section("Output");
  if (outputRows.length === 0) {
    blocks.push({ element: Text({ dimColor: true, children: [fitEnd("No output was logged with this run.", room, view.g.ellipsis)] }), height: 1 });
    return blocks;
  }
  const fits = outputRows.length <= left;
  const shown = outputRows.slice(0, Math.max(1, fits ? left : left - 1));
  blocks.push({ element: CodeBlock(view.kit, { source: shown.join("\n") }), height: shown.length });
  const more = outputRows.length - shown.length;
  if (more > 0) blocks.push({ element: Text({ dimColor: true, children: [fitEnd(`${view.g.ellipsis} ${more} more line${more === 1 ? "" : "s"}`, room, view.g.ellipsis)] }), height: 1 });
  return blocks;
}

function detailCard(view: View, entry: Entry, index: number, plan: Ledger["plan"], width: number, room: number): Drawn {
  const blocks = cardBlocks(view, entry, plan, width - 4, room - 3);
  const isPass = entry.exitCode === 0;
  const name = entry.type === "final_verification" ? "Final verification" : `${TYPE_WORDS[entry.type].replace(/^./, (first) => first.toUpperCase())} run`;
  const element = Card(view.kit, {
    key: `detail-${index}`,
    title: `${isPass ? view.g.check : view.g.cross} ${name} ${isPass ? "passed" : "failed"}`,
    tone: isPass ? "ok" : "fail",
    isAscii: view.isAscii,
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
    const card = detailCard(view, entry, index, ledger.plan, view.width - listWidth - COLUMN_GAP, room);
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
  const filled = head.height + Math.max(room, body.height) + keys.length + field.length;
  // One row past the body brings the arrows and the wheel to `scroll` instead of the focus ring.
  return [head.element, ...body.elements, ...blanks(view, room - body.height), ...keys, ...field, ...blanks(view, view.rows + 1 - filled)];
};
