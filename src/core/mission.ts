import { formatUsd } from "./pricing.ts";
import { inputText } from "./tool-input.ts";
import { agentGlyph, COLUMN_GAP, displayWidth, fitEnd, formatDuration, formatTokens, type Glyphs, oneLine, padEnd, padStart, shortType } from "./ui-kit.ts";
import { agentKey, levelMark, ON_SURFACE, type Piece, piecesWidth, redact, type ThemeKey, TONE_KEYS } from "./visual.ts";

/** `mcp__server__tool` as its tool's own name; every other tool as named. */
export const toolLabel = (name: string): string => (name.startsWith("mcp__") ? name.slice(name.lastIndexOf("__") + 2) : name);

const DETAIL_FIELD: Readonly<Record<string, string>> = {
  Bash: "command",
  PowerShell: "command",
  Monitor: "command",
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
  LSP: "filePath",
  Grep: "pattern",
  Glob: "pattern",
  WebFetch: "url",
  WebSearch: "query",
  Agent: "description",
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
type Status = "running" | "idle" | "waiting" | "pending" | "answer" | "aborted" | "refusal" | "error" | "gone";

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
  costUsd: number | null;
  status: Status;
  prompt: string;
  calls: number;
  tool: { name: string; detail: string } | null;
  output: string;
  result: string;
};

/** The model and effort columns' widths, the same on every lane; 0 leaves a column out. */
export type LaneColumns = { model: number; effort: number };

export type LaneLook = { width: number; g: Glyphs; ascii: boolean; now: number; columns: LaneColumns };

const shortModel = (model: string): string => model.replace(/^claude-/, "").replace(/-\d{8}$/, "");

// Claude Code's own working marks, so a lane reads as busy the way the main thread does.
const SPINNER = { unicode: ["·", "✢", "✳", "✶", "✻", "✽"], ascii: ["|", "/", "-", "\\"] } as const;
// The task keeps this many cells, separator included, before the model column gives way.
const MIN_TASK = 20;
const ELAPSED = 6;
const MODEL_CELLS = 12;
const EFFORT_CELLS = 6;
// The spinner, its space and the tool's name keep this many cells before the call count takes any.
const TOOL_CELLS = 14;

/** One frame per second of `now`, so a lane turns only while the pane's clock ticks. */
export function spinner(now: number, ascii: boolean): string {
  const frames = ascii ? SPINNER.ascii : SPINNER.unicode;
  return frames[Math.floor(now / 1000) % frames.length] ?? "";
}

const effortText = (lane: Lane): string => (lane.effort === null ? "" : String(lane.effort));

/**
 * The model and effort columns every running lane draws at one width, so they line up: the model
 * goes first and the effort next while the longest name and the shortest task do not fit.
 */
export function laneColumns(lanes: readonly Lane[], width: number): LaneColumns {
  const running = lanes.filter((lane) => lane.endedAt === null);
  const identity = Math.max(0, ...running.map((lane) => 2 + displayWidth(shortType(lane.type))));
  const model = Math.min(MODEL_CELLS, Math.max(0, ...running.map((lane) => displayWidth(shortModel(lane.model)))));
  const effort = Math.min(EFFORT_CELLS, Math.max(0, ...running.map((lane) => displayWidth(effortText(lane)))));
  const fixed = identity + MIN_TASK + COLUMN_GAP + ELAPSED;
  const effortCells = effort === 0 ? 0 : COLUMN_GAP + effort;
  const modelCells = model === 0 ? 0 : COLUMN_GAP + model;
  if (fixed + effortCells + modelCells <= width) return { model, effort };
  if (fixed + effortCells <= width) return { model: 0, effort };
  return { model: 0, effort: 0 };
}

const gap = (): Piece => ({ text: " ".repeat(COLUMN_GAP) });

function headRow(lane: Lane, look: LaneLook): Piece[] {
  const { g, now, width, columns } = look;
  const identity: Piece[] = [
    { text: `${agentGlyph(lane.type, g)} `, color: agentKey(lane.type) },
    { text: shortType(lane.type), color: ON_SURFACE, bold: true },
  ];
  const column = (cells: number, text: string): Piece[] =>
    cells === 0 ? [] : [gap(), { text: padEnd(fitEnd(text, cells, g.ellipsis), cells), color: TONE_KEYS.muted }];
  const right: Piece[] = [
    ...column(columns.model, shortModel(lane.model)),
    ...column(columns.effort, effortText(lane)),
    gap(),
    { text: padStart(formatDuration(now - lane.startedAt), ELAPSED), color: TONE_KEYS.muted },
  ];
  const room = Math.max(0, width - piecesWidth(identity) - piecesWidth(right));
  const task = lane.description === "" ? "" : fitEnd(` ${g.dot} ${oneLine(lane.description)}`, room, g.ellipsis);
  return [...identity, { text: padEnd(task, room) }, ...right];
}

