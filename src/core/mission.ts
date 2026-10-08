import { contentLines, inlineMarkdown } from "./markdown.ts";
import { formatUsd } from "./pricing.ts";
import { inputText } from "./tool-input.ts";
import { agentGlyph, COLUMN_GAP, displayWidth, fitEnd, formatDuration, formatTokens, type Glyphs, oneLine, padEnd, padStart, shortType } from "./ui-kit.ts";
import { agentKey, fitPieces, levelMark, mergePieces, ON_SURFACE, type Piece, piecesWidth, redact, type ThemeKey, TONE_KEYS, wrapPieces } from "./visual.ts";

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

export const firstLine = (text: string): string => contentLines(text)[0] ?? "";
export const lastLine = (text: string): string => contentLines(text).at(-1) ?? "";

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
// The task keeps this many cells, separator included, before the effort column gives way.
const MIN_TASK = 20;
// A task's separator: a space, the dot and a space.
const TASK_LEAD = 3;
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
 * goes as soon as the longest task would be cut beside it, the effort once the shortest task would.
 */
export function laneColumns(lanes: readonly Lane[], width: number): LaneColumns {
  const running = lanes.filter((lane) => lane.endedAt === null);
  const identity = Math.max(0, ...running.map((lane) => 2 + displayWidth(shortType(lane.type))));
  const model = Math.min(MODEL_CELLS, Math.max(0, ...running.map((lane) => displayWidth(shortModel(lane.model)))));
  const effort = Math.min(EFFORT_CELLS, Math.max(0, ...running.map((lane) => displayWidth(effortText(lane)))));
  const task = Math.max(MIN_TASK, ...running.map((lane) => (lane.description === "" ? 0 : TASK_LEAD + displayWidth(oneLine(lane.description)))));
  const fixed = identity + COLUMN_GAP + ELAPSED;
  const effortCells = effort === 0 ? 0 : COLUMN_GAP + effort;
  const modelCells = model === 0 ? 0 : COLUMN_GAP + model;
  if (fixed + task + effortCells + modelCells <= width) return { model, effort };
  if (fixed + MIN_TASK + effortCells <= width) return { model: 0, effort };
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
  const task = lane.description === "" ? [] : fitPieces([{ text: ` ${g.dot} ` }, ...inlineMarkdown(oneLine(lane.description))], room, g.ellipsis);
  return [...identity, ...mergePieces([...task, { text: " ".repeat(Math.max(0, room - piecesWidth(task))) }]), ...right];
}

/** ` · ~$0.04` after the token count, or nothing once any step's model had no price. */
export const costText = (lane: Lane, dot: string): string => (lane.costUsd === null ? "" : ` ${dot} ~${formatUsd(lane.costUsd)}`);

const callCount = (calls: number): string => `${calls} call${calls === 1 ? "" : "s"}`;

const SHELLS: Readonly<Record<string, string>> = { Bash: "bash", Monitor: "bash", PowerShell: "powershell" };

/** The highlighter language of a tool that runs a shell command, so the command can be drawn as code. */
export const shellLanguage = (tool: string): string | undefined => (Object.hasOwn(SHELLS, tool) ? SHELLS[tool] : undefined);

/**
 * The tool row in parts: what leads it (spinner or status, then the tool's name), the call's
 * detail, redacted, with the cells it may take after a space, and the call count for the right edge.
 */
export type ToolParts = { lead: Piece[]; detail: string; room: number; marks: Piece[] };

