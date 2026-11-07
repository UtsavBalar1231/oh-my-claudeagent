import { field, inputText, isRecord, text } from "./tool-input.ts";
import { type Glyphs, oneLine } from "./ui-kit.ts";
import { isVerificationCommand } from "./verification.ts";
import { fitPieces, type Piece, piecesWidth, TONE_KEYS } from "./visual.ts";

/** One call as a folded tool group carries it. */
export type GroupCall = {
  tool: string;
  input: unknown;
  isRunning: boolean;
  isErrored: boolean;
  isInterrupted: boolean;
  output?: unknown;
};

export type ShellReceipt = { command: string; state: "pass" | "fail" | "stopped"; exitCode: number | null; summary: string };

const SHELLS = new Set(["Bash", "PowerShell"]);
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI = /^\[[0-?]*[ -/]*[@-~]/;
const EXIT_LINE = /^(?:Error: )?Exit code (\d+)$/;
// The lines a task runner prints about the command it ran, never the command's own last word.
const RUNNER_LINE = /^(?:error: recipe `.+` failed|make(?:\[\d+\])?: \*\*\*|npm (?:ERR!|error)|error: script ".+" exited|ELIFECYCLE|error Command failed with exit code)/;

/** The text without the CSI colors and OSC links a runner prints: an OSC ends at a bell or at the `ESC \\` that starts the next part. */
function plain(output: string): string {
  const [first = "", ...rest] = output.split(ESC);
  const parts = rest.map((part) => {
    if (part.startsWith("]")) {
      const end = part.indexOf(BEL);
      return end === -1 ? "" : part.slice(end + 1);
    }
    return part.startsWith("\\") ? part.slice(1) : part.replace(CSI, "");
  });
  return first + parts.join("");
}

const lines = (output: string): string[] =>
  plain(output)
    .split(/\r?\n/)
    .map(oneLine)
    .filter((line) => line !== "");

/** What a finished verification call says about itself: pass, fail or stopped, its exit code when the output names one, and its last line. */
export function shellReceipt(call: GroupCall): ShellReceipt | null {
  if (!SHELLS.has(call.tool) || call.isRunning) return null;
  const command = inputText(call.input, "command");
  if (command === "" || !isVerificationCommand(command)) return null;
  if (call.isInterrupted) return { command, state: "stopped", exitCode: null, summary: "" };
  const { output } = call;
  if (!call.isErrored) {
    const said = isRecord(output) ? lines(text(field(output, "stdout"))) : [];
    return { command, state: "pass", exitCode: 0, summary: said.at(-1) ?? "" };
  }
  const said = typeof output === "string" ? lines(output) : isRecord(output) ? lines(`${text(field(output, "stdout"))}\n${text(field(output, "stderr"))}`) : [];
  const exit = said.map((line) => EXIT_LINE.exec(line)).find((match) => match !== null);
  const own = said.filter((line) => !EXIT_LINE.test(line) && !RUNNER_LINE.test(line));
  return { command, state: "fail", exitCode: exit === undefined || exit === null ? null : Number(exit[1]), summary: own.at(-1) ?? "" };
}

const INDENT = "  ⎿  ";
const ASCII_INDENT = "  |  ";

/** The receipt's row under the group: the result mark, the command, the exit code of a failure and the last line it printed, in `columns` cells. */
export function receiptRow(receipt: ShellReceipt, g: Glyphs, columns: number): Piece[] {
  const indent = g.tier === "ascii" ? ASCII_INDENT : INDENT;
  const mark =
    receipt.state === "pass" ? { glyph: g.check, color: TONE_KEYS.ok } : receipt.state === "fail" ? { glyph: g.cross, color: TONE_KEYS.fail } : { glyph: g.waiting, color: TONE_KEYS.warn };
  const dot: Piece = { text: ` ${g.dot} `, color: TONE_KEYS.muted };
  const facts: Piece[] = [
    ...(receipt.state === "stopped" ? [{ text: "stopped", color: TONE_KEYS.warn }] : []),
    ...(receipt.state === "fail" && receipt.exitCode !== null ? [{ text: `exit ${receipt.exitCode}`, color: TONE_KEYS.fail }] : []),
    ...(receipt.summary === "" ? [] : [{ text: receipt.summary, color: TONE_KEYS.muted }]),
  ];
  const lead: Piece[] = [
    { text: indent, color: TONE_KEYS.muted },
    { text: `${mark.glyph} `, color: mark.color },
  ];
  return fitPieces([...lead, { text: oneLine(receipt.command) }, ...facts.flatMap((fact) => [dot, fact])], columns, g.ellipsis);
}

const OPERATORS = new Set([";", "&", "|", "\n"]);
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;
const basename = (path: string): string => path.slice(path.search(/[^\\/]*$/));

/** The words of each simple command, quotes removed, so a quoted plugin-root path reads as the path it names. */
function commandWords(command: string): string[][] {
  const segments: string[][] = [[]];
  let word = "";
  let isWord = false;
  let quote = "";
  const endWord = () => {
    if (isWord) segments.at(-1)?.push(word);
    word = "";
    isWord = false;
  };
  for (const char of command) {
    if (quote !== "") {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      isWord = true;
    } else if (OPERATORS.has(char)) {
      endWord();
      segments.push([]);
    } else if (/\s/.test(char)) endWord();
    else {
      word += char;
      isWord = true;
    }
  }
  endWord();
  return segments;
}

/** Whether a command runs the status line script with `--glyph-test`; a command that only names them in a string does not. */
function isGlyphTestCommand(command: string): boolean {
  return commandWords(command).some((words) => {
    const [first, ...rest] = words.filter((word, index) => index > 0 || !ENV_ASSIGNMENT.test(word));
    const afterBun = first !== undefined && /^bun(?:\.exe)?$/.test(basename(first)) ? rest : [];
    const [script, ...args] = afterBun[0] === "run" ? afterBun.slice(1) : afterBun;
    return script !== undefined && basename(script) === "setup-statusline.ts" && args.includes("--glyph-test");
  });
}

/** The line a finished, successful glyph test call printed, as it printed it, or null when the call is anything else. */
export function glyphTestLine(call: GroupCall): string | null {
  if (!SHELLS.has(call.tool) || call.isRunning || call.isErrored || call.isInterrupted) return null;
  if (!isGlyphTestCommand(inputText(call.input, "command")) || !isRecord(call.output)) return null;
  const printed = plain(text(field(call.output, "stdout")))
    .split(/\r?\n/)
    .map((line) => line.replace(/\p{Cc}/gu, ""))
    .filter((line) => line.trim() !== "");
  return printed.at(-1) ?? null;
}

/** The glyph test's row under the group: a muted label, then the printed line whole. The label goes when the line would not fit beside it, and the line is never cut. */
export function glyphTestRow(line: string, g: Glyphs, columns: number): Piece[] {
  const indent: Piece = { text: g.tier === "ascii" ? ASCII_INDENT : INDENT, color: TONE_KEYS.muted };
  const label: Piece = { text: "glyph test ", color: TONE_KEYS.muted };
  const printed: Piece = { text: line };
  return piecesWidth([indent, label, printed]) <= columns ? [indent, label, printed] : [indent, printed];
}
