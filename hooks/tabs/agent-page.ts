import type { RenderElement } from "claude-code";
import { costText, type Lane, shellLanguage, STATUS_WORDS, statusMark, toolLabel } from "../../src/core/mission.ts";
import { GRID, type MascotSize } from "../../src/core/mascots.ts";
import { agentGlyph, clockOf, COLUMN_GAP, fitEnd, formatDuration, formatTokens, KEYS, oneLine, padEnd, padStart, shortType } from "../../src/core/ui-kit.ts";
import { agentKey, fitPieces, levelMark, ON_SURFACE, type Piece, piecesWidth, TONE_KEYS } from "../../src/core/visual.ts";
import { loadPage } from "../agents-tracker.ts";
import { type Host, type State, update } from "../host.ts";
import { frame, keyOf, show, stateOf } from "../mascot-player.ts";
import { keyButton, noticeRow, refocus, type View } from "../pane.ts";
import { markdownUnits, resetOffset, ScrollRegion, type Unit } from "../regions.ts";
import { Line } from "../ui.ts";

type Page = State["pages"][string];
type Call = Page["calls"][number];

const BACK = "b";
const COPY = "c";
const DURATION_CELLS = 6;
const BODY_KEY = "page-body";
// Narrower than the mascot and this much text, the header keeps to its two lines.
const MIN_TEXT_CELLS = 20;
// Shorter than the mascot and the six rows below it (brief, tool calls, reply, keys), likewise.
const ROWS_BELOW = 6;
// Shorter than two identity lines, a window with a cue row to spare and the keys, the identity shares one line.
const COMPACT_ROWS = 6;
const rowsOf = (size: MascotSize): number => GRID[size].height / 2;
const shortModel = (model: string): string => model.replace(/^claude-/, "").replace(/-\d{8}$/, "");

export const openKey = (id: string): string => `open-${id}`;

const showPage = (host: Host, id: string | null): Promise<void> => update(host.state.agentPage, () => ({ id }));

export async function open(host: Host, id: string): Promise<void> {
  await loadPage(host, id);
  resetOffset(BODY_KEY);
  await showPage(host, id);
}

async function close(host: Host, id: string): Promise<void> {
  await showPage(host, null);
  refocus(host, openKey(id), "agents");
}

async function copyBrief(host: Host, brief: string): Promise<void> {
  const copied = await host.ui.copy({ text: brief });
  host.ui.toast(copied.isCopied ? "Copied the brief" : `Could not copy the brief: ${copied.reason}`);
}

function callRow(view: View, call: Call): RenderElement {
  const { g } = view;
  const mark = call.ok === null ? { glyph: g.pending, color: TONE_KEYS.muted } : levelMark(call.ok ? "ok" : "fail", g);
  const lead: Piece[] = [
    { text: `${mark.glyph} `, color: mark.color },
    { text: toolLabel(call.tool), color: ON_SURFACE, bold: true },
  ];
  const time = call.durationMs === null ? "" : call.durationMs < 1000 ? `${call.durationMs}ms` : formatDuration(call.durationMs);
  const room = Math.max(0, view.width - piecesWidth(lead) - COLUMN_GAP - DURATION_CELLS);
  const duration: Piece = { text: `${" ".repeat(COLUMN_GAP)}${padStart(time, DURATION_CELLS)}`, color: TONE_KEYS.muted };
  const language = shellLanguage(call.tool);
  if (language !== undefined && call.summary !== "" && room > 1) {
    return view.kit.Box({
      flexDirection: "row",
      children: [
        Line(view.kit, [...lead, { text: " " }]),
        view.kit.Box({ width: room - 1, children: [view.kit.Code({ source: fitEnd(call.summary, room - 1, g.ellipsis), language, wrap: "truncate-end" })] }),
        Line(view.kit, [duration]),
      ],
    });
  }
  const summary = call.summary === "" ? "" : fitEnd(` ${call.summary}`, room, g.ellipsis);
  return Line(view.kit, [...lead, { text: padEnd(summary, room) }, duration]);
}

