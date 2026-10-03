import { arrange, oneLine } from "./band-model.ts";
import { inputText } from "./tool-input.ts";
import { displayWidth, fitEnd, formatDuration, formatTokens, type Glyphs, padEnd, shortType } from "./ui-kit.ts";
import { agentKey, chip, levelMark, type Piece, redact, type ThemeKey, TONE_KEYS, type WidthTier } from "./visual.ts";

export type ToolKind = "read" | "edit" | "bash" | "mcp" | "agent" | "other";

// The semantic keys a tool kind might borrow (`ide`, `bashBorder`, `permission`) draw one color
// under custom themes such as Wallpaper, so kinds take the rainbow scale, the one set of keys
// every theme keeps apart; the glyph tells them apart without color.
const TOOL_KINDS: Readonly<Record<ToolKind, { key: ThemeKey; glyph: string; ascii: string }>> = {
  read: { key: "rainbow_blue", glyph: "○", ascii: "r" },
  edit: { key: "rainbow_violet", glyph: "✎", ascii: "e" },
  bash: { key: "rainbow_orange", glyph: "$", ascii: "$" },
  mcp: { key: "rainbow_indigo", glyph: "◇", ascii: "m" },
  agent: { key: "rainbow_green", glyph: "◆", ascii: "@" },
  other: { key: "inactive", glyph: "·", ascii: "." },
};

const KIND_ORDER: readonly ToolKind[] = ["read", "edit", "bash", "mcp", "agent"];

const KIND_OF: Readonly<Record<string, ToolKind>> = {
  Read: "read",
  Grep: "read",
  Glob: "read",
  LS: "read",
  NotebookRead: "read",
  WebFetch: "read",
  WebSearch: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Bash: "bash",
  PowerShell: "bash",
  BashOutput: "bash",
  Agent: "agent",
  Task: "agent",
  SendMessage: "agent",
};

export function toolKind(name: string): ToolKind {
  if (name.startsWith("mcp__")) return "mcp";
  return Object.hasOwn(KIND_OF, name) ? (KIND_OF[name] ?? "other") : "other";
}

/** `mcp__server__tool` as its tool's own name; every other tool as named. */
export const toolLabel = (name: string): string => (name.startsWith("mcp__") ? name.slice(name.lastIndexOf("__") + 2) : name);

const DETAIL_FIELD: Readonly<Record<string, string>> = {
  Bash: "command",
  PowerShell: "command",
  Read: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
  Grep: "pattern",
  Glob: "pattern",
  WebFetch: "url",
  WebSearch: "query",
  Agent: "description",
  Task: "description",
};

/** What a call works on, in one line: a path under `root` relative to it. Unredacted. */
export function toolDetail(name: string, input: unknown, root: string): string {
  const field = Object.hasOwn(DETAIL_FIELD, name) ? DETAIL_FIELD[name] : undefined;
  const value = oneLine(field === undefined ? "" : inputText(input, field));
  const base = root.replace(/[\\/]+$/, "");
  return base !== "" && (value.startsWith(`${base}/`) || value.startsWith(`${base}\\`)) ? value.slice(base.length + 1) : value;
}

const lines = (text: string): string[] => text.split("\n").map(oneLine).filter((line) => line !== "");
export const firstLine = (text: string): string => lines(text)[0] ?? "";
export const lastLine = (text: string): string => lines(text).at(-1) ?? "";

type Effort = "low" | "medium" | "high" | "xhigh" | "max" | number;
type Status = "running" | "answer" | "aborted" | "refusal" | "error" | "gone";

export type Lane = {
  id: string;
  type: string;
  description: string;
  model: string;
  effort: Effort | null;
  startedAt: number;
  endedAt: number | null;
  inputTokens: number;
  outputTokens: number;
  status: Status;
  prompt: string;
  tools: readonly string[];
  calls: number;
  tool: { name: string; detail: string } | null;
  output: string;
  result: string;
};

export type LaneLook = { width: number; tier: WidthTier; g: Glyphs; ascii: boolean; now: number };

const shortModel = (model: string): string => model.replace(/^claude-/, "").replace(/-\d{8}$/, "");

