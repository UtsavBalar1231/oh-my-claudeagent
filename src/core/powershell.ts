import { baseName } from "./path.ts";
import { anyCase, type Context, commandWord, type Removal, S } from "./shell.ts";
import { isCatastrophicTarget } from "./targets.ts";

export const POWERSHELL_COMMAND_POSITION = "[;&|(){}\\n\\r]";
// `cmd /c` runs the next word as a command, quoted or not, but only where `cmd` itself is one.
export const POWERSHELL_CMD_WRAPPER = `(?:${anyCase("cmd")}(?:\\.${anyCase("exe")})?${S}+/[cCkK]${S}+"?)?`;

const REMOVAL = new RegExp(
  `(^|${POWERSHELL_COMMAND_POSITION})${S}*(?:&${S}+)?${POWERSHELL_CMD_WRAPPER}(?<word>${commandWord(anyCase("Remove-Item|ri|rm|del|erase|rd|rmdir"))})(?=${S}|$)`,
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

/**
 * Blanks what is not a command in PowerShell the way `neutralizeQuotedPositions` does for sh:
 * inside a quoted span or here-string the characters that open a command position become `_`,
 * and a comment is blanked whole. Length is preserved.
 */
export function neutralizePowershell(command: string): string {
  let quote = "";
  let out = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);
    const next = command.charAt(i + 1);
    if (quote === "") {
      const isHereString = (next === "'" || next === '"') && ch === "@" && /^[ \t]*\r?(\n|$)/.test(command.slice(i + 2));
      if (isHereString) {
        quote = `${next}@`;
        out += ch + next;
        i++;
      } else if (ch === "'" || ch === '"') {
        quote = ch;
        out += ch;
      } else if (ch === "<" && next === "#") {
        quote = "<#";
        out += "__";
        i++;
      } else if (ch === "#" && COMMENT_START.test(command.charAt(i - 1))) {
        quote = "#";
        out += "_";
      } else out += ch;
    } else if (quote === "'") {
      if (ch === "'") quote = "";
      out += ch !== "'" && (BLANKED.includes(ch) || ch === "$") ? "_" : ch;
    } else if (quote === '"') {
      if (ch === "`") {
        out += ch + next;
        i++;
      } else {
        if (ch === '"') quote = "";
        out += ch !== '"' && BLANKED.includes(ch) ? "_" : ch;
      }
    } else if (quote === "'@" || quote === '"@') {
      if (ch === "\n" && command.startsWith(quote, i + 1)) {
        out += `_${quote}`;
        i += quote.length;
        quote = "";
      } else out += quote === "'@" || BLANKED.includes(ch) ? "_" : ch;
    } else if (quote === "#") {
      if (ch === "\n") quote = "";
      out += ch === "\n" ? ch : "_";
    } else {
      if (ch === "#" && next === ">") {
        quote = "";
        out += "__";
        i++;
      } else out += "_";
    }
  }
  return out;
}

/** Splits arguments into words as PowerShell does: quotes removed, a backtick escapes, and a comma or white space ends a word. */
export function powershellWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let isOpen = false;
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
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      isOpen = true;
    } else if (ch === "`") {
      word += next;
      i++;
      isOpen = true;
    } else if (/[ \t\n\v\f\r,]/.test(ch)) {
      if (isOpen) words.push(word);
      word = "";
      isOpen = false;
    } else {
      word += ch;
      isOpen = true;
    }
  }
  if (isOpen) words.push(word);
  return words;
}

function parameterKind(name: string): string | undefined {
  const lower = name.toLowerCase();
  const exact = PARAMETERS.get(lower);
  if (exact !== undefined) return exact;
  const kinds = new Set([...PARAMETERS].filter(([full]) => full.startsWith(lower)).map(([, kind]) => kind));
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

// Arguments end at the next statement separator, an unbalanced `)`, a `}` and a comment. A
// `${name}` variable holds its own braces.
function argumentsEnd(command: string, scan: string, from: number): number {
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

function parse(command: string, words: readonly string[]): { isRecursive: boolean; targets: string[] } {
  const isCmd = CMD_NAMES.has(command);
  let isRecursive = false;
  const targets: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    const parameter = /^-([A-Za-z]+)(?::(.*))?$/s.exec(word);
    if (parameter !== null) {
      const kind = parameterKind(parameter[1] ?? "");
      const attached = parameter[2];
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
  return { isRecursive, targets };
}

/**
 * The recursive removals in a PowerShell command: `Remove-Item` and its aliases with `-Recurse`
 * (any unambiguous prefix of it), and the cmd forms `rd /s`, `rmdir /s` and `del /s`, also behind
 * `cmd /c`. A substituted target is catastrophic, as in sh.
 */
export function powershellRemovals(
  command: string,
  scan: string,
  ctx: Context,
): { isCatastrophic: boolean; removals: Removal[] } {
  const found: Removal[] = [];
  for (const match of scan.matchAll(REMOVAL)) {
    const start = match.index + match[0].length;
    const end = argumentsEnd(command, scan, start);
    const word = (match.groups?.["word"] ?? "").replace(/^["']|["']$/g, "");
    const name = baseName("win32", word).toLowerCase().replace(/\.exe$/, "");
    const { isRecursive, targets } = parse(name, powershellWords(command.slice(start, end)));
    if (!isRecursive) continue;
    if (scan.slice(start, end).includes("$(") || targets.some((target) => isCatastrophicTarget(target, ctx))) {
      return { isCatastrophic: true, removals: [] };
    }
    found.push({ targets });
  }
  return { isCatastrophic: false, removals: found };
}
