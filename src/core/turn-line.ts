import { displayWidth, fitEnd, formatTokens, type Glyphs, oneLine, shortType } from "./ui-kit.ts";
import { agentKey, type Piece, piecesWidth, TONE_KEYS } from "./visual.ts";

/** What OMCA knows about one finished main-loop turn, kept for the line that closes it. */
export type TurnRecord = {
  turnId: string;
  startedAt: number;
  endedAt: number;
  tokens: { input: number; output: number } | null;
  costUsd: number | null;
  /** The verification the turn ran, with its time in the status file's whole seconds. */
  receipt: { command: string; at: number; isLogged: boolean } | null;
  /** The agent types still running in the background when the turn ended. */
  waiting: readonly string[];
};

export type TurnLine = {
  word: string;
  durationMs: number;
  doneAt: string | null;
  /** The agent types the turn waits on; empty when it waits on none. */
  waiting: readonly string[];
  record: TurnRecord;
};

const dim = (text: string): Piece => ({ text, dimColor: true });

/** The engine's own duration wording: `0s`, `21s`, `1m 4s`, `2h 5m`. */
export function turnDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const dollars = (usd: number) => `$${usd.toFixed(Math.abs(usd) < 1 ? 4 : 2)}`;

// Each agent type once, in the order it first appears, with how many of it the turn waits on.
function headOf({ word, durationMs, waiting }: TurnLine, g: Glyphs): Piece[] {
  if (waiting.length === 0) return [dim(`${word} for ${turnDuration(durationMs)}`)];
  const counts = new Map<string, number>();
  for (const type of waiting) counts.set(type, (counts.get(type) ?? 0) + 1);
  const times = g.tier === "ascii" ? "x" : "×";
  return [
    dim("Waiting for "),
    ...[...counts].flatMap(([type, count], index): Piece[] => [
      ...(index === 0 ? [] : [dim(", ")]),
      { text: shortType(type), color: agentKey(type) },
      ...(count === 1 ? [] : [dim(` ${times}${count}`)]),
    ]),
  ];
}

type Part = { priority: number; piece: Piece };

// The highest number leaves first as the row narrows: the clock, then the cost, then the tokens.
const PRIORITY = { done: 3, cost: 2, tokens: 1 } as const;
// A receipt keeps at least this much of its command before a part is dropped for it.
const MIN_COMMAND = 8;

function partsOf(doneAt: string | null, { tokens, costUsd }: TurnRecord): Part[] {
  return [
    ...(doneAt === null ? [] : [{ priority: PRIORITY.done, piece: dim(`done ${doneAt}`) }]),
    ...(tokens === null ? [] : [{ priority: PRIORITY.tokens, piece: dim(`${formatTokens(tokens.input)} in ${formatTokens(tokens.output)} out`) }]),
    ...(costUsd === null ? [] : [{ priority: PRIORITY.cost, piece: dim(dollars(costUsd)) }]),
  ];
}

// `head`, then the parts and the receipt joined by dots, in `columns` cells: parts leave by
// priority, and the receipt never leaves; its command is cut instead.
function fitted(head: readonly Piece[], doneAt: string | null, record: TurnRecord, g: Glyphs, columns: number): Piece[] {
  const dot = dim(` ${g.dot} `);
  const { receipt } = record;
  const mark: Piece[] = receipt === null ? [] : [{ text: `${receipt.isLogged ? g.check : g.warn} `, color: receipt.isLogged ? TONE_KEYS.ok : TONE_KEYS.warn }];
  const words = receipt === null ? "" : receipt.isLogged ? " logged" : " not logged";
  const command = receipt === null ? "" : oneLine(receipt.command);
  const parts = partsOf(doneAt, record);
  const segments = () => parts.length + (receipt === null ? 0 : 1);
  const dots = () => Math.max(0, segments() - (head.length === 0 ? 1 : 0)) * displayWidth(dot.text);
  const used = () => piecesWidth(head) + dots() + parts.reduce((sum, part) => sum + displayWidth(part.piece.text), 0) + piecesWidth(mark) + displayWidth(words);
  const kept = Math.min(displayWidth(command), MIN_COMMAND);
  while (parts.length > 0 && used() + kept > columns) {
    const first = parts.reduce((out, part) => (part.priority > out.priority ? part : out));
    parts.splice(parts.indexOf(first), 1);
  }
  const tail: Piece[][] = [
    ...parts.map((part) => [part.piece]),
    ...(receipt === null ? [] : [[...mark, dim(`${fitEnd(command, Math.max(0, columns - used()), g.ellipsis)}${words}`)]]),
  ];
  return [...head, ...tail.flatMap((pieces, index) => (index === 0 && head.length === 0 ? pieces : [dot, ...pieces]))];
}

/**
 * The line that closes a main turn, in the engine's dim voice: how long it ran or which agents it
 * waits on, then the clock, the tokens, the cost and this turn's verification receipt, as many as
 * fit `columns` cells.
 */
export function turnLine(line: TurnLine, g: Glyphs, columns: number): Piece[] {
  return fitted(headOf(line, g), line.doneAt, line.record, g, columns);
}

/** The turn's tokens, cost and receipt alone, for a row beneath a line the engine draws itself. */
export function turnFacts(record: TurnRecord, g: Glyphs, columns: number): Piece[] {
  return fitted([], null, record, g, columns);
}