const SPINNER = { unicode: ["◐", "◓", "◑", "◒"], ascii: ["|", "/", "-", "\\"] } as const;
const STRIP: Readonly<Record<WidthTier, number>> = { page: 8, inline: 12, split: 24 };
// The task keeps this many cells, separator included, before the model chip gives way.
const MIN_TASK = 20;
const ELAPSED = 6;

/** One frame per second of `now`, so a lane turns only while the pane's clock ticks. */
export function spinner(now: number, ascii: boolean): string {
  const frames = ascii ? SPINNER.ascii : SPINNER.unicode;
  return frames[Math.floor(now / 1000) % frames.length] ?? "";
}

const cellsOf = (pieces: readonly Piece[]): number => pieces.reduce((sum, piece) => sum + displayWidth(piece.text), 0);

/** The last `room` calls, oldest first, one glyph each in its kind's color. */
export function strip(tools: readonly string[], room: number, ascii: boolean): Piece[] {
  const shown = room <= 0 ? [] : tools.slice(-room);
  const pieces: Piece[] = [];
  for (const name of shown) {
    const kind = TOOL_KINDS[toolKind(name)];
    const glyph = ascii ? kind.ascii : kind.glyph;
    const last = pieces.at(-1);
    if (last !== undefined && last.color === kind.key) pieces[pieces.length - 1] = { ...last, text: `${last.text}${glyph}` };
    else pieces.push({ text: glyph, color: kind.key });
  }
  return pieces;
}

type Side = { priority: number; min: number; pieces: Piece[] };

function headRow(lane: Lane, look: LaneLook): Piece[] {
  const { g, ascii, now, width } = look;
  const key = agentKey(lane.type);
  const name = shortType(lane.type);
  const identity: Piece[] = [
    { text: `${g.agent} `, color: key },
    { text: name, color: key, bold: true },
  ];
  const side = (priority: number, pieces: Piece[]): Side => ({ priority, min: cellsOf(pieces), pieces });
  const sides: Side[] = [
    { priority: 0, min: cellsOf(identity) + MIN_TASK, pieces: [] },
    side(4, [chip(shortModel(lane.model), "info", ascii)]),
    ...(lane.effort === null ? [] : [side(3, [chip(String(lane.effort), "muted", ascii)])]),
    side(2, [{ text: formatTokens(lane.inputTokens + lane.outputTokens), color: TONE_KEYS.muted }]),
    side(1, [{ text: formatDuration(now - lane.startedAt).padStart(ELAPSED), color: TONE_KEYS.active, bold: true }]),
  ];
  const kept = arrange(sides, width, 1);
  const right = kept.filter((side) => side.priority !== 0).flatMap((side) => [{ text: " " }, ...side.pieces]);
  const room = width - cellsOf(identity) - cellsOf(right);
  const task = lane.description === "" ? "" : fitEnd(` ${g.dot} ${oneLine(lane.description)}`, room, g.ellipsis);
  return [...identity, { text: padEnd(task, room) }, ...right];
}

function toolRow(lane: Lane, look: LaneLook, home: string, mask: string): Piece[] {
  const { width, tier, ascii, now, g } = look;
  const lead: Piece[] = [{ text: "  " }];
  const marks = strip(lane.tools, Math.min(STRIP[tier], Math.max(0, width - 2 - 14)), ascii);
  const spin: Piece = { text: spinner(now, ascii), color: TONE_KEYS.active };
  const pieces: Piece[] = [...lead, ...marks, ...(marks.length > 0 ? [{ text: " " }] : []), spin, { text: " " }];
  if (lane.tool === null) {
    pieces.push({ text: lane.calls === 0 ? "starting" : "thinking", color: TONE_KEYS.muted });
    return pieces;
  }
  const label = fitEnd(toolLabel(lane.tool.name), Math.max(0, width - cellsOf(pieces)), g.ellipsis);
  pieces.push({ text: label, color: TOOL_KINDS[toolKind(lane.tool.name)].key, bold: true });
  const detail = redactLine(lane.tool.detail, home, mask);
  const room = width - cellsOf(pieces) - 1;
  if (detail !== "" && room > 0) pieces.push({ text: ` ${fitEnd(detail, room, g.ellipsis)}` });
  return pieces;
}

const redactLine = (text: string, home: string, mask: string): string => redact(text, home, mask).text;