export function toolParts(lane: Lane, look: LaneLook, home: string, indent = "  "): ToolParts {
  const { width, ascii, now, g } = look;
  const count = lane.calls === 0 ? "" : callCount(lane.calls);
  const marks: Piece[] = count === "" || width < TOOL_CELLS + COLUMN_GAP + displayWidth(count) ? [] : [{ text: count, color: TONE_KEYS.muted }];
  const tail = marks.length === 0 ? 0 : COLUMN_GAP + piecesWidth(marks);
  const lead: Piece[] = [{ text: indent }, { text: spinner(now, ascii), color: TONE_KEYS.active }, { text: " " }];
  if (lane.status !== "running") {
    const mark = statusMark(lane.status, g);
    lead.splice(1, 2, { text: mark.glyph, color: mark.color }, { text: " " });
    lead.push({ text: STATUS_WORDS[lane.status] ?? "", color: TONE_KEYS.muted });
    return { lead, detail: "", room: 0, marks };
  }
  if (lane.tool === null) {
    lead.push({ text: lane.calls === 0 ? "starting" : "thinking", color: TONE_KEYS.muted });
    return { lead, detail: "", room: 0, marks };
  }
  lead.push({ text: fitEnd(toolLabel(lane.tool.name), Math.max(0, width - tail - piecesWidth(lead)), g.ellipsis), color: ON_SURFACE, bold: true });
  return { lead, detail: redactLine(lane.tool.detail, home, g.mask), room: width - tail - piecesWidth(lead) - 1, marks };
}

/** The pad that puts the call count at the right edge of a row `used` cells wide so far. */
export const marksAfter = (marks: readonly Piece[], used: number, width: number): Piece[] =>
  marks.length === 0 ? [] : [{ text: " ".repeat(Math.max(0, width - used - COLUMN_GAP - piecesWidth(marks)) + COLUMN_GAP) }, ...marks];

function toolRow(lane: Lane, look: LaneLook, home: string, indent = "  "): Piece[] {
  const { lead, detail, room, marks } = toolParts(lane, look, home, indent);
  const pieces = detail !== "" && room > 0 ? [...lead, { text: ` ${fitEnd(detail, room, look.g.ellipsis)}` }] : lead;
  return [...pieces, ...marksAfter(marks, piecesWidth(pieces), look.width)];
}

const redactLine = (text: string, home: string, mask: string): string => redact(text, home, mask).text;

/** A running agent's lane: identity, task and the facts on the right; the current tool below, its call count at the right edge. */
export function laneRows(lane: Lane, look: LaneLook, home: string): Piece[][] {
  return [headRow(lane, look), toolRow(lane, look, home)];
}

/** Whether the agent has reported any tokens yet. */
export const hasUsage = (lane: Lane): boolean => lane.inputTokens + lane.outputTokens > 0;

/** The word for an agent's state: `running`, or how it ended. */
export const stateWord = (lane: Lane): string => (lane.status === "running" ? "running" : (STATUS_WORDS[lane.status] ?? lane.status));

/**
 * `pieces` as at most `most` lines of `width` cells, the last ending in the ellipsis when more
 * followed; one line is cut where it stands. Never empty: a blank text is a row of one space.
 */
export function fitLines(pieces: readonly Piece[], width: number, most: number, ellipsis: string): Piece[][] {
  if (most <= 1) return [orSpace(fitPieces(pieces, width, ellipsis))];
  const wrapped = wrapPieces(pieces, width);
  const lines = wrapped.slice(0, most).map((line, index) => (index === most - 1 && wrapped.length > most ? fitPieces([...line, { text: ellipsis }], width, ellipsis) : line));
  return lines.length === 0 ? [[{ text: " " }]] : lines;
}

/** How far a block spreads: the cells its state word takes, and the most lines its task and its result may wrap to. */
export type BlockShape = { word: number; task: number; result: number };

export type Block = { head: Piece[]; task: Piece[][]; body: Piece[][]; usage: Piece[] };

/**
 * An agent's block beside its mini mascot: its name with its state and time, its task, its current
 * tool or, once it ended, what it said, then its model, effort, tokens and cost. Each row is
 * `look.width` cells at most and none is empty.
 */
