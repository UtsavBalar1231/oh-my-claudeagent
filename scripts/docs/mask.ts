import { type Cell, PLAIN, padRow, type Row, rowWidth } from "./ansi.ts";

export const CLIENT_VERSION = "2.1.288";
export const PLUGIN_VERSION = "3.0.0";
const BUN_VERSION = "1.4.2";
const AST_GREP_VERSION = "0.44.1";
const DURATION = "9s";
const CLOCK_12H = "9:41 AM";
const CLOCK_24H = "09:41";
const SPINNER_GLYPHS = "·✢✳✶✻✽";
const SCRATCH_DIRECTORY = /\S*omca-shots-[A-Za-z0-9]{6}(?:\/home)?/g;

type Rule = { name: string; pattern: RegExp; replacement: (match: RegExpMatchArray) => string };

export const RULES: readonly Rule[] = [
  { name: "scratch directory", pattern: SCRATCH_DIRECTORY, replacement: () => "~" },
  { name: "client version in the banner", pattern: /(?<=Claude Code v)\d+\.\d+\.\d+/g, replacement: () => CLIENT_VERSION },
  { name: "client version in the status line", pattern: /(?<=· v)\d+\.\d+\.\d+(?=\s*$)/g, replacement: () => CLIENT_VERSION },
  {
    name: "client version in the doctor",
    pattern: /\d+\.\d+\.\d+(?= meets the \d+\.\d+\.\d+ floor)/g,
    replacement: () => CLIENT_VERSION,
  },
  {
    name: "client floor in the doctor",
    pattern: /(?<=meets the )\d+\.\d+\.\d+(?= floor)/g,
    replacement: () => CLIENT_VERSION,
  },
  { name: "plugin version", pattern: /(?<=oh-my-claudeagent )\d+\.\d+\.\d+(?= is loaded)/g, replacement: () => PLUGIN_VERSION },
  { name: "bun version", pattern: /(?<=bun )\d+\.\d+\.\d+(?= is on PATH)/g, replacement: () => BUN_VERSION },
  { name: "ast-grep version", pattern: /(?<=ast-grep )\d+\.\d+\.\d+(?= is on PATH)/g, replacement: () => AST_GREP_VERSION },
  {
    name: "turn summary",
    pattern: new RegExp(`^[${SPINNER_GLYPHS}] \\p{L}+ for (?:\\d+h )?(?:\\d+m )?\\d+s(?= · done |\\s*$)`, "gmu"),
    replacement: () => `✻ Worked for ${DURATION}`,
  },
  {
    name: "spinner frame",
    pattern: new RegExp(`^[${SPINNER_GLYPHS}](?= Waiting for \\d+ background agents? to finish)`, "g"),
    replacement: () => "✻",
  },
  { name: "wall clock, 12-hour", pattern: /(?<=done )\d{1,2}:\d{2} [AP]M/g, replacement: () => CLOCK_12H },
  { name: "wall clock, 24-hour", pattern: /(?<=checked )\d{2}:\d{2}/g, replacement: () => CLOCK_24H },
  { name: "footer duration", pattern: /(?<=oh-my-claudeagent: )(?:\d+h )?(?:\d+m )?\d+s(?= ·)/g, replacement: () => DURATION },
  { name: "agent duration", pattern: /(?<=finished · )(?:\d+h )?(?:\d+m )?\d+s/g, replacement: () => DURATION },
  { name: "session duration", pattern: /(?<=~ )(?:\d+h )?\d+m \d+s/g, replacement: () => `0m ${DURATION}` },
  { name: "api duration", pattern: /(?<=api )(?:\d+h )?(?:\d+m )?\d+s/g, replacement: () => DURATION },
];

const isBlank = (cell: Cell | undefined): boolean => cell?.text === " ";

const blanks = (count: number, style: Cell["style"]): Cell[] =>
  Array.from({ length: count }, () => ({ text: " ", width: 1 as const, style }));

// A mask can change a row's width. The first run of two blanks after it gives or takes the
// difference, so whatever follows the run stays in its column.
function absorb(tail: Cell[], delta: number, rule: string): void {
  const at = tail.findIndex((cell, index) => isBlank(cell) && isBlank(tail[index + 1]));
  const style = tail[at]?.style ?? PLAIN;
  if (delta < 0) {
    if (at === -1) tail.push(...blanks(-delta, PLAIN));
    else tail.splice(at, 0, ...blanks(-delta, style));
    return;
  }
  let run = 0;
  while (at !== -1 && isBlank(tail[at + run])) run += 1;
  if (at === -1 || run - delta < 1) throw new Error(`the "${rule}" mask widens a row by ${delta} columns and no gap follows it`);
  tail.splice(at, delta);
}

function replaceCells(cells: Cell[], from: number, to: number, replacement: string, rule: string): Cell[] {
  const removed = cells.slice(from, to);
  const anchor = removed[0];
  if (anchor === undefined) return cells;
  const inserted: Cell[] = [...new Intl.Segmenter().segment(replacement)].map(({ segment }) => ({
    text: segment,
    width: Bun.stringWidth(segment) >= 2 ? 2 : 1,
    style: anchor.style,
  }));
  const tail = cells.slice(to);
  const delta = rowWidth(inserted) - rowWidth(removed);
  if (delta !== 0) absorb(tail, delta, rule);
  return [...cells.slice(0, from), ...inserted, ...tail];
}

function maskRow(row: Row, rule: Rule): Row {
  const text = row.map((cell) => cell.text).join("");
  const starts: number[] = [];
  let offset = 0;
  for (const cell of row) {
    starts.push(offset);
    offset += cell.text.length;
  }
  let cells = [...row];
  for (const match of [...text.matchAll(rule.pattern)].reverse()) {
    const end = match.index + match[0].length;
    const from = starts.indexOf(match.index);
    const to = end === text.length ? cells.length : starts.indexOf(end);
    if (from === -1 || to === -1) continue;
    cells = replaceCells(cells, from, to, rule.replacement(match), rule.name);
  }
  return cells;
}

export function plainText(row: Row): string {
  return row.map((cell) => cell.text).join("");
}

export function maskRows(rows: readonly Row[], forbidden: readonly string[]): Row[] {
  const cols = Math.max(0, ...rows.map(rowWidth));
  const masked = rows.map((row) => padRow(RULES.reduce(maskRow, row), cols));
  const needles = forbidden.filter((value) => value.length >= 4);
  masked.forEach((row, index) => {
    const text = plainText(row);
    const at = needles.findIndex((value) => text.includes(value));
    if (at !== -1) throw new Error(`row ${index + 1} still holds a value from this machine (forbidden value ${at + 1})`);
  });
  return masked;
}