/** A running agent's lane: identity, task and the facts on the right; its tool strip below. */
export function laneRows(lane: Lane, look: LaneLook, home: string): Piece[][] {
  return [headRow(lane, look), toolRow(lane, look, home, look.g.mask)];
}

const STATUS_WORDS: Readonly<Record<Exclude<Status, "running">, string>> = {
  answer: "done",
  aborted: "stopped",
  refusal: "refused",
  error: "failed",
  gone: "ended",
};

export function statusMark(status: Status, g: Glyphs): { glyph: string; color: ThemeKey } {
  switch (status) {
    case "running":
      return { glyph: g.agent, color: TONE_KEYS.active };
    case "answer":
      return levelMark("ok", g);
    case "aborted":
    case "refusal":
      return levelMark("warn", g);
    case "error":
      return levelMark("fail", g);
    case "gone":
      return { glyph: g.pending, color: TONE_KEYS.muted };
  }
}

/** A finished agent in one dim line: status glyph, type, its result, and how long it ran. */
export function finishedRow(lane: Lane, look: LaneLook, home: string): Piece[] {
  const { g, width } = look;
  const mark = statusMark(lane.status, g);
  const word = lane.status === "running" ? "" : STATUS_WORDS[lane.status];
  const result = redactLine(lane.result, home, g.mask);
  const said = lane.status === "answer" && result !== "" ? result : result === "" ? word : `${word} ${g.dot} ${result}`;
  const duration = formatDuration((lane.endedAt ?? look.now) - lane.startedAt).padStart(ELAPSED);
  const head = `${mark.glyph} ${shortType(lane.type)}`;
  const room = width - displayWidth(head) - 1 - ELAPSED;
  const body = fitEnd(` ${g.dot} ${said}`, Math.max(0, room), g.ellipsis);
  return [
    { text: `${mark.glyph} `, color: mark.color },
    { text: `${shortType(lane.type)}${padEnd(body, Math.max(0, room))}`, color: TONE_KEYS.muted },
    { text: ` ${duration}`, color: TONE_KEYS.muted },
  ];
}

/** The tab's first row: how many run and finished, and the tokens they spent. */
export function summaryRow(lanes: readonly Lane[], look: LaneLook): Piece[] {
  const { g, width } = look;
  const running = lanes.filter((lane) => lane.endedAt === null).length;
  const tokens = lanes.reduce((sum, lane) => sum + lane.inputTokens + lane.outputTokens, 0);
  const pieces: Piece[] = [
    { text: `${g.agent} `, color: running > 0 ? TONE_KEYS.active : TONE_KEYS.muted },
    { text: `${running} running`, ...(running > 0 ? { color: TONE_KEYS.active, bold: true as const } : { color: TONE_KEYS.muted }) },
    { text: ` ${g.dot} ${lanes.length - running} finished ${g.dot} ${formatTokens(tokens)} tokens`, color: TONE_KEYS.muted },
  ];
  return cellsOf(pieces) <= width ? pieces : pieces.slice(0, 2);
}

/** The strip's key: each kind's glyph in its color and its name, as far as `width` allows. */
export function legend(width: number, ascii: boolean): Piece[] {
  const pieces: Piece[] = [];
  let used = 0;
  for (const kind of KIND_ORDER) {
    const { key, glyph, ascii: plain } = TOOL_KINDS[kind];
    const mark = ascii ? plain : glyph;
    const cells = (pieces.length === 0 ? 0 : 1) + displayWidth(mark) + 1 + displayWidth(kind);
    if (used + cells > width) break;
    pieces.push(...(pieces.length === 0 ? [] : [{ text: " " }]), { text: mark, color: key }, { text: ` ${kind}`, color: TONE_KEYS.muted });
    used += cells;
  }
  return pieces;
}

/** Running lanes first, oldest first so a lane keeps its place; then the finished, newest first. */
export function ordered(lanes: readonly Lane[]): Lane[] {
  return lanes.toSorted((a, b) => {
    if ((a.endedAt === null) !== (b.endedAt === null)) return a.endedAt === null ? -1 : 1;
    return a.endedAt === null ? a.startedAt - b.startedAt : (b.endedAt ?? 0) - (a.endedAt ?? 0);
  });
}

export const excerpt = (text: string, cells: number, ellipsis: string): string => fitEnd(oneLine(text), cells, ellipsis);