export function laneBlock(lane: Lane, look: LaneLook, home: string, { word = 0, task = 1, result = 1 }: Partial<BlockShape> = {}): Block {
  const { g, now, width } = look;
  const mark = statusMark(lane.status, g);
  const elapsed: Piece = { text: padStart(formatDuration((lane.endedAt ?? now) - lane.startedAt), ELAPSED), color: TONE_KEYS.muted };
  const full: Piece[] = [{ text: `${mark.glyph} `, color: mark.color }, { text: padEnd(stateWord(lane), word), color: TONE_KEYS.muted }, gap(), elapsed];
  // A name that would be cut gives up the state's word first: the glyph's shape still tells the state.
  const state = displayWidth(shortType(lane.type)) + COLUMN_GAP + piecesWidth(full) <= width ? full : [{ text: mark.glyph, color: mark.color }, gap(), elapsed];
  const name = fitEnd(shortType(lane.type), Math.max(0, width - piecesWidth(state) - COLUMN_GAP), g.ellipsis);
  const head: Piece[] = [{ text: name, color: ON_SURFACE, bold: true }, { text: " ".repeat(Math.max(COLUMN_GAP, width - displayWidth(name) - piecesWidth(state))) }, ...state];
  const used = hasUsage(lane);
  const tokens = used ? formatTokens(lane.inputTokens + lane.outputTokens) : "";
  const cost = used && lane.costUsd !== null ? `~${formatUsd(lane.costUsd)}` : "";
  // Too narrow for every fact, the row drops whole parts rather than cutting the cost short.
  const usage = [
    [shortModel(lane.model), effortText(lane), used ? `${tokens} tokens` : "", cost],
    [shortModel(lane.model), effortText(lane), tokens, cost],
    [effortText(lane), tokens, cost],
    [tokens, cost],
  ].map((parts) => parts.filter((part) => part !== "").join(` ${g.dot} `));
  const facts = fitEnd(usage.find((text) => displayWidth(text) <= width) ?? usage.at(-1) ?? "", width, g.ellipsis);
  return {
    head,
    task: fitLines(inlineMarkdown(oneLine(lane.description)), width, task, g.ellipsis),
    body: lane.endedAt === null ? [toolRow(lane, look, home, "")] : fitLines(outcome(lane, g, home), width, result, g.ellipsis),
    usage: [{ text: facts === "" ? " " : facts, color: TONE_KEYS.muted }],
  };
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

const orSpace = (pieces: Piece[]): Piece[] => (pieces.length === 0 ? [{ text: " " }] : pieces);

/** What a finished agent said, muted: its result's first line as markdown, or its status word when it gave none. */
function outcome(lane: Lane, g: Glyphs, home: string): Piece[] {
  const word = STATUS_WORDS[lane.status] ?? "";
  const said = inlineMarkdown(redactLine(lane.result, home, g.mask), { color: TONE_KEYS.muted });
  if (said.length === 0) return word === "" ? [] : [{ text: word, color: TONE_KEYS.muted }];
  return lane.status === "answer" ? said : [{ text: `${word} ${g.dot} `, color: TONE_KEYS.muted }, ...said];
}

/** A finished agent in one dim line: status glyph, type, its task, its result in the cells the task leaves, and how long it ran. */
export function finishedRow(lane: Lane, look: LaneLook, home: string): Piece[] {
  const { g, width } = look;
  const mark = statusMark(lane.status, g);
  const duration = padStart(formatDuration((lane.endedAt ?? look.now) - lane.startedAt), ELAPSED);
  const head = `${mark.glyph} ${shortType(lane.type)}`;
  const room = Math.max(0, width - displayWidth(head) - COLUMN_GAP - ELAPSED);
  const dot: Piece = { text: ` ${g.dot} `, color: TONE_KEYS.muted };
  const task = lane.description === "" ? [] : [dot, ...inlineMarkdown(oneLine(lane.description), { color: TONE_KEYS.muted })];
  const body = fitPieces([...task, dot, ...outcome(lane, g, home)], room, g.ellipsis);
  const pad = { text: " ".repeat(Math.max(0, room - piecesWidth(body))), color: TONE_KEYS.muted };
  return [
    { text: `${mark.glyph} `, color: mark.color },
    ...mergePieces([{ text: shortType(lane.type), color: TONE_KEYS.muted }, ...body, pad]),
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