function header(view: View, lane: Lane): { children: RenderElement[]; rows: number } {
  const { g, kit } = view;
  const mark = statusMark(lane.status, g);
  const identity: Piece[] = [
    { text: `${agentGlyph(lane.type, g)} `, color: agentKey(lane.type) },
    { text: shortType(lane.type), color: ON_SURFACE, bold: true },
    ...(lane.description === "" ? [] : [{ text: ` ${g.dot} ${oneLine(lane.description)}` }]),
  ];
  const elapsed = formatDuration((lane.endedAt ?? view.now) - lane.startedAt);
  const status = `${STATUS_WORDS[lane.status] ?? lane.status} ${g.dot} ${elapsed} ${g.dot} ${formatTokens(lane.inputTokens + lane.outputTokens)} tokens${costText(lane, g.dot)}`;
  const facts = [
    ...(lane.model === "" ? [] : [[shortModel(lane.model), ...(lane.effort === null ? [] : [String(lane.effort)])].join(` ${g.dot} `)]),
    `${lane.calls} tool call${lane.calls === 1 ? "" : "s"}`,
    [`started ${clockOf(lane.startedAt)}`, ...(lane.endedAt === null ? [] : [`ended ${clockOf(lane.endedAt)}`])].join(` ${g.dot} `),
  ];
  const size: MascotSize = facts.length <= 2 || view.rows < rowsOf("full") + ROWS_BELOW ? "mini" : "full";
  const room = view.width - GRID[size].width - COLUMN_GAP;
  const mascot = room < MIN_TEXT_CELLS || view.rows < rowsOf(size) + ROWS_BELOW ? null : kit.mascot(lane.type, stateOf(lane), keyOf(lane.id), frame(), size);
  show(mascot === null ? [] : [[lane.id, size]]);
  const width = mascot === null ? view.width : room;
  const state: Piece[] = [{ text: `${mark.glyph} `, color: mark.color }, { text: status, color: TONE_KEYS.muted }];
  if (mascot === null && view.rows < COMPACT_ROWS) {
    return { children: [Line(kit, fitPieces([...identity.slice(0, 2), { text: ` ${g.dot} ` }, ...state, ...identity.slice(2)], width, g.ellipsis))], rows: 1 };
  }
  const lines = [Line(kit, fitPieces(identity, width, g.ellipsis)), Line(kit, fitPieces(state, width, g.ellipsis))];
  if (mascot === null) return { children: lines, rows: lines.length };
  const beside = [...lines, ...facts.map((text) => Line(kit, fitPieces([{ text, color: TONE_KEYS.muted }], width, g.ellipsis)))].slice(0, rowsOf(size));
  return {
    children: [kit.Box({ key: "page-header", flexDirection: "row", columnGap: COLUMN_GAP, children: [mascot, kit.Box({ flexDirection: "column", children: beside })] })],
    rows: rowsOf(size),
  };
}

export async function view(host: Host, view: View, lane: Lane): Promise<readonly RenderElement[]> {
  const { g, kit } = view;
  const page = (await host.state.pages.get()).value?.[lane.id];
  const keys = kit.Box({
    key: "page-keys",
    flexDirection: "row",
    columnGap: COLUMN_GAP,
    children: [
      keyButton(view, BACK, "Back", () => close(host, lane.id)),
      ...(page === undefined ? [] : [keyButton(view, COPY, "Copy brief", () => copyBrief(host, page.brief))]),
      keyButton(view, KEYS.reload, "Reload", () => loadPage(host, lane.id)),
    ],
  });
  const head = header(view, lane);
  if (page === undefined) {
    return [...head.children, noticeRow(view, { kind: "empty" }, { loading: "", empty: "No page is kept for this agent; press r to load it." }), keys];
  }
  const label = (text: string): Unit => ({ element: kit.Text({ color: TONE_KEYS.muted, children: [fitEnd(text, view.width, g.ellipsis)] }), rows: 1 });
  const markdown = (key: string, value: string, none: string): Unit[] =>
    value.trim() === "" ? [label(none)] : markdownUnits(kit, value, view.width, key);
  const sections = [
    [label(page.source === "messages" ? "Brief" : `Brief ${g.dot} stored prompt, no transcript`), ...markdown("brief", page.brief, "none recorded")],
    [label(`Tool calls ${g.dot} ${page.calls.length}`), ...page.calls.map((call) => ({ element: callRow(view, call), rows: 1 }))],
    [label("Reply"), ...markdown("reply", page.reply, "none yet")],
  ];
  const height = Math.max(1, view.rows - head.rows - 1);
  const isSpare = sections.flat().reduce((sum, unit) => sum + unit.rows, 0) + sections.length - 1 <= height;
  const gap: Unit = { element: kit.Text({ children: [" "] }), rows: 1 };
  const units = sections.flatMap((section, at) => (isSpare && at > 0 ? [gap, ...section] : section));
  return [...head.children, ScrollRegion({ kit, g, key: BODY_KEY, left: 0, top: head.rows, width: view.width, height, units }), keys];
}
