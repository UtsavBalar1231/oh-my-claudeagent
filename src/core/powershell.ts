import { baseName } from "./path.ts";
import { anyCase, commandWord, S } from "./shell.ts";
import { SESSION_STATE, type ShellState } from "./shell-state.ts";
import { CWD_SUBSTITUTION } from "./targets.ts";

export const POWERSHELL_COMMAND_POSITION = "[;&|(){}\\n\\r]";

const REMOVAL = new RegExp(
  `(^|${POWERSHELL_COMMAND_POSITION})${S}*(?:&${S}+)?(?<word>${commandWord(anyCase("Remove-Item|ri|rm|del|erase|rd|rmdir"))})(?=${S}|$)`,
  "g",
);
const CMD_NAMES = new Set(["del", "erase", "rd", "rmdir"]);
const BLANKED = ";&|(){}\n\r";
const COMMENT_START = /^$|[ \t\n\r;|&({]/;

// Parameters of Remove-Item and the common ones, by the kind that decides how a word after one reads.
const PARAMETERS = new Map(
  Object.entries({
    path: "path",
    literalpath: "path",
    lp: "path",
    pspath: "path",
    recurse: "recurse",
    force: "switch",
    whatif: "switch",
    confirm: "switch",
    verbose: "switch",
    debug: "switch",
    filter: "value",
    include: "value",
    exclude: "value",
    credential: "value",
    stream: "value",
    erroraction: "value",
    errorvariable: "value",
    warningaction: "value",
    warningvariable: "value",
    informationaction: "value",
    informationvariable: "value",
    outvariable: "value",
    outbuffer: "value",
    pipelinevariable: "value",
    progressaction: "value",
  }),
);

type Frame = { kind: "'" | '"' | "'@" | '"@' | "#" | "<#" | "$("; depth: number };

/**
 * Blanks what is not a command in PowerShell the way `neutralizeQuotedPositions` does for sh:
 * inside a quoted span or here-string the characters that open a command position become `_`,
 * and a comment is blanked whole. A `$(...)` inside a double-quoted string or here-string runs,
 * so its text is left as the command it is, unless a backtick escapes the `$`. Length is
 * preserved.
 */
export function neutralizePowershell(command: string): string {
  const frames: Frame[] = [];
  let out = "";
  const open = (kind: Frame["kind"]) => frames.push({ kind, depth: 0 });
  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);
    const next = command.charAt(i + 1);
    const top = frames.at(-1);
    const kind = top?.kind;
    if (kind === undefined || kind === "$(") {
      const isHereString = (next === "'" || next === '"') && ch === "@" && /^[ \t]*\r?(\n|$)/.test(command.slice(i + 2));
      if (isHereString) {
        open(next === "'" ? "'@" : '"@');
        out += ch + next;
        i++;
      } else if (ch === "'" || ch === '"') {
        open(ch);
        out += ch;
      } else if (ch === "<" && next === "#") {
        open("<#");
        out += "__";
        i++;
      } else if (ch === "#" && COMMENT_START.test(command.charAt(i - 1))) {
        open("#");
        out += "_";
      } else if (ch === ")" && top?.kind === "$(" && top.depth === 0) {
        frames.pop();
        out += ch;
      } else {
        if (top?.kind === "$(") top.depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
        out += ch;
      }
    } else if (kind === "'") {
      if (ch === "'") frames.pop();
      out += ch !== "'" && (BLANKED.includes(ch) || ch === "$") ? "_" : ch;
    } else if (kind === '"') {
      if (ch === "`") {
        out += ch + next;
        i++;
      } else if (ch === "$" && next === "(") {
        open("$(");
        out += ch + next;
        i++;
      } else {
        if (ch === '"') frames.pop();
        out += ch !== '"' && BLANKED.includes(ch) ? "_" : ch;
      }
    } else if (kind === "'@" || kind === '"@') {
      if (ch === "\n" && command.startsWith(kind, i + 1)) {
        out += `_${kind}`;
        i += kind.length;
        frames.pop();
      } else if (kind === '"@' && ch === "`" && next === "$") {
        out += ch + next;
        i++;
      } else if (kind === '"@' && ch === "$" && next === "(") {
        open("$(");
        out += ch + next;
        i++;
      } else out += kind === "'@" || BLANKED.includes(ch) ? "_" : ch;
    } else if (kind === "#") {
      if (ch === "\n") frames.pop();
      out += ch === "\n" ? ch : "_";
    } else if (ch === "#" && next === ">") {
      frames.pop();
      out += "__";
      i++;
    } else out += "_";
  }
  return out;
}

/** A word of an argument list with its quotes removed, and the offset in the list where it starts. */
export type Word = { text: string; start: number };

