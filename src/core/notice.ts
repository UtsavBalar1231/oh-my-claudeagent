import { STATUS_WORDS, statusMark } from "./mission.ts";
import { agentGlyph, COLUMN_GAP, displayWidth, fitEnd, formatTokens, type Glyphs, oneLine, shortType } from "./ui-kit.ts";
import { turnDuration } from "./turn-line.ts";
import { agentKey, fitPieces, levelMark, type Piece, piecesWidth, TONE_KEYS } from "./visual.ts";

type Status = "answer" | "aborted" | "refusal" | "error" | "gone";

/** A finished subagent as OMCA recorded it, for the row that reports it in the transcript. */
export type Notice = {
  type: string;
  description: string;
  status: Status;
  durationMs: number | null;
  calls: number;
  tokens: number;
  result: string;
};

const TASK_STATUS: Readonly<Record<string, Status>> = { completed: "answer", failed: "error", killed: "aborted" };

/** The engine's notification status, when it names one, outranks what OMCA recorded. */
export const noticeStatus = (task: string | undefined, recorded: Status): Status =>
  task !== undefined && Object.hasOwn(TASK_STATUS, task) ? (TASK_STATUS[task] ?? recorded) : recorded;

const RESULT_INDENT = "  ⎿  ";
const ASCII_INDENT = "  |  ";

type Part = { priority: number; text: string; color?: Piece["color"] };

// The highest number leaves first as the row narrows: the tokens, then the call count; the status word and the duration stay.
function factsOf({ status, durationMs, calls, tokens }: Notice): Part[] {
  const word = status === "answer" ? undefined : STATUS_WORDS[status];
  return [
    ...(word === undefined ? [] : [{ priority: 0, text: word, color: status === "error" ? TONE_KEYS.fail : TONE_KEYS.warn }]),
    ...(durationMs === null ? [] : [{ priority: 0, text: turnDuration(durationMs) }]),
    ...(calls === 0 ? [] : [{ priority: 1, text: `${calls} call${calls === 1 ? "" : "s"}` }]),
    ...(tokens === 0 ? [] : [{ priority: 2, text: `${formatTokens(tokens)} tok` }]),
  ];
}

/**
 * The rows that report a finished subagent: its status mark, its role in the role's color and its
 * task, the facts flush right, and under them the reply's first line. Every row fits `columns`.
 */
export function noticeRows(notice: Notice, g: Glyphs, columns: number): Piece[][] {
  const mark = statusMark(notice.status, g);
  const lead: Piece[] = [
    { text: `${mark.glyph} `, color: mark.color },
    { text: shortType(notice.type), color: agentKey(notice.type), bold: true },
  ];
  const task = oneLine(notice.description);
  const facts = factsOf(notice);
  const dot = ` ${g.dot} `;
  const factsWidth = () => facts.reduce((sum, part, index) => sum + displayWidth(part.text) + (index === 0 ? 0 : displayWidth(dot)), 0);
  const room = () => columns - piecesWidth(lead) - COLUMN_GAP - (facts.length === 0 ? 0 : COLUMN_GAP + factsWidth());
  while (facts.some((part) => part.priority > 0) && room() < displayWidth(task)) {
    const first = facts.reduce((out, part) => (part.priority > out.priority ? part : out));
    facts.splice(facts.indexOf(first), 1);
  }
  const shown = task === "" ? [] : fitPieces([{ text: task }], Math.max(0, room()), g.ellipsis);
  const head: Piece[] = [...lead, ...(shown.length === 0 ? [] : [{ text: " ".repeat(COLUMN_GAP) }, ...shown])];
  const right: Piece[] = facts.flatMap((part, index) => [
    ...(index === 0 ? [] : [{ text: dot, color: TONE_KEYS.muted }]),
    { text: part.text, color: part.color ?? TONE_KEYS.muted },
  ]);
  const gap = Math.max(right.length === 0 ? 0 : COLUMN_GAP, columns - piecesWidth(head) - piecesWidth(right));
  const first = right.length === 0 || piecesWidth(head) + gap + piecesWidth(right) > columns ? head : [...head, { text: " ".repeat(gap) }, ...right];
  const said = oneLine(notice.result);
  if (said === "") return [first];
  const indent = g.tier === "ascii" ? ASCII_INDENT : RESULT_INDENT;
  return [first, [{ text: indent, color: TONE_KEYS.muted }, { text: fitEnd(said, Math.max(0, columns - displayWidth(indent)), g.ellipsis), color: TONE_KEYS.muted }]];
}

// Below this many cells a task stops reading as a name.
const MIN_TASK = 12;

/** An Agent call's own row: what it starts, and how a call that waits for its agent ended. */
export type Launch = { type: string; description: string; isBackground: boolean; state: "running" | "done" | "failed" | "stopped" };

/**
 * The row of an Agent call: a call that failed or was stopped shows that mark; otherwise the
 * agent's icon in its color while it works (a background launch always, since its agent outlives
 * the call), or the check of a call that waited for it. Then its name, its task and, flush right,
 * `background` for a launch that runs on its own.
 */
export function launchRow(launch: Launch, g: Glyphs, columns: number): Piece[] {
  const color = agentKey(launch.type);
  const mark =
    launch.state === "failed" || launch.state === "stopped"
      ? levelMark(launch.state === "failed" ? "fail" : "warn", g)
      : launch.isBackground || launch.state === "running"
        ? { glyph: agentGlyph(launch.type, g), color }
        : levelMark("ok", g);
  const lead: Piece[] = [
    { text: `${mark.glyph} `, color: mark.color },
    { text: shortType(launch.type), color, bold: true },
  ];
  const task = oneLine(launch.description);
  const roomBeside = (right: readonly Piece[]) => columns - piecesWidth(lead) - COLUMN_GAP - (right.length === 0 ? 0 : COLUMN_GAP + piecesWidth(right));
  const label: Piece[] = launch.isBackground ? [{ text: "background", color: TONE_KEYS.muted }] : [];
  // The label gives way before the task drops under a readable length.
  const right = roomBeside(label) < Math.min(MIN_TASK, displayWidth(task)) ? [] : label;
  const room = roomBeside(right);
  const shown = task === "" ? [] : fitPieces([{ text: task }], Math.max(0, room), g.ellipsis);
  const head: Piece[] = [...lead, ...(shown.length === 0 ? [] : [{ text: " ".repeat(COLUMN_GAP) }, ...shown])];
  const gap = columns - piecesWidth(head) - piecesWidth(right);
  return right.length === 0 || gap < COLUMN_GAP ? head : [...head, { text: " ".repeat(gap) }, ...right];
}
