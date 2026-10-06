import type { RenderElement } from "claude-code";
import { costText, type Lane, STATUS_WORDS, statusMark, toolLabel } from "../../src/core/mission.ts";
import { SIZE } from "../../src/core/mascots.ts";
import { agentGlyph, COLUMN_GAP, fitEnd, formatDuration, formatTokens, KEYS, oneLine, padEnd, padStart, shortType } from "../../src/core/ui-kit.ts";
import { agentKey, fitPieces, levelMark, ON_SURFACE, type Piece, piecesWidth, TONE_KEYS } from "../../src/core/visual.ts";
import { loadPage } from "../agents-tracker.ts";
import { type Host, type State, update } from "../host.ts";
import { frame, keyOf, show, stateOf } from "../mascot-player.ts";
import { keyButton, noticeRow, refocus, type View } from "../pane.ts";
import { Line } from "../ui.ts";

type Page = State["pages"][string];
type Call = Page["calls"][number];

const BACK = "b";
const COPY = "c";
const DURATION_CELLS = 6;
// Narrower than the mascot and this much text, the header keeps to its two lines.
const MIN_TEXT_CELLS = 20;
// Shorter than the mascot and the six rows below it (brief, tool calls, reply, keys), likewise.
const MIN_PAGE_ROWS = SIZE / 2 + 6;

export const openKey = (id: string): string => `open-${id}`;

const showPage = (host: Host, id: string | null): Promise<void> => update(host.state.agentPage, () => ({ id }));

export async function open(host: Host, id: string): Promise<void> {
  await loadPage(host, id);
  await showPage(host, id);
  refocus(host, BACK, "agents");
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
  const summary = call.summary === "" ? "" : fitEnd(` ${call.summary}`, room, g.ellipsis);
  return Line(view.kit, [
    ...lead,
    { text: padEnd(summary, room) },
    { text: `${" ".repeat(COLUMN_GAP)}${padStart(time, DURATION_CELLS)}`, color: TONE_KEYS.muted },
  ]);
}

function header(view: View, lane: Lane): RenderElement[] {
  const { g, kit } = view;
  const room = view.width - SIZE - COLUMN_GAP;
  const mascot = room < MIN_TEXT_CELLS || view.rows < MIN_PAGE_ROWS ? null : kit.mascot(lane.type, stateOf(lane), keyOf(lane.id), frame());
  show(mascot === null ? [] : [lane.id]);
  const width = mascot === null ? view.width : room;
  const mark = statusMark(lane.status, g);
  const identity: Piece[] = [
    { text: `${agentGlyph(lane.type, g)} `, color: agentKey(lane.type) },
    { text: shortType(lane.type), color: ON_SURFACE, bold: true },
    ...(lane.description === "" ? [] : [{ text: ` ${g.dot} ${oneLine(lane.description)}` }]),
  ];
  const elapsed = formatDuration((lane.endedAt ?? view.now) - lane.startedAt);
  const facts = `${STATUS_WORDS[lane.status] ?? lane.status} ${g.dot} ${elapsed} ${g.dot} ${formatTokens(lane.inputTokens + lane.outputTokens)} tokens${costText(lane, g.dot)}`;
  const lines = [
    Line(kit, fitPieces(identity, width, g.ellipsis)),
    Line(kit, fitPieces([{ text: `${mark.glyph} `, color: mark.color }, { text: facts, color: TONE_KEYS.muted }], width, g.ellipsis)),
  ];
  if (mascot === null) return lines;
  return [kit.Box({ key: "page-header", flexDirection: "row", columnGap: COLUMN_GAP, children: [mascot, kit.Box({ flexDirection: "column", children: lines })] })];
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
  if (page === undefined) {
    return [...header(view, lane), noticeRow(view, { kind: "empty" }, { loading: "", empty: "No page is kept for this agent; press r to load it." }), keys];
  }
  const label = (text: string) => kit.Text({ color: TONE_KEYS.muted, children: [fitEnd(text, view.width, g.ellipsis)] });
  const text = (value: string, none: string) =>
    value === "" ? label(none) : kit.Text({ color: ON_SURFACE, wrap: "wrap", children: [value] });
  return [
    ...header(view, lane),
    label(page.source === "messages" ? "Brief" : `Brief ${g.dot} stored prompt, no transcript`),
    text(page.brief, "none recorded"),
    label(`Tool calls ${g.dot} ${page.calls.length}`),
    ...page.calls.map((call) => callRow(view, call)),
    label("Reply"),
    text(page.reply, "none yet"),
    keys,
  ];
}