/** Splits arguments into words as PowerShell does: quotes removed, a backtick escapes, and a comma or white space ends a word. */
export function powershellWordSpans(text: string): Word[] {
  const words: Word[] = [];
  let word = "";
  let quote = "";
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (quote !== "") {
      if (quote === '"' && ch === "`") {
        word += next;
        i++;
      } else if (ch !== quote) word += ch;
      else if (next === quote) {
        word += ch;
        i++;
      } else quote = "";
    } else if (/[ \t\n\v\f\r,]/.test(ch)) {
      if (start !== -1) words.push({ text: word, start });
      word = "";
      start = -1;
    } else {
      if (start === -1) start = i;
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "`") {
        word += next;
        i++;
      } else word += ch;
    }
  }
  if (start !== -1) words.push({ text: word, start });
  return words;
}

export const powershellWords = (text: string): string[] => powershellWordSpans(text).map((word) => word.text);

function parameterKind(name: string): string | undefined {
  const lower = name.toLowerCase();
  const exact = PARAMETERS.get(lower);
  if (exact !== undefined) return exact;
  const kinds = new Set([...PARAMETERS].filter(([full]) => full.startsWith(lower)).map(([, kind]) => kind));
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

// Arguments end at the next statement separator, an unbalanced `)`, a `}` and a comment. A
// `${name}` variable holds its own braces.
export function powershellArgumentsEnd(command: string, scan: string, from: number): number {
  let depth = 0;
  for (let i = from; i < scan.length; i++) {
    const ch = scan.charAt(i);
    if (ch === "$" && scan.charAt(i + 1) === "{") i = Math.max(i, scan.indexOf("}", i));
    else if (ch === "_" && command.charAt(i) === "#") return i;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && ";|&\n\r}".includes(ch)) return i;
  }
  return scan.length;
}

// A redirection operator, alone or with its file attached (`2>$null`, `*>&1`).
const REDIRECTION = /^(?:[1-6*]?>>?|[1-6*]>&[1-6])(.*)$/s;

const isWhatIf = (name: string): boolean =>
  [...PARAMETERS.keys()].filter((full) => full.startsWith(name.toLowerCase())).join() === "whatif";

function parse(
  command: string,
  words: readonly string[],
): { isRecursive: boolean; isDryRun: boolean; targets: string[] } {
  const isCmd = CMD_NAMES.has(command);
  let isRecursive = false;
  let isDryRun = false;
  const targets: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    const redirection = REDIRECTION.exec(word);
    if (redirection !== null) {
      if (redirection[1] === "" && !/&[1-6]$/.test(word)) i++;
      continue;
    }
    const parameter = /^-([A-Za-z]+)(?::(.*))?$/s.exec(word);
    if (parameter !== null) {
      const kind = parameterKind(parameter[1] ?? "");
      const attached = parameter[2];
      if (isWhatIf(parameter[1] ?? "")) isDryRun ||= !/^\$?false$/i.test(attached ?? "");
      if (kind === "recurse") isRecursive ||= !/^\$?false$/i.test(attached ?? "");
      else if (kind === "path") {
        const value = attached ?? words[i + 1];
        if (value !== undefined) targets.push(value);
        if (attached === undefined) i++;
      } else if (kind === "value" && attached === undefined) i++;
      else if (kind === undefined && command === "rm" && /[rR]/.test(parameter[1] ?? "")) isRecursive = true;
    } else if (command === "rm" && word === "--recursive") isRecursive = true;
    else if (isCmd && /^\/s$/i.test(word)) isRecursive = true;
    else if (!isCmd || !/^\/[qfpa?](?::.*)?$/i.test(word)) targets.push(word);
  }
  return { isRecursive, isDryRun, targets };
}

const VARIABLE_REFERENCE = /\$(?:\{((?:env:)?[A-Za-z_][\w]*)\}|((?:env:)?[A-Za-z_][\w]*))/gi;

/** A word with each variable the command assigned replaced by its value; one it did not stays as written. */
const substitute = (word: string, state: ShellState): string =>
  word.replace(VARIABLE_REFERENCE, (reference, braced: string | undefined, bare: string | undefined) =>
    state.vars.get((braced ?? bare ?? "").toLowerCase()) ?? reference,
  );

/** A word as written, quotes removed and assigned variables substituted, or undefined when it holds a subexpression. */
export function expandPowershellWord(raw: string, state: ShellState): string | undefined {
  if (raw.includes("$(")) return undefined;
  return substitute(powershellWords(raw).join(" "), state);
}

/**
 * The value an assignment gives: a quoted string or another variable, with assigned variables
 * substituted, or undefined for anything it would have to run, since a bare word is a command.
 */
