import type { RenderElement } from "claude-code";
import { inlineMarkdown, markdownPieces } from "../../src/core/markdown.ts";
import {
  type Block,
  costText,
  finishedRow,
  fitLines,
  hasUsage,
  type Lane,
  laneBlock,
  laneColumns,
  laneRows,
  type LaneLook,
  marksAfter,
  ordered,
  shellLanguage,
  stateWord,
  summaryText,
  toolParts,
} from "../../src/core/mission.ts";
import { GRID, type MascotSize } from "../../src/core/mascots.ts";
import { agentGlyph, COLUMN_GAP, displayWidth, fitEnd, formatTokens, padEnd, shortType } from "../../src/core/ui-kit.ts";
import { agentKey, fitPieces, ON_SURFACE, type Piece, piecesWidth, redact, TONE_KEYS, wrapPieces } from "../../src/core/visual.ts";
import type { Input } from "../dispatch.ts";
import type { Host } from "../host.ts";
import { frame, keyOf, show, stateOf } from "../mascot-player.ts";
import { blanks, keyButton, noticeRow, refocus, type TabView, type View } from "../pane.ts";
import { Line, Pieces, Row, ScopedCard } from "../ui.ts";
import * as page from "./agent-page.ts";

const PROMPT_LINES = 3;
// The card sits two cells in from the lane and draws a border and one cell of padding a side.
const CARD_LEFT = 2;
const CARD_CHROME = 4;
// Border, title, the two labels, the output line and the count line, around the prompt lines.
const CARD_FIXED_ROWS = 7;
const DETAILS_KEY = "d";
const LABEL_CELLS = 6;
// A compact lane's head and tool rows; its prompt, output and usage rows follow while details show.
const LANE_ROWS = 2;
// A relaxed lane is its mini (a one-cell glyph in ASCII), one column in and two before its rows,
// with a blank row between it and the next block of its group; narrower than this much text, or
// shorter than every running lane's rows, the tab draws the compact lanes.
const MINI_LEFT = 1;
const MINI_COLUMNS = GRID.mini.width;
const ASCII_GUTTER = 1;
const MINI_GAP = 2;
const BLOCK_ROWS = GRID.mini.height / 2;
const MIN_BLOCK_TEXT = 30;
// Spare rows grow every block's task, then its result, then its details prompt, a line at a time.
const GROWTH = [
  ["task", 2],
  ["result", 2],
  ["prompt", 2],
  ["prompt", 3],
] as const;

type Wraps = { task: number; result: number; prompt: number };
const FLAT: Wraps = { task: 1, result: 1, prompt: 1 };

let isDetailed = false;
// The first lane in view, and the lane whose control holds the ring. While lanes are hidden, the
// latest drawing's lanes, its last first lane and where a window from a lane ends; none otherwise.
let first = 0;
let cursor: string | undefined;
let laid: { ids: readonly string[]; max: number; stop: number; windowEnd: (from: number) => number } | undefined;

const NO_LANE = { prompt: "", calls: 0, tool: null, output: "", result: "" } as const;

async function lanesOf(host: Host): Promise<Lane[]> {
  const [{ value: agents = {} }, { value: lanes = {} }] = await Promise.all([host.state.agents.get(), host.state.lanes.get()]);
  return ordered(Object.entries(agents).map(([id, row]) => ({ id, ...row, ...NO_LANE, ...lanes[id] })));
}

const count = (text: string, part: string): number => (part === "" ? 0 : text.split(part).length - 1);
const words = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const usage = (lane: Lane, dot: string) =>
  `${words(lane.calls, "tool call")}${hasUsage(lane) ? ` ${dot} ${formatTokens(lane.inputTokens + lane.outputTokens)} tokens` : ""}`;
const costOf = (lane: Lane, dot: string) => (hasUsage(lane) ? costText(lane, dot) : "");
const scopeOf = (lane: Lane) => `omca-agent-${lane.id}`.slice(0, 64);

