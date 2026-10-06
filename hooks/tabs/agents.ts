import type { RenderElement } from "claude-code";
import {
  costText,
  excerpt,
  finishedRow,
  type Lane,
  laneColumns,
  laneRows,
  type LaneLook,
  ordered,
  summaryText,
} from "../../src/core/mission.ts";
import { mascotOf, SIZE } from "../../src/core/mascots.ts";
import { COLUMN_GAP, displayWidth, fitEnd, formatTokens, padEnd, shortType, wrapText } from "../../src/core/ui-kit.ts";
import { agentKey, ON_SURFACE, type Piece, redact, TONE_KEYS } from "../../src/core/visual.ts";
import type { Host } from "../host.ts";
import { frame, keyOf, show, stateOf } from "../mascot-player.ts";
import { keyButton, noticeRow, type TabView, type View } from "../pane.ts";
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
// A lane's head and tool rows, then its prompt, output and usage rows while details show.
const LANE_ROWS = 2;
const DETAIL_ROWS = 3;
// A mascot is SIZE columns by SIZE / 2 rows, with two columns between neighbours and its name below.
const STAGE_PITCH = SIZE + 2;
const STAGE_NAME_ROWS = 1;
// The lanes keep their own rows and the stage takes these on top, so a short body shows lanes alone.
const STAGE_SPARE_ROWS = 10;

let isDetailed = false;

const NO_LANE = { prompt: "", calls: 0, tool: null, output: "", result: "" } as const;

async function lanesOf(host: Host): Promise<Lane[]> {
  const [{ value: agents = {} }, { value: lanes = {} }] = await Promise.all([host.state.agents.get(), host.state.lanes.get()]);
  return ordered(Object.entries(agents).map(([id, row]) => ({ id, ...row, ...NO_LANE, ...lanes[id] })));
}

const count = (text: string, part: string): number => (part === "" ? 0 : text.split(part).length - 1);
const words = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const usage = (lane: Lane, dot: string) => `${words(lane.calls, "tool call")} ${dot} ${formatTokens(lane.inputTokens + lane.outputTokens)} tokens`;
const scopeOf = (lane: Lane) => `omca-agent-${lane.id}`.slice(0, 64);

type Placed = { lane: Lane; at: number; height: number };

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

const centered = (text: string, cells: number, ellipsis: string): string => {
  const name = fitEnd(text, cells, ellipsis);
  return `${" ".repeat(Math.floor((cells - displayWidth(name)) / 2))}${name}`;
};