function assignedValue(raw: string, state: ShellState): string | undefined {
  const text = raw.trim();
  if (/^'(?:[^']|'')*'$/s.test(text)) return text.slice(1, -1).replaceAll("''", "'");
  if (/^"[^"`]*"$/s.test(text) && !text.includes("$(")) return substitute(text.slice(1, -1), state);
  return /^\$(?:\{[^}]+\}|(?:env:)?[A-Za-z_]\w*)$/.test(text) ? substitute(text, state) : undefined;
}

const ASSIGNMENT = /^\$(?:\{)?(?:(?:script|global|local|private):)?((?:env:)?[A-Za-z_][\w]*)\}?[ \t]*=(?!=)([^]*)$/i;

/**
 * The variables a PowerShell command assigned where each of `queries` starts, read once left to
 * right: an assignment counts only as a statement of its own, not in a pipeline or after `||`,
 * and one after `&&` only while that chain lasts. A value set inside a `{...}` block is unknown
 * after the block, and inside the block at a query the block reaches before setting it, since a
 * loop's next pass reaches the query with that value.
 */
export function walkPowershell(command: string, scan: string, queries: readonly number[]): Map<number, ShellState> {
  const env = new Map<string, string | undefined>();
  type Block = { start: number; writes: { at: number; name: string }[] };
  const blocks: Block[] = [];
  const snapshots: { at: number; vars: Map<string, string | undefined> }[] = [];
  let statement = -1;
  let prev = "start";
  let chained: string[] = [];
  const set = (name: string, value: string | undefined, at: number) => {
    env.set(name, value);
    blocks.at(-1)?.writes.push({ at, name });
  };
  const settle = () => {
    for (const name of chained) set(name, undefined, statement);
    chained = [];
  };
  const end = (at: number, next: string) => {
    if (statement !== -1 && prev !== "|" && prev !== "||" && next !== "|") {
      const assignment = ASSIGNMENT.exec(command.slice(statement, at).trim());
      if (assignment !== null) {
        const name = (assignment[1] ?? "").toLowerCase();
        set(name, assignedValue(assignment[2] ?? "", { ...SESSION_STATE, vars: env }), statement);
        if (prev === "&&") chained.push(name);
      }
    }
    statement = -1;
    prev = next;
  };
  let query = 0;
  for (let i = 0; i < scan.length; i++) {
    while (query < queries.length && (queries[query] ?? 0) <= i) snapshots.push({ at: queries[query++] ?? 0, vars: new Map(env) });
    const ch = scan.charAt(i);
    const pair = scan.slice(i, i + 2);
    if (pair === "${") {
      if (statement === -1) statement = i;
      i = Math.max(i, scan.indexOf("}", i));
    } else if (pair === "&&" || pair === "||") {
      end(i, pair);
      if (pair === "||") settle();
      i++;
    } else if (ch === "|") end(i, "|");
    else if (ch === ";" || ch === "\n" || ch === "\r") {
      end(i, "start");
      settle();
    } else if (ch === "{") {
      end(i, "start");
      settle();
      blocks.push({ start: i, writes: [] });
    } else if (ch === "}") {
      end(i, "start");
      settle();
      const block = blocks.pop();
      for (const snapshot of snapshots) {
        if (block === undefined || snapshot.at <= block.start) continue;
        for (const write of block.writes) if (write.at > snapshot.at) snapshot.vars.set(write.name, undefined);
      }
      for (const name of new Set(block?.writes.map((write) => write.name))) set(name, undefined, i);
    } else if (statement === -1 && !/[ \t]/.test(ch)) statement = i;
  }
  while (query < queries.length) snapshots.push({ at: queries[query++] ?? 0, vars: new Map(env) });
  return new Map(snapshots.map((snapshot) => [snapshot.at, { ...SESSION_STATE, vars: snapshot.vars }]));
}

/** Where each removal command's arguments start. */
export const powershellRemovalSites = (scan: string): number[] => [...scan.matchAll(REMOVAL)].map((match) => match.index + match[0].length);

/**
 * The recursive removals in a PowerShell command, each with its targets, variables substituted:
 * `Remove-Item` and its aliases with `-Recurse` (any unambiguous prefix of it), and the cmd forms
 * `rd /s`, `rmdir /s` and `del /s`. `isSubstituted` marks a target that holds a subexpression.
 */
export function powershellRemovals(
  command: string,
  scan: string,
  stateAt: (at: number) => ShellState,
): { isSubstituted: boolean; targets: string[] }[] {
  const found: { isSubstituted: boolean; targets: string[] }[] = [];
  for (const match of scan.matchAll(REMOVAL)) {
    const start = match.index + match[0].length;
    const end = powershellArgumentsEnd(command, scan, start);
    const word = (match.groups?.["word"] ?? "").replace(/^["']|["']$/g, "");
    const name = baseName("win32", word).toLowerCase().replace(/\.exe$/, "");
    const { isRecursive, isDryRun, targets } = parse(name, powershellWords(command.slice(start, end)));
    if (!isRecursive || isDryRun) continue;
    const state = stateAt(start);
    found.push({
      isSubstituted: scan.slice(start, end).replace(CWD_SUBSTITUTION.powershell, "").includes("$("),
      targets: targets.map((target) => substitute(target, state)),
    });
  }
  return found;
}