type Placed = { lane: Lane; at: number; height: number };
// What a lane takes in the list: `lead` is the blank row between it and the block above, or the Finished label; then
// `rows`, the last `detail` of them shed first; `cardRows` is the height its hover card clears. `draw` keeps `keep` detail rows.
type Item = {
  lane: Lane;
  lead: "blank" | "label" | null;
  rows: number;
  detail: number;
  cardRows: number;
  draw: (keep: number, isFirst: boolean) => RenderElement[];
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** A wheel tick moves the first lane in view; false while every lane shows or the agent page is open. */
export function scroll(host: Host, e: Input<"ui.scroll">): boolean {
  if (laid === undefined) return false;
  if (e.pointer !== undefined) {
    first = clamp(first + e.by, 0, laid.max);
    host.ui.invalidate();
    return true;
  }
  // A key: an arrow steps the ring a lane, a page key a window of lanes, Home and End to the ends, and the window follows.
  const { ids, max, stop, windowEnd } = laid;
  const at = cursor === undefined ? -1 : ids.indexOf(cursor);
  const from = at >= first && at < stop ? at : e.by > 0 ? first - 1 : stop;
  const isPage = Math.abs(e.by) === e.bodyRows;
  const isEnd = !isPage && Math.abs(e.by) === e.contentRows;
  const to = isEnd ? (e.by > 0 ? ids.length - 1 : 0) : clamp(from + Math.sign(e.by) * (isPage ? stop - first : 1), 0, ids.length - 1);
  if (to < first) first = to;
  while (to >= windowEnd(first) && first < max) first += 1;
  cursor = ids[to];
  host.ui.invalidate();
  if (cursor !== undefined) refocus(host, page.openKey(cursor), "agents");
  return true;
}

/** Notes the lane whose open control takes the ring, so a key steps on from it. */
export function focus(e: Input<"ui.focus">): void {
  cursor = e.element?.startsWith("open-") ? e.element.slice("open-".length) : undefined;
}

// The agents that ran together: a lane joins the latest wave while one in it still runs or ended after the lane began.
function lastWave(lanes: readonly Lane[]): Set<string> {
  let wave: Lane[] = [];
  let until = Number.NEGATIVE_INFINITY;
  for (const lane of lanes.toSorted((a, b) => a.startedAt - b.startedAt)) {
    if (lane.startedAt > until) wave = [];
    wave.push(lane);
    until = Math.max(until, lane.endedAt ?? (lane.status === "running" ? Number.POSITIVE_INFINITY : lane.startedAt));
  }
  return new Set(wave.map((lane) => lane.id));
}

// Below its lane where the body has the rows, above it where it does not, else pinned to the
// body's top or bottom; `end` is the body row the cards' zero-height parent sits on.
function card(view: View, { lane, at, height }: Placed, end: number): RenderElement {
  const { kit, g, home } = view;
  const width = Math.max(CARD_CHROME + 1, view.width - CARD_LEFT);
  const inner = width - CARD_CHROME;
  const prompt = redact(lane.prompt, home, g.mask).text;
  const output = redact(lane.endedAt === null ? lane.output : lane.result || lane.output, home, g.mask).text;
  const room = Math.max(view.rows, end);
  const wrapped = wrapPieces(markdownPieces(prompt, { color: ON_SURFACE }), inner);
  const most = Math.max(1, Math.min(PROMPT_LINES, room - CARD_FIXED_ROWS));
  const promptLines = wrapped.slice(0, most).map((line, index) =>
    index === most - 1 && wrapped.length > most ? fitPieces([...line, { text: g.ellipsis, color: ON_SURFACE }], inner, g.ellipsis) : line,
  );
  const said = inlineMarkdown(output, { color: ON_SURFACE });
  const masks = count(prompt, g.mask) + count(output, g.mask);
  const label = (text: string) => kit.Text({ color: TONE_KEYS.muted, children: [fitEnd(text, inner, g.ellipsis)] });
  const lines = [
    label("Prompt"),
    ...(promptLines.length === 0 ? [label("none recorded")] : promptLines.map((line) => Line(kit, line))),
    label(lane.endedAt === null ? "Last output" : "Result"),
    said.length === 0 ? label("none yet") : Line(kit, fitPieces(said, inner, g.ellipsis)),
    label(`${usage(lane, g.dot)}${masks > 0 ? ` ${g.dot} ${words(masks, "secret")} masked` : ""}${costOf(lane, g.dot)}`),
  ];
  const rows = CARD_FIXED_ROWS + Math.max(1, promptLines.length);
  const below = at + height;
  const top = below + rows <= room ? below : at - rows >= 0 ? at - rows : Math.max(0, room - rows);
  return ScopedCard(kit, {
    key: `card-${lane.id}`,
    scope: scopeOf(lane),
    title: fitEnd(`${shortType(lane.type)} ${g.dot} ${lane.description}`, inner, g.ellipsis),
    tone: agentKey(lane.type),
    isAscii: view.isAscii,
    lines,
    top: top - end,
    left: CARD_LEFT,
    width,
  });
}

const promptOf = (view: View, lane: Lane): Piece[] => markdownPieces(redact(lane.prompt, view.home, view.g.mask).text, { color: TONE_KEYS.muted });

// The prompt in up to `promptLines` lines, then the output and usage rows; a label sits `indent` cells in.
function detailRows(view: View, lane: Lane, width: number, indent: number, promptLines: number): { prompt: RenderElement[]; rest: RenderElement[] } {
  const { g, home, kit } = view;
  const room = Math.max(0, width - indent - LABEL_CELLS - COLUMN_GAP);
  const muted = { color: TONE_KEYS.muted } as const;
  const lines = (label: string, pieces: Piece[], most: number) =>
    fitLines(pieces.length === 0 ? [{ text: "none yet", ...muted }] : pieces, room, most, g.ellipsis).map((line, index) =>
      Line(kit, [{ text: `${" ".repeat(indent)}${padEnd(index === 0 ? label : "", LABEL_CELLS)}${" ".repeat(COLUMN_GAP)}`, ...muted }, ...line]),
    );
  return {
    prompt: lines("prompt", promptOf(view, lane), promptLines),
    rest: [
      ...lines("output", inlineMarkdown(redact(lane.output, home, g.mask).text, muted), 1),
      ...lines("usage", [{ text: `${usage(lane, g.dot)}${costOf(lane, g.dot)}`, ...muted }], 1),
    ],
  };
}

// The `lead` pieces (a status glyph, or none), then the `named` pieces that make the Button, then the facts, which stay text.
// The first lane in view holds the ring when the tab opens.
function openRow(view: View, host: Host, lane: Lane, key: string, pieces: readonly Piece[], named: number, lead: number, isFirst: boolean): RenderElement {
  const { kit } = view;
  const marks = pieces.slice(0, lead);
  const rest = pieces.slice(lead);
  return kit.Box({
    key,
    flexDirection: "row",
    hover: { backgroundColor: TONE_KEYS.focus },
    children: [
      ...(marks.length === 0 ? [] : [Pieces(kit, marks)]),
      kit.Button({
        key: page.openKey(lane.id),
        label: rest.slice(0, named).map((piece) => piece.text).join(""),
        plain: true,
        ...(lane.endedAt === null ? {} : { dimColor: true }),
        ...(isFirst ? { autoFocus: true } : {}),
        onPress: view.press(() => page.open(host, lane.id)),
      }),
      Pieces(kit, rest.slice(named)),
    ],
  });
}

// The key and, beside it, how many agents run and finished: the status sits at the bottom, as on the Evidence tab.
function footer(view: View, host: Host, lanes: readonly Lane[]): RenderElement {
  const label = isDetailed ? "Hide details" : "Details";
  const button = keyButton(view, DETAILS_KEY, label, () => {
    isDetailed = !isDetailed;
    host.ui.invalidate();
  });
  const room = view.width - displayWidth(`${DETAILS_KEY}: ${label}`) - COLUMN_GAP;
  const status = summaryText(lanes, view.g, room);
  return view.kit.Box({
    key: "agents-keys",
    flexDirection: "row",
    columnGap: COLUMN_GAP,
    children: status === "" ? [button] : [button, view.kit.Text({ dimColor: true, children: [status] })],
  });
}

export const view: TabView = async (host, view) => {
  const lanes = await lanesOf(host);
  if (lanes.length === 0) {
    laid = undefined;
    show([]);
    return [
      noticeRow(view, { kind: "empty" }, { loading: "", empty: "No subagent has run in this session yet." }),
      view.kit.Text({ color: TONE_KEYS.muted, children: ["Each subagent gets a lane here. Enter or a click opens its page."] }),
    ];
  }
  const open = (await host.state.agentPage.get()).value?.id;
  const shownLane = lanes.find((lane) => lane.id === open);
  if (shownLane !== undefined) {
    laid = undefined;
    return page.view(host, view, shownLane);
  }
  const { kit, g } = view;
  const running = lanes.filter((lane) => lane.endedAt === null);
  const finished = lanes.filter((lane) => lane.endedAt !== null);
  const gutter = view.isAscii ? ASCII_GUTTER : MINI_COLUMNS;
  const textWidth = view.width - MINI_LEFT - gutter - MINI_GAP;
  const detailsOf = (lane: Lane) => (isDetailed ? (lane.endedAt === null ? 2 : 1) : 0);
  const wave = lastWave(lanes);
  const recent = finished.filter((lane) => wave.has(lane.id));
  // A relaxed tab with `blocks` of the latest wave's finished agents as blocks: every running block,
  // the Finished label, those blocks, `others` one-line rows for the rest (two keep the label and a
  // row under it) and the keys row. Blocks of one group are a blank row apart, and no more.
  const relaxedRows = (blocks: number, others = 2) => {
    const heights = [...running, ...recent.slice(0, blocks)].map((lane) => BLOCK_ROWS + detailsOf(lane));
    const apart = Math.max(0, running.length - 1) + Math.max(0, blocks - 1);
    return heights.reduce((sum, height) => sum + height, 0) + apart + (finished.length > 0 ? 1 : 0) + Math.min(finished.length - blocks, others) + 1;
  };
  const canRelax = textWidth >= MIN_BLOCK_TEXT && view.rows >= relaxedRows(0);
  // The latest wave's finished agents keep their blocks, newest first, as far as the rows hold, so a
  // wave that just ended still shows its mascots.
  const finishedBlocks = canRelax ? (Array.from({ length: recent.length }, (_, n) => recent.length - n).find((n) => view.rows >= relaxedRows(n)) ?? 0) : 0;
  const isRelaxed = canRelax && running.length + finishedBlocks > 0;
  const blocked = new Set(recent.slice(0, finishedBlocks).map((lane) => lane.id));
  const blockLanes = isRelaxed ? [...running, ...recent.slice(0, finishedBlocks)] : [];
  const look: LaneLook = { width: isRelaxed ? textWidth : view.width, g, ascii: view.isAscii, now: view.now, columns: laneColumns(lanes, view.width) };
  const word = Math.max(0, ...blockLanes.map((lane) => displayWidth(stateWord(lane))));
  // Rows left over once every block is drawn go to wrapping, when each block could gain one at least.
  const spare = view.rows - relaxedRows(finishedBlocks, Number.POSITIVE_INFINITY);
  const wraps = new Map<string, Wraps>(blockLanes.map((lane) => [lane.id, { ...FLAT }]));
  if (spare >= blockLanes.length) {
    const most = new Map<string, Wraps>(
      blockLanes.map((lane) => {
        const full = laneBlock(lane, look, view.home, { task: 2, result: 2 });
        const prompt = isDetailed ? wrapPieces(promptOf(view, lane), textWidth - LABEL_CELLS - COLUMN_GAP).length : 1;
        return [lane.id, { task: full.task.length, result: full.body.length, prompt: clamp(prompt, 1, PROMPT_LINES) }];
      }),
    );
    let left = spare;
    for (const [part, to] of GROWTH) {
      const grown = blockLanes.filter((lane) => (most.get(lane.id)?.[part] ?? 1) >= to);
      if (grown.length > left) break;
      for (const lane of grown) {
        const one = wraps.get(lane.id);
        if (one !== undefined) one[part] = to;
      }
      left -= grown.length;
    }
  }
  const shown: RenderElement[] = [];
  const placed: Placed[] = [];
  const minis: [string, MascotSize][] = [];
  const row = (key: string, pieces: Piece[]) => Row(kit, { key, pieces });
  // A running shell call's command draws as code in the cells the row keeps for it, the call count still at the edge.
  const toolLine = (lane: Lane, pieces: Piece[], indent: string): RenderElement => {
    const key = `tools-${lane.id}`;
    const language = lane.tool === null ? undefined : shellLanguage(lane.tool.name);
    const parts = language === undefined ? undefined : toolParts(lane, look, view.home, indent);
    if (language === undefined || parts === undefined || parts.detail === "" || parts.room <= 0) return row(key, pieces);
    const used = piecesWidth(parts.lead) + 1 + parts.room;
    return kit.Box({
      key,
      flexDirection: "row",
      hover: { backgroundColor: TONE_KEYS.focus },
      children: [
        Pieces(kit, [...parts.lead, { text: " " }]),
        kit.Box({ width: parts.room, children: [kit.Code({ source: fitEnd(parts.detail, parts.room, g.ellipsis), language, wrap: "truncate-end" })] }),
        ...(parts.marks.length === 0 ? [] : [Pieces(kit, marksAfter(parts.marks, used, look.width))]),
      ],
    });
  };
  const scoped = (lane: Lane, children: RenderElement[]) =>
    kit.Box({ key: `agent-${lane.id}`, flexDirection: "column", hover: { scope: scopeOf(lane) }, children });
  const block = (lane: Lane, key: string, parts: Block, details: RenderElement[], isFirst: boolean): RenderElement => {
    const mini = kit.mascot(lane.type, stateOf(lane), keyOf(lane.id), frame(), "mini");
    if (mini !== null) minis.push([lane.id, "mini"]);
    const icon = kit.Box({ width: gutter, children: [mini ?? kit.Text({ color: agentKey(lane.type), children: [agentGlyph(lane.type, g)] })] });
    const rows = [
      openRow(view, host, lane, key, parts.head, 1, 0, isFirst),
      ...parts.task.map((line) => Line(kit, line)),
      ...(lane.endedAt === null ? [toolLine(lane, parts.body[0] ?? [], "")] : parts.body.map((line) => Line(kit, line))),
      Line(kit, parts.usage),
      ...details,
    ];
    return kit.Box({ flexDirection: "row", columnGap: MINI_GAP, paddingLeft: MINI_LEFT, children: [icon, kit.Box({ flexDirection: "column", children: rows })] });
  };
  const blockItem = (lane: Lane, key: string, lead: Item["lead"]): Item => {
    const wrap = wraps.get(lane.id) ?? FLAT;
    const parts = laneBlock(lane, look, view.home, { word, task: wrap.task, result: wrap.result });
    const shownDetails = isDetailed ? detailRows(view, lane, textWidth, 0, wrap.prompt) : { prompt: [], rest: [] };
    const details = lane.endedAt === null ? [...shownDetails.prompt, ...shownDetails.rest.slice(0, 1)] : shownDetails.prompt;
    const rows = 2 + parts.task.length + parts.body.length + details.length;
    return {
      lane,
      lead,
      rows,
      detail: details.length,
      cardRows: rows,
      draw: (keep, isFirst) => [scoped(lane, [block(lane, key, parts, details.slice(0, keep), isFirst)])],
    };
  };
  const compactItem = (lane: Lane): Item => {
    const shownDetails = isDetailed ? detailRows(view, lane, view.width, 2, 1) : { prompt: [], rest: [] };
    const details = [...shownDetails.prompt, ...shownDetails.rest];
    return {
      lane,
      lead: null,
      rows: LANE_ROWS + details.length,
      detail: details.length,
      cardRows: LANE_ROWS,
      draw: (keep, isFirst) => {
        const [head = [], tools = []] = laneRows(lane, look, view.home);
        return [scoped(lane, [openRow(view, host, lane, `lane-${lane.id}`, head, 2, 1, isFirst), toolLine(lane, tools, "  ")]), ...details.slice(0, keep)];
      },
    };
  };
  const lineItem = (lane: Lane): Item => ({
    lane,
    lead: null,
    rows: 1,
    detail: 0,
    cardRows: 1,
    draw: (_keep, isFirst) => [scoped(lane, [openRow(view, host, lane, `done-${lane.id}`, finishedRow(lane, { ...look, width: view.width }, view.home), 1, 1, isFirst)])],
  });
  const items: Item[] = [
    ...running.map((lane, n) => (isRelaxed ? blockItem(lane, `lane-${lane.id}`, n > 0 ? "blank" : null) : compactItem(lane))),
    ...finished.map((lane, n) => (blocked.has(lane.id) ? blockItem(lane, `done-${lane.id}`, n > 0 ? "blank" : null) : lineItem(lane))),
  ];
  const label = items[running.length];
  if (isRelaxed && label !== undefined) label.lead = "label";
  // Compact lanes spend spare rows on a blank between running lanes before leaving them at the bottom.
  const drawnRows = items.reduce((sum, item) => sum + item.rows + (item.lead === null ? 0 : 1), 0);
  if (!isRelaxed && drawnRows + running.length - 1 <= view.rows - 1) items.slice(1, running.length).forEach((item) => (item.lead = "blank"));
  // Whole lanes from `first`, with a row for each cue and the keys row kept; a blank row above the
  // window's first lane is left out. One lane shows even where it overfills, shedding its detail rows.
  const room = Math.max(0, view.rows - 1);
  const heightAt = (index: number, from: number): number => {
    const item = items[index];
    return item === undefined ? 0 : item.rows + (item.lead === "label" || (item.lead === "blank" && index > from) ? 1 : 0);
  };
  const windowEnd = (from: number): number => {
    const cues = from > 0 ? 1 : 0;
    let rest = 0;
    for (let index = from; index < items.length; index += 1) rest += heightAt(index, from);
    if (rest <= room - cues) return items.length;
    let used = 0;
    let stop = from;
    while (stop < items.length && used + heightAt(stop, from) <= room - cues - 1) {
      used += heightAt(stop, from);
      stop += 1;
    }
    return Math.max(stop, from + 1);
  };
  const max = items.findIndex((_, from) => windowEnd(from) === items.length);
  first = clamp(first, 0, max);
  const stop = windowEnd(first);
  const isCut = first > 0 || stop < items.length;
  laid = isCut ? { ids: items.map((item) => item.lane.id), max, stop, windowEnd } : undefined;
  const cue = (text: string) => kit.Text({ color: TONE_KEYS.muted, children: [fitEnd(text, view.width, g.ellipsis)] });
  const above = first > 0 ? [cue(`${g.up} ${first} more`)] : [];
  const only = stop - first === 1 ? items[first] : undefined;
  const spill = only === undefined ? 0 : heightAt(first, first) - (room - above.length - (stop < items.length ? 1 : 0));
  let at = above.length;
  for (const [n, item] of items.slice(first, stop).entries()) {
    const lead = heightAt(first + n, first) - item.rows;
    if (lead > 0) {
      shown.push(item.lead === "label" ? kit.Text({ color: TONE_KEYS.muted, children: ["Finished"] }) : kit.Text({ children: [" "] }));
      at += lead;
    }
    const cut = item === only ? clamp(spill, 0, item.detail) : 0;
    placed.push({ lane: item.lane, at, height: Math.min(item.cardRows, item.rows - cut) });
    shown.push(...item.draw(item.detail - cut, n === 0));
    at += item.rows - cut;
  }
  show(minis);
  const below = stop < items.length ? [cue(`${g.down} ${items.length - stop} more`)] : [];
  const end = at + below.length + 1;
  return [
    ...above,
    ...shown,
    ...below,
    footer(view, host, lanes),
    kit.Box({ key: "agent-cards", flexDirection: "column", children: placed.map((one) => card(view, one, end)) }),
    ...(isCut ? blanks(view, view.rows + 1 - end) : []),
  ];
};