// Running agents first, then the finished ones of the current wave, as many as the width holds; the rest are counted.
function stage(view: View, lanes: readonly Lane[]): { element: RenderElement; height: number } | undefined {
  const { kit, g } = view;
  const wave = lastWave(lanes);
  const cast = lanes.filter((lane) => (lane.endedAt === null || wave.has(lane.id)) && mascotOf(lane.type) !== undefined);
  const fit = Math.floor(view.width / STAGE_PITCH);
  const figures = cast.slice(0, fit).flatMap((lane) => {
    const mascot = kit.mascot(lane.type, stateOf(lane), keyOf(lane.id), frame());
    if (mascot === null) return [];
    const name = kit.Text({ dimColor: true, children: [centered(shortType(lane.type), SIZE, g.ellipsis)] });
    return [{ id: lane.id, figure: kit.Box({ key: `stage-${lane.id}`, flexDirection: "column", width: SIZE, children: [mascot, name] }) }];
  });
  show(figures.map(({ id }) => id));
  if (figures.length === 0) return undefined;
  const beyond = cast.length - figures.length;
  const more = beyond > 0 ? [kit.Text({ color: TONE_KEYS.muted, children: [`+${beyond}`] })] : [];
  const row = kit.Box({ flexDirection: "row", columnGap: STAGE_PITCH - SIZE, children: figures.map(({ figure }) => figure) });
  return { element: kit.Box({ key: "agents-stage", flexDirection: "column", children: [row, ...more] }), height: SIZE / 2 + STAGE_NAME_ROWS + more.length };
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
  const wrapped = prompt === "" ? [] : wrapText(prompt, inner);
  const most = Math.max(1, Math.min(PROMPT_LINES, room - CARD_FIXED_ROWS));
  const promptLines = wrapped.slice(0, most).map((line, index) =>
    index === most - 1 && wrapped.length > most ? fitEnd(`${line}${g.ellipsis}`, inner, g.ellipsis) : line,
  );
  const masks = count(prompt, g.mask) + count(output, g.mask);
  const label = (text: string) => kit.Text({ color: TONE_KEYS.muted, children: [fitEnd(text, inner, g.ellipsis)] });
  const body = (text: string) => kit.Text({ color: ON_SURFACE, wrap: "truncate-end", children: [text] });
  const lines = [
    label("Prompt"),
    ...(promptLines.length === 0 ? [label("none recorded")] : promptLines.map(body)),
    label(lane.endedAt === null ? "Last output" : "Result"),
    output === "" ? label("none yet") : body(fitEnd(output, inner, g.ellipsis)),
    label(`${usage(lane, g.dot)}${masks > 0 ? ` ${g.dot} ${words(masks, "secret")} masked` : ""}${costText(lane, g.dot)}`),
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

function detailRows(view: View, lane: Lane): RenderElement[] {
  const { g, home, kit, width } = view;
  const lead = 2 + LABEL_CELLS + COLUMN_GAP;
  const line = (label: string, text: string) =>
    Line(kit, [
      { text: `  ${padEnd(label, LABEL_CELLS)}${" ".repeat(COLUMN_GAP)}`, color: TONE_KEYS.muted },
      { text: fitEnd(text === "" ? "none yet" : text, Math.max(0, width - lead), g.ellipsis), color: TONE_KEYS.muted },
    ]);
  return [
    line("prompt", excerpt(redact(lane.prompt, home, g.mask).text, width, g.ellipsis)),
    line("output", redact(lane.output, home, g.mask).text),
    line("usage", `${usage(lane, g.dot)}${costText(lane, g.dot)}`),
  ];
}

// The status glyph, then the `named` pieces that make the Button, then the facts, which stay text.
function openRow(view: View, host: Host, lane: Lane, key: string, pieces: readonly Piece[], named: number): RenderElement {
  const { kit } = view;
  const [mark, ...rest] = pieces;
  return kit.Box({
    key,
    flexDirection: "row",
    hover: { backgroundColor: TONE_KEYS.focus },
    children: [
      Pieces(kit, mark === undefined ? [] : [mark]),
      kit.Button({
        key: page.openKey(lane.id),
        label: rest.slice(0, named).map((piece) => piece.text).join(""),
        plain: true,
        ...(lane.endedAt === null ? {} : { dimColor: true }),
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
    show([]);
    return [noticeRow(view, { kind: "empty" }, { loading: "", empty: "No subagent has run in this session yet." })];
  }
  const open = (await host.state.agentPage.get()).value?.id;
  const shownLane = lanes.find((lane) => lane.id === open);
  if (shownLane !== undefined) return page.view(host, view, shownLane);
  const { kit } = view;
  const look: LaneLook = { width: view.width, g: view.g, ascii: view.isAscii, now: view.now, columns: laneColumns(lanes, view.width) };
  const running = lanes.filter((lane) => lane.endedAt === null);
  const finished = lanes.filter((lane) => lane.endedAt !== null);
  const laneHeight = LANE_ROWS + (isDetailed ? DETAIL_ROWS : 0);
  const lanesRows = running.length * laneHeight + finished.length + 1;
  const staged = !view.isAscii && view.rows >= lanesRows + STAGE_SPARE_ROWS ? stage(view, lanes) : undefined;
  if (staged === undefined) show([]);
  const stageHeight = staged?.height ?? 0;
  let left = Math.max(laneHeight, view.rows - 1 - stageHeight);
  const shown: RenderElement[] = [];
  const placed: Placed[] = [];
  let at = stageHeight;
  let hidden = { running: 0, finished: 0 };
  const row = (key: string, pieces: Piece[]) => Row(kit, { key, pieces });
  const scoped = (lane: Lane, children: RenderElement[]) =>
    kit.Box({ key: `agent-${lane.id}`, flexDirection: "column", hover: { scope: scopeOf(lane) }, children });
  for (const [index, lane] of running.entries()) {
    const isLast = index === running.length - 1 && finished.length === 0;
    if (left < laneHeight + (isLast ? 0 : 1)) {
      hidden = { ...hidden, running: running.length - index };
      break;
    }
    const [head = [], tools = []] = laneRows(lane, look, view.home);
    shown.push(scoped(lane, [openRow(view, host, lane, `lane-${lane.id}`, head, 2), row(`tools-${lane.id}`, tools)]));
    placed.push({ lane, at, height: LANE_ROWS });
    if (isDetailed) shown.push(...detailRows(view, lane));
    at += laneHeight;
    left -= laneHeight;
  }
  for (const [index, lane] of finished.entries()) {
    const isLast = index === finished.length - 1;
    if (hidden.running > 0 || left < (isLast ? 1 : 2)) {
      hidden = { ...hidden, finished: finished.length - index };
      break;
    }
    shown.push(scoped(lane, [openRow(view, host, lane, `done-${lane.id}`, finishedRow(lane, look, view.home), 1)]));
    placed.push({ lane, at, height: 1 });
    at += 1;
    left -= 1;
  }
  const more = [
    ...(hidden.running > 0 ? [`${hidden.running} more running`] : []),
    ...(hidden.finished > 0 ? [`${hidden.finished} more finished`] : []),
  ].join(` ${view.g.dot} `);
  const moreRows = more === "" ? [] : [kit.Text({ color: TONE_KEYS.muted, children: [fitEnd(`${view.g.ellipsis} ${more}`, view.width, view.g.ellipsis)] })];
  const end = at + moreRows.length + 1;
  return [
    ...(staged === undefined ? [] : [staged.element]),
    ...shown,
    ...moreRows,
    footer(view, host, lanes),
    kit.Box({ key: "agent-cards", flexDirection: "column", children: placed.map((one) => card(view, one, end)) }),
  ];
};
