import type { RenderElement } from "claude-code";
import {
  excerpt,
  finishedRow,
  type Lane,
  laneRows,
  type LaneLook,
  legend,
  ordered,
  summaryRow,
} from "../../src/core/mission.ts";
import { displayWidth, fitEnd, shortType, wrapText } from "../../src/core/ui-kit.ts";
import { agentKey, ON_SURFACE, type Piece, redact, TONE_KEYS } from "../../src/core/visual.ts";
import type { Host } from "../host.ts";
import { keyButton, noticeRow, type TabView, type View } from "../pane.ts";
import { Line, Row, ScopedCard } from "../ui.ts";

const PROMPT_LINES = 3;
// The card sits two cells in from the lane and draws a border and one cell of padding a side.
const CARD_LEFT = 2;
const CARD_CHROME = 4;
// Border, title, the two labels, the output line and the count line, around the prompt lines.
const CARD_FIXED_ROWS = 7;
const DETAILS_KEY = "d";

let isDetailed = false;

const NO_LANE = { prompt: "", tools: [], calls: 0, tool: null, output: "", result: "" } as const;

async function lanesOf(host: Host): Promise<Lane[]> {
  const [{ value: agents = {} }, { value: lanes = {} }] = await Promise.all([host.state.agents.get(), host.state.lanes.get()]);
  return ordered(Object.entries(agents).map(([id, row]) => ({ id, ...row, ...NO_LANE, ...lanes[id] })));
}

const count = (text: string, part: string): number => (part === "" ? 0 : text.split(part).length - 1);
const scopeOf = (lane: Lane) => `omca-agent-${lane.id}`.slice(0, 64);

type Placed = { lane: Lane; at: number; height: number };

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
    label(`${lane.calls} tool call${lane.calls === 1 ? "" : "s"}${masks > 0 ? ` ${g.dot} ${masks} masked` : ""}`),
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
  const line = (label: string, text: string) =>
    Line(kit, [
      { text: `  ${label} `, color: TONE_KEYS.muted },
      { text: fitEnd(text === "" ? "none yet" : text, Math.max(0, width - 3 - displayWidth(label)), g.ellipsis), color: TONE_KEYS.muted },
    ]);
  return [
    line("prompt", excerpt(redact(lane.prompt, home, g.mask).text, width, g.ellipsis)),
    line("output", redact(lane.output, home, g.mask).text),
  ];
}

function footer(view: View, host: Host): RenderElement {
  const label = isDetailed ? "Hide details" : "Details";
  const button = keyButton(view, DETAILS_KEY, label, () => {
    isDetailed = !isDetailed;
    host.ui.invalidate();
  });
  const room = view.width - displayWidth(`${DETAILS_KEY}: ${label}`) - 3;
  const key = legend(room, view.isAscii);
  return view.kit.Box({
    key: "agents-keys",
    flexDirection: "row",
    columnGap: 3,
    children: key.length === 0 ? [button] : [button, Line(view.kit, key)],
  });
}

export const view: TabView = async (host, view) => {
  const lanes = await lanesOf(host);
  if (lanes.length === 0) {
    return [noticeRow(view, { kind: "empty" }, { loading: "", empty: "No subagent has run in this session yet." })];
  }
  const { kit } = view;
  const look: LaneLook = { width: view.width, tier: view.tier, g: view.g, ascii: view.isAscii, now: view.now };
  const running = lanes.filter((lane) => lane.endedAt === null);
  const finished = lanes.filter((lane) => lane.endedAt !== null);
  const laneHeight = 2 + (isDetailed ? 2 : 0);
  let left = Math.max(laneHeight, view.rows - 2);
  const shown: RenderElement[] = [];
  const placed: Placed[] = [];
  let at = 1;
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
    shown.push(scoped(lane, [row(`lane-${lane.id}`, head), row(`tools-${lane.id}`, tools)]));
    placed.push({ lane, at, height: 2 });
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
    shown.push(scoped(lane, [row(`done-${lane.id}`, finishedRow(lane, look, view.home))]));
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
    Line(kit, summaryRow(lanes, look)),
    ...shown,
    ...moreRows,
    footer(view, host),
    kit.Box({ key: "agent-cards", flexDirection: "column", children: placed.map((one) => card(view, one, end)) }),
  ];
};