/** ` · ~$0.04` after the token count, or nothing once any step's model had no price. */
export const costText = (lane: Lane, dot: string): string => (lane.costUsd === null ? "" : ` ${dot} ~${formatUsd(lane.costUsd)}`);

const callCount = (calls: number): string => `${calls} call${calls === 1 ? "" : "s"}`;

function toolRow(lane: Lane, look: LaneLook, home: string, mask: string): Piece[] {
  const { width, ascii, now, g } = look;
  const count = lane.calls === 0 ? "" : callCount(lane.calls);
  const marks: Piece[] = count === "" || width < TOOL_CELLS + COLUMN_GAP + displayWidth(count) ? [] : [{ text: count, color: TONE_KEYS.muted }];
  const tail = marks.length === 0 ? 0 : COLUMN_GAP + piecesWidth(marks);
  const pieces: Piece[] = [{ text: "  " }, { text: spinner(now, ascii), color: TONE_KEYS.active }, { text: " " }];
  if (lane.status !== "running") {
    const mark = statusMark(lane.status, g);
    pieces.splice(1, 2, { text: mark.glyph, color: mark.color }, { text: " " });
    pieces.push({ text: STATUS_WORDS[lane.status] ?? "", color: TONE_KEYS.muted });
  } else if (lane.tool === null) {
    pieces.push({ text: lane.calls === 0 ? "starting" : "thinking", color: TONE_KEYS.muted });
  } else {
    const label = fitEnd(toolLabel(lane.tool.name), Math.max(0, width - tail - piecesWidth(pieces)), g.ellipsis);
    pieces.push({ text: label, color: ON_SURFACE, bold: true });
    const detail = redactLine(lane.tool.detail, home, mask);
    const room = width - tail - piecesWidth(pieces) - 1;
    if (detail !== "" && room > 0) pieces.push({ text: ` ${fitEnd(detail, room, g.ellipsis)}` });
  }
  if (marks.length === 0) return pieces;
  return [...pieces, { text: " ".repeat(Math.max(0, width - tail - piecesWidth(pieces)) + COLUMN_GAP) }, ...marks];
}

const redactLine = (text: string, home: string, mask: string): string => redact(text, home, mask).text;

/** A running agent's lane: identity, task and the facts on the right; the current tool below, its call count at the right edge. */
export function laneRows(lane: Lane, look: LaneLook, home: string): Piece[][] {
  return [headRow(lane, look), toolRow(lane, look, home, look.g.mask)];
}

export const STATUS_WORDS: Readonly<Partial<Record<Status, string>>> = {
  idle: "idle",
  waiting: "waiting",
  pending: "pending",
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
    case "idle":
    case "waiting":
    case "pending":
      return { glyph: g.pending, color: TONE_KEYS.muted };
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
  const word = STATUS_WORDS[lane.status] ?? "";
  const result = redactLine(lane.result, home, g.mask);
  const said = lane.status === "answer" && result !== "" ? result : result === "" ? word : `${word} ${g.dot} ${result}`;
  const duration = padStart(formatDuration((lane.endedAt ?? look.now) - lane.startedAt), ELAPSED);
  const head = `${mark.glyph} ${shortType(lane.type)}`;
  const room = Math.max(0, width - displayWidth(head) - COLUMN_GAP - ELAPSED);
  const body = fitEnd(` ${g.dot} ${said}`, room, g.ellipsis);
  return [
    { text: `${mark.glyph} `, color: mark.color },
    { text: `${shortType(lane.type)}${padEnd(body, room)}`, color: TONE_KEYS.muted },
    { text: `${" ".repeat(COLUMN_GAP)}${duration}`, color: TONE_KEYS.muted },
  ];
}

/** How many agents run and finished and the tokens they spent, as many parts as fit `width`. */
export function summaryText(lanes: readonly Lane[], g: Glyphs, width: number): string {
  const running = lanes.filter((lane) => lane.status === "running").length;
  const open = lanes.filter((lane) => lane.endedAt === null).length;
  const tokens = lanes.reduce((sum, lane) => sum + lane.inputTokens + lane.outputTokens, 0);
  const parts = [
    `${running} running`,
    ...(open > running ? [`${open - running} idle`] : []),
    `${lanes.length - open} finished`,
    `${formatTokens(tokens)} tokens`,
  ];
  while (parts.length > 1 && displayWidth(parts.join(` ${g.dot} `)) > width) parts.pop();
  return fitEnd(parts.join(` ${g.dot} `), width, g.ellipsis);
}

/** Running lanes first, oldest first so a lane keeps its place; then the finished, newest first. */
export function ordered(lanes: readonly Lane[]): Lane[] {
  return lanes.toSorted((a, b) => {
    if ((a.endedAt === null) !== (b.endedAt === null)) return a.endedAt === null ? -1 : 1;
    return a.endedAt === null ? a.startedAt - b.startedAt : (b.endedAt ?? 0) - (a.endedAt ?? 0);
  });
}

export const excerpt = (text: string, cells: number, ellipsis: string): string => fitEnd(oneLine(text), cells, ellipsis);
