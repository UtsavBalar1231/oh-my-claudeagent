import { baseName } from "./path.ts";
import {
  neutralizePowershell,
  POWERSHELL_COMMAND_POSITION,
  powershellArgumentsEnd,
  powershellRemovals,
  powershellWordSpans,
  type Word,
} from "./powershell.ts";
import { anyCase, ARGUMENT, type Context, commandWord, NS, type Removal, S } from "./shell.ts";
import { CWD_SUBSTITUTION, isCatastrophicTarget } from "./targets.ts";

export type { Context, Removal } from "./shell.ts";

// Leading `VAR=value` assignments, shell keywords that take a command (`then`, `do`, `!`, `{`, ...)
// and wrappers that run the command they are given (`sudo`, `env`, `command`, `timeout`, `nice`,
// `xargs`, ...) leave the command position where it is. A chain stops at a separator, each wrapper
// starts with its own name, and each of its options reads one way, so each chain splits one way
// and no two command positions scan the same token.
const H = "[ \\t\\v\\f]";
const ENV_ASSIGN = `(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^ \\t\\n\\v\\f\\r;&|()\`"']*)${H}+)*`;
const KEYWORDS = `(?:(?:then|do|else|elif|if|while|until|exec|!|\\{)${S}+)*`;
const SUDO_FLAGS = `(?:-[AbEHiKknPSsvV]+${S}+|-[ughpCDrtTU]${S}*${NS}+${S}+|--(?:[a-z-]+(?:=${NS}*)?)?${S}+)*`;
const ENV_FLAGS = `(?:-i${S}+|-[uCS]${S}*${NS}+${S}+|--(?:[a-z-]+(?:=${NS}*)?)?${S}+)*`;

// `valued` lists the short options that take a value, attached or as the next word, and `operand`
// is the word the wrapper reads before the command, such as timeout's duration.
function wrapper(name: string, valued = "", operand = ""): string {
  const short = valued === "" ? "-[a-zA-Z0-9]+" : `-[${valued}]${S}*${NS}+|-(?![${valued}])[a-zA-Z0-9]+`;
  return `${name}${S}+(?:(?:${short}|--[a-z-]+(?:=${NS}*)?)${S}+)*${operand === "" ? "" : `${operand}${S}+`}`;
}

const WRAPPERS = [
  `sudo${S}+${SUDO_FLAGS}`,
  `env${S}+${ENV_FLAGS}`,
  `command${S}+(?:-p${S}+)?`,
  wrapper("timeout", "ks", "[0-9][0-9.]*[smhd]?"),
  wrapper("nice", "n"),
  wrapper("nohup"),
  wrapper("stdbuf", "ioe"),
  wrapper("ionice", "cn"),
  wrapper("chrt", "TPD", "[0-9]+"),
  wrapper("setsid"),
  wrapper("time", "fo"),
  wrapper("xargs", "adEILnPs"),
].join("|");
const PREFIX = `${KEYWORDS}${ENV_ASSIGN}(?:(?:${WRAPPERS})${ENV_ASSIGN})*`;

const RM = new RegExp(
  `(^|[;&|()\`\\n\\r])${S}*${PREFIX}${commandWord("rm")}${S}+((-[a-zA-Z]+|--[a-zA-Z-]+)${S}+)*(-(?=[a-zA-Z]*[rR])[a-zA-Z]+|--recursive)(${S}|$)`,
);
// One invocation's arguments run to the next separator; a `)` ends them too, so a removal
// inside `$(...)` does not swallow the rest of the outer command. A substitution that reads as
// the working directory is part of its argument.
const RM_ARGS = new RegExp(`^((?:${CWD_SUBSTITUTION.bash.source}|[^;&|)\`\\n\\r])*)([^]?)`);

const GIT_GLOBALS = `((-C${S}+${ARGUMENT}|-c${S}+${ARGUMENT}|-c${NS}+|--git-dir[= \\t\\n\\v\\f\\r]${ARGUMENT}|--work-tree[= \\t\\n\\v\\f\\r]${ARGUMENT}|--no-pager|--paginate|-p|--bare|--literal-pathspecs|--no-replace-objects)${S}+)*`;
const GIT_TOKEN = "[^ \\t\\n\\v\\f\\r;&|`]+";
// A recursive `git rm` whatever flags precede `-r`, a path-restoring checkout, a stash that is not
// `list` or `show`, and a clean that is not a dry run. Arguments are read within one line (`${H}`), so a later line's `.` or `-n` is not this command's.
const GIT_SUBCOMMAND = `(?<subcommand>reset["']?${S}+--hard|stash(?!${H}+(?:list|show)(?=${S}|$))|clean(?!(?:${H}+${GIT_TOKEN})*?${H}+(?:-[a-zA-Z]*n[a-zA-Z]*|--dry-run)(?=${S}|$))|restore|rm(?:${H}+-[a-zA-Z-]+)*${H}+-[a-zA-Z]*[rR][a-zA-Z]*|checkout(?:${H}+${GIT_TOKEN})*${H}+(?:--|\\.(?:[\\/]${NS}*)?))`;

function gitPatterns(commandPosition: string, git: string) {
  const at = `(?<=^|${commandPosition})${S}*${PREFIX}${commandWord(git)}${S}+${GIT_GLOBALS}`;
  return {
    git: new RegExp(`${at}["']?${GIT_SUBCOMMAND}["']?(?=[ \\t\\n\\v\\f\\r);&|<>\`]|$)`, "g"),
    push: new RegExp(`${at}push(?=${S}|$)(?<args>[^;&|)\`\\n\\r]*)`, "g"),
    commit: new RegExp(`${at}commit(?=${S}|$)`, "g"),
  };
}
const BASH_GIT = gitPatterns("[;&|(`\\n\\r]", "git");
const POWERSHELL_GIT = gitPatterns(POWERSHELL_COMMAND_POSITION, anyCase("git"));
const BASH: Context = { shell: "bash" };

// A shell's `-c` script, an `eval` argument, a heredoc a shell reads, `pwsh -Command`, `cmd /c`
// and `Invoke-Expression` run as commands of their own, analyzed this many levels deep.
const NESTING_LIMIT = 4;
const SHELLS = "bash|sh|zsh|dash|ksh";
const POWERSHELLS = "pwsh|powershell";
const BASH_NESTED = new RegExp(
  `(?<=^|[;&|(\`\\n\\r])${S}*${PREFIX}(?<word>${commandWord(`${SHELLS}|${POWERSHELLS}`)}|eval)(?=${S}|$)`,
  "g",
);
const POWERSHELL_NESTED = new RegExp(
  `(?<=^|${POWERSHELL_COMMAND_POSITION})${S}*(?:&${S}+)?(?<word>${commandWord(anyCase(`${SHELLS}|${POWERSHELLS}|cmd|Invoke-Expression|iex`))})(?=${S}|$)`,
  "g",
);

export const RM_CATASTROPHIC_REASON =
  "Destructive rm -rf blocked: the target is the filesystem root, home, the working directory, or a directory directly under root or home. Name a deeper path explicitly.";
export const REVIEW_REFUSED_REASON =
  "The user refused this command in OMCA's review. Do not retry it; ask the user how to proceed.";
export const GIT_REASON =
  "Destructive git command blocked. If the working tree is dirty, REPORT and STOP. Never modify history. Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing.";
export const FORCE_PUSH_REASON =
  "Force push to the default branch blocked: it rewrites history everyone else has pulled. Push to another branch, or ask the user to push. Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing.";
export const NO_VERIFY_REASON =
  "git commit --no-verify blocked: it skips the repository's commit hooks. Fix what the hook reports and commit without the flag. Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing.";

export type GitOperation =
  | "reset --hard"
  | "stash"
  | "clean"
  | "restore"
  | "rm -r"
  | "checkout --"
  | "push --force"
  | "commit --no-verify";
export type GitFinding = { operation: GitOperation; remote?: string; branch?: string };
/**
 * `blocking` holds a git operation that discards work in the tree or the index, a force push to
 * the default branch or a commit that skips its hooks, denied where no dialog can show it;
 * `advisory` holds only a recursive rm of a deeper path or a force push to another branch, which
 * runs where no dialog can show it.
 */
export type Reviewable = { kind: "blocking" | "advisory"; removals: Removal[]; git: GitFinding[] };
export type Finding = { kind: "catastrophic" } | Reviewable;

type Heredoc = { word: string; stripsTabs: boolean; isQuoted: boolean; at: number };
/** A heredoc's body: the offset of its `<<`, where the body starts and ends, and its text. */
type Body = { at: number; start: number; end: number; text: string };

const HEREDOC = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\([A-Za-z_][A-Za-z0-9_.-]*)|([A-Za-z_][A-Za-z0-9_.-]*))/;

type OpenSubstitution = { depth: number; isInBackticks: boolean };

// An unquoted heredoc body is text in which only a `$(...)` or backtick span runs, and a span can
// cross lines. The span is kept as the command it is, a backslash-escaped character is text, and
// every other character becomes `_`. `span` carries the open span from one line to the next.
function blankLine(line: string, span: OpenSubstitution): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (span.depth === 0 && !span.isInBackticks) {
      if (ch === "\\") {
        out += i + 1 < line.length ? "__" : "_";
        i++;
        continue;
      }
      if (ch === "$" && line.charAt(i + 1) === "(") {
        span.depth = 1;
        out += "$(";
        i++;
      } else if (ch === "`") {
        span.isInBackticks = true;
        out += ch;
      } else {
        out += "_";
      }
      continue;
    }
    if (span.isInBackticks) span.isInBackticks = ch !== "`";
    else span.depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
    out += ch;
  }
  return out;
}

function blankBodies(command: string, from: number, pending: readonly Heredoc[], bodies: Body[]): string {
  let out = "";
  let at = from;
  for (const { word, stripsTabs, isQuoted, at: opener } of pending) {
    const span: OpenSubstitution = { depth: 0, isInBackticks: false };
    const start = at;
    const lines: string[] = [];
    let end = command.length;
    while (at < command.length) {
      const eol = command.indexOf("\n", at);
      const line = command.slice(at, eol === -1 ? command.length : eol);
      const stripped = stripsTabs ? line.replace(/^\t+/, "") : line;
      const isTerminator = stripped.replace(/\r$/, "") === word;
      out += (isTerminator ? line : isQuoted ? "_".repeat(line.length) : blankLine(line, span)) + (eol === -1 ? "" : "\n");
      if (isTerminator) end = at;
      else lines.push(stripped);
      at += line.length + 1;
      if (isTerminator) break;
    }
    bodies.push({ at: opener, start, end, text: lines.join("\n") });
  }
  return out;
}

type Frame = { kind: "'" | '"' | "$(" | "`"; depth: number };

/**
 * Blanks the characters that open a command position where they are text, so a mention is never
 * read as an invocation. Inside a quoted span `; & | ( )`, newline and CR become `_`, and inside
 * single quotes `$` and backtick too; outside quotes the same characters become `_` when a
 * backslash escapes them, and a backslash-newline reads as two spaces. A `$(...)` or backtick
 * substitution inside double quotes runs, so its text is left as the command it is, unless a
 * backslash escapes the opener. A heredoc body with a quoted delimiter becomes `_` whole; an
 * unquoted one keeps only its substitutions. Length is preserved. An unbalanced quote reads the
 * rest as quoted, which under-matches rather than over-matches.
 */
export const neutralizeQuotedPositions = (command: string): string => neutralize(command).scan;

function neutralize(command: string): { scan: string; bodies: Body[] } {
  const frames: Frame[] = [];
  let out = "";
  const pending: Heredoc[] = [];
  const bodies: Body[] = [];
  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);
    const next = command.charAt(i + 1);
    const top = frames.at(-1);
    if (top?.kind === "'") {
      out += ";&|()\n\r$`".includes(ch) ? "_" : ch;
      if (ch === "'") frames.pop();
    } else if (top?.kind === '"') {
      if (ch === "\\" && (next === "$" || next === "`" || next === "\\" || next === '"')) {
        out += ch + (next === "\\" ? next : "_");
        i++;
      } else if (ch === "$" && next === "(") {
        frames.push({ kind: "$(", depth: 0 });
        out += ch + next;
        i++;
      } else if (ch === "`") {
        frames.push({ kind: "`", depth: 0 });
        out += ch;
      } else {
        if (ch === '"') frames.pop();
        out += ch !== '"' && ";&|()\n\r".includes(ch) ? "_" : ch;
      }
    } else if (ch === "`" && top?.kind === "`") {
      frames.pop();
      out += ch;
    } else if (ch === ")" && top?.kind === "$(" && top.depth === 0) {
      frames.pop();
      out += ch;
    } else if (ch === "\\" && next !== "") {
      out += next === "\n" ? "  " : `\\${";&|()`'\"$<>".includes(next) ? "_" : next}`;
      i++;
    } else if (ch === "'" || ch === '"') {
      frames.push({ kind: ch, depth: 0 });
      out += ch;
    } else if (ch === "\n" && frames.length === 0 && pending.length > 0) {
      const blanked = blankBodies(command, i + 1, pending, bodies);
      pending.length = 0;
      out += ch + blanked;
      i += blanked.length;
    } else if (ch === "<" && next === "<" && command.charAt(i - 1) !== "<" && frames.length === 0) {
      const heredoc = HEREDOC.exec(command.slice(i));
      if (heredoc === null) {
        out += ch;
      } else {
        pending.push({
          word: heredoc[2] ?? heredoc[3] ?? heredoc[4] ?? heredoc[5] ?? "",
          stripsTabs: heredoc[1] === "-",
          isQuoted: heredoc[5] === undefined,
          at: i,
        });
        out += heredoc[0];
        i += heredoc[0].length - 1;
      }
    } else {
      if (top?.kind === "$(") top.depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
      out += ch;
    }
  }
  return { scan: out, bodies };
}

/** The command with each line's leading horizontal whitespace removed, so an indented line is read at its command position. */
export const trimLines = (command: string): string => command.replace(/^[ \t\v\f\r]+/gm, "");

/**
 * Splits an argument list into words the way the shell would, with where each starts: quotes
 * removed, `\ ` read as a space, and inside double quotes a backslash escaping `"`, `\`, `$` and
 * a backtick. Other backslashes stay, so a Windows path reads as written.
 */
function shellWordSpans(text: string): Word[] {
  const words: Word[] = [];
  let word = "";
  let quote = "";
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (quote !== "") {
      if (ch === quote) quote = "";
      else if (quote === '"' && ch === "\\" && next !== "" && '"\\$`'.includes(next)) {
        word += next;
        i++;
      } else word += ch;
    } else if (ch === "\\" && next === "\n") {
      i++;
    } else if (/[ \t\n\v\f\r]/.test(ch)) {
      if (start !== -1) words.push({ text: word, start });
      word = "";
      start = -1;
    } else {
      if (start === -1) start = i;
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "\\" && /[ \t]/.test(next)) {
        word += next;
        i++;
      } else word += ch;
    }
  }
  if (start !== -1) words.push({ text: word, start });
  return words;
}

/** Splits an argument list into words the way the shell would, for display. */
export const shellWords = (text: string): string[] => shellWordSpans(text).map((word) => word.text);

// An argument list ends at an unquoted separator or an unbalanced `)`. A `$(...)` or backtick span
// inside it belongs to it, and so does the `&` of a redirection such as `2>&1`.
function argumentsEnd(scan: string, from: number): number {
  let depth = 0;
  let isInBackticks = false;
  for (let i = from; i < scan.length; i++) {
    const ch = scan.charAt(i);
    const isRedirection = ch === "&" && (/[<>]/.test(scan.charAt(i - 1)) || scan.charAt(i + 1) === ">");
    if (ch === "`") isInBackticks = !isInBackticks;
    else if (isInBackticks) continue;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && ";&|\n\r".includes(ch) && !isRedirection) return i;
  }
  return scan.length;
}

/** Words before the first `--` that start with `-` are options; every other word, and every word after `--`, is an operand. */
function splitOptions(words: readonly string[]): { options: string[]; operands: string[] } {
  const options: string[] = [];
  const operands: string[] = [];
  let isEndOfOptions = false;
  for (const word of words) {
    if (isEndOfOptions) operands.push(word);
    else if (word === "--") isEndOfOptions = true;
    else (word.startsWith("-") ? options : operands).push(word);
  }
  return { options, operands };
}

type Located<T> = T & { index: number };
type GitHit = { finding: GitFinding; isBlocking: boolean };
type Found = { removals: Located<Removal>[]; git: Located<GitHit>[] };
type Span = { start: number; end: number };

function removals(command: string, scan: string, ctx: Context): { isCatastrophic: boolean; removals: Located<Removal>[] } {
  const found: Located<Removal>[] = [];
  let offset = 0;
  for (let match = RM.exec(scan); match !== null; match = RM.exec(scan.slice(offset))) {
    offset += match.index + match[0].length;
    const args = RM_ARGS.exec(scan.slice(offset));
    const scanned = args?.[1] ?? "";
    if (scanned.replace(CWD_SUBSTITUTION.bash, "").includes("$(") || args?.[2] === "`") {
      return { isCatastrophic: true, removals: [] };
    }
    const { options, operands } = splitOptions(shellWords(command.slice(offset, offset + scanned.length)));
    if (options.includes("--no-preserve-root") || operands.some((word) => isCatastrophicTarget(word, ctx))) {
      return { isCatastrophic: true, removals: [] };
    }
    found.push({ index: offset, targets: operands });
  }
  return { isCatastrophic: false, removals: found };
}

function treeOperation(subcommand: string): GitOperation {
  if (subcommand.startsWith("reset")) return "reset --hard";
  if (subcommand.startsWith("stash")) return "stash";
  if (subcommand.startsWith("clean")) return "clean";
  if (subcommand.startsWith("restore")) return "restore";
  if (subcommand.startsWith("rm")) return "rm -r";
  return "checkout --";
}

const FORCE = /^(?:-[a-zA-Z]*f[a-zA-Z]*|--force|--force-with-lease(?:=.*)?|--force-if-includes|--mirror)$/;
const EVERY_BRANCH = /^--(?:all|branches|mirror)$/;

const isDefaultBranch = (branch: string, ctx: Context): boolean =>
  ctx.defaultBranch === undefined ? branch === "main" || branch === "master" : branch === ctx.defaultBranch;

const refspecBranch = (refspec: string): string | undefined =>
  refspec.replace(/^\+/, "").split(":").at(-1)?.replace(/^refs\/heads\//, "");

/**
 * A force push, blocking when a branch it forces is the default one: a refspec's destination, or
 * the checked-out branch when it names none or names `HEAD`, or every branch under `--all`.
 */
function forcePush(args: string, ctx: Context): GitHit | undefined {
  const words = shellWords(args);
  const { options, operands } = splitOptions(words);
  const [remote, ...refspecs] = operands;
  const isForced = words.some((word) => FORCE.test(word));
  const forced = isForced ? refspecs : refspecs.filter((refspec) => refspec.startsWith("+"));
  if (forced.length === 0 && !isForced) return undefined;
  const targets = refspecs.length === 0 ? [ctx.branch] : forced.map(refspecBranch);
  const pushed = targets.map((branch) => (branch === "HEAD" || branch === "@" ? ctx.branch : branch));
  const branch = refspecs[0] === undefined ? undefined : refspecBranch(refspecs[0]);
  return {
    finding: {
      operation: "push --force",
      ...(remote !== undefined && { remote }),
      ...(branch !== undefined && branch !== "" && { branch }),
    },
    isBlocking:
      options.some((option) => EVERY_BRANCH.test(option)) ||
      pushed.some((target) => target !== undefined && isDefaultBranch(target, ctx)),
  };
}

// Long options of git commit whose value is the next word.
const COMMIT_VALUED = /^--(?:message|file|reuse-message|reedit-message|template|author|date|cleanup|fixup|squash|trailer|pathspec-from-file)$/;

/**
 * Whether `git commit` skips its hooks: `--no-verify` or a unique prefix of it, or `-n` in a short
 * option group before a letter that takes a value, unless a later `--verify` restores them.
 */
function skipsHooks(words: readonly string[]): boolean {
  let skips = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    if (word === "--") break;
    if (/^--no-veri(?:fy?)?$/.test(word)) skips = true;
    else if (/^--veri(?:fy?)?$/.test(word)) skips = false;
    else if (COMMIT_VALUED.test(word)) i++;
    else if (/^-[a-zA-Z]/.test(word)) {
      for (const [at, letter] of [...word.slice(1)].entries()) {
        if (letter === "n") skips = true;
        if ("mFcCt".includes(letter) && at === word.length - 2) i++;
        if ("mFcCtSu".includes(letter)) break;
      }
    }
  }
  return skips;
}

function gitFindings(command: string, scan: string, ctx: Context): Located<GitHit>[] {
  const isPowershell = ctx.shell === "powershell";
  const { git, push, commit } = isPowershell ? POWERSHELL_GIT : BASH_GIT;
  const found: Located<GitHit>[] = [...scan.matchAll(git)].map((match) => ({
    index: match.index,
    finding: { operation: treeOperation(match.groups?.["subcommand"] ?? "") },
    isBlocking: true,
  }));
  for (const match of scan.matchAll(push)) {
    const end = match.index + match[0].length;
    const hit = forcePush(command.slice(end - (match.groups?.["args"] ?? "").length, end), ctx);
    if (hit !== undefined) found.push({ index: match.index, ...hit });
  }
  let reached = 0;
  for (const match of scan.matchAll(commit)) {
    if (match.index < reached) continue;
    const start = match.index + match[0].length;
    reached = isPowershell ? powershellArgumentsEnd(command, scan, start) : argumentsEnd(scan, start);
    if (skipsHooks(shellWords(command.slice(start, reached)))) {
      found.push({ index: match.index, finding: { operation: "commit --no-verify" }, isBlocking: true });
    }
  }
  return found;
}

/** The words from `from` on: the word itself when it is the last, else the text as written from its start. */
function rest(words: readonly Word[], from: number, raw: string): string | undefined {
  const first = words[from];
  if (first === undefined) return undefined;
  return from === words.length - 1 ? first.text : raw.slice(first.start);
}

/**
 * The script an sh-family shell runs: its `-c` operand, or, when it reads commands from standard
 * input (no script file named, or `-s`), a here-string or the heredoc body it is given.
 */
function shellScript(words: readonly Word[], heredoc: Body | undefined): { text: string; body?: Body } | undefined {
  let isCommand = false;
  let readsStdin = false;
  let isEndOfOptions = false;
  let operand: string | undefined;
  let hereString: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]?.text ?? "";
    if (word.startsWith("<<<")) hereString = word === "<<<" ? words[++i]?.text : word.slice(3);
    else if (/^(?:[0-9]*[<>]|&>)/.test(word)) i += /^(?:[0-9]*[<>]+&?|&>>?)$/.test(word) ? 1 : 0;
    else if (operand !== undefined) continue;
    else if (!isEndOfOptions && (word === "--" || word === "-")) isEndOfOptions = true;
    else if (!isEndOfOptions && /^--(?:rcfile|init-file)$|^[-+][a-zA-Z]*o$/.test(word)) i++;
    else if (!isEndOfOptions && /^[-+][a-zA-Z-]/.test(word)) {
      isCommand ||= /^-[a-zA-Z]*c/.test(word);
      readsStdin ||= /^-[a-zA-Z]*s/.test(word);
    } else operand = word;
  }
  if (isCommand) return operand === undefined ? undefined : { text: operand };
  if (operand !== undefined && !readsStdin) return undefined;
  if (hereString !== undefined) return { text: hereString };
  return heredoc === undefined ? undefined : { text: heredoc.text, body: heredoc };
}

const COMMAND_PARAMETER = /^[-/](?:c|com(?:m(?:a(?:n(?:d)?)?)?)?)$/i;
const FILE_PARAMETER = /^[-/]f(?:i(?:le?)?)?$/i;

function innerScript(
  name: string,
  words: readonly Word[],
  raw: string,
  heredoc: Body | undefined,
): { text: string; shell: Context["shell"]; body?: Body } | undefined {
  const powershell = (text: string | undefined) => (text === undefined ? undefined : { text, shell: "powershell" as const });
  switch (name) {
    case "eval":
      return words.length === 0 ? undefined : { text: words.map((word) => word.text).join(" "), shell: "bash" };
    case "pwsh":
    case "powershell": {
      const at = words.findIndex((word) => COMMAND_PARAMETER.test(word.text) || FILE_PARAMETER.test(word.text));
      return at === -1 || FILE_PARAMETER.test(words[at]?.text ?? "") ? undefined : powershell(rest(words, at + 1, raw));
    }
    case "cmd": {
      const at = words.findIndex((word) => /^\/[ck]$/i.test(word.text));
      return at === -1 ? undefined : powershell(rest(words, at + 1, raw));
    }
    case "invoke-expression":
    case "iex": {
      const literal = words[COMMAND_PARAMETER.test(words[0]?.text ?? "") ? 1 : 0];
      return literal !== undefined && /^['"]/.test(raw.charAt(literal.start)) ? powershell(literal.text) : undefined;
    }
    default: {
      const script = shellScript(words, heredoc);
      return script === undefined ? undefined : { ...script, shell: "bash" };
    }
  }
}

type Nested = { index: number; text: string; shell: Context["shell"]; spans: Span[] };

/**
 * The scripts a command hands to another interpreter, each with the spans of the command it came
 * from: its arguments and the heredoc body it reads. A shell inside those spans is left to the
 * script's own analysis, so each character is read once per level.
 */
function nestedScripts(command: string, scan: string, bodies: readonly Body[], shell: Context["shell"]): Nested[] {
  const isPowershell = shell === "powershell";
  const found: Nested[] = [];
  const read: Body[] = [];
  let reached = 0;
  let nextBody = 0;
  let nextRead = 0;
  for (const match of scan.matchAll(isPowershell ? POWERSHELL_NESTED : BASH_NESTED)) {
    while ((read[nextRead]?.end ?? Number.POSITIVE_INFINITY) <= match.index) nextRead++;
    if (match.index < reached || (read[nextRead]?.start ?? Number.POSITIVE_INFINITY) <= match.index) continue;
    const start = match.index + match[0].length;
    reached = isPowershell ? powershellArgumentsEnd(command, scan, start) : argumentsEnd(scan, start);
    const raw = command.slice(start, reached);
    while ((bodies[nextBody]?.at ?? Number.POSITIVE_INFINITY) < start) nextBody++;
    let heredoc: Body | undefined;
    for (; (bodies[nextBody]?.at ?? Number.POSITIVE_INFINITY) < reached; nextBody++) heredoc = bodies[nextBody];
    const word = (match.groups?.["word"] ?? "").replace(/^["']|["']$/g, "");
    const name = baseName("win32", word).toLowerCase().replace(/\.exe$/, "");
    const words = isPowershell ? powershellWordSpans(raw) : shellWordSpans(raw);
    const script = innerScript(name, words, raw, heredoc);
    if (script === undefined) continue;
    if (script.body !== undefined) read.push(script.body);
    const spans = script.body === undefined ? [{ start, end: reached }] : [{ start, end: reached }, script.body];
    found.push({ index: match.index, text: script.text, shell: script.shell, spans });
  }
  return found;
}

/** The items whose index lies outside every span; the spans do not overlap. */
function outside<T extends { index: number }>(items: readonly T[], spans: readonly Span[]): T[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let at = 0;
  return [...items]
    .sort((a, b) => a.index - b.index)
    .filter(({ index }) => {
      while ((sorted[at]?.end ?? Number.POSITIVE_INFINITY) <= index) at++;
      return index < (sorted[at]?.start ?? Number.POSITIVE_INFINITY);
    });
}

function analyze(command: string, ctx: Context, depth: number): Found | "catastrophic" {
  const trimmed = trimLines(command);
  const isPowershell = ctx.shell === "powershell";
  const { scan, bodies } = isPowershell ? { scan: neutralizePowershell(trimmed), bodies: [] } : neutralize(trimmed);
  const rm = isPowershell ? powershellRemovals(trimmed, scan, ctx) : removals(trimmed, scan, ctx);
  if (rm.isCatastrophic) return "catastrophic";
  const git = gitFindings(trimmed, scan, ctx);
  if (depth === NESTING_LIMIT) return { removals: rm.removals, git };
  const spans: Span[] = [];
  const inner: Found = { removals: [], git: [] };
  for (const nested of nestedScripts(trimmed, scan, bodies, ctx.shell)) {
    const found = analyze(nested.text, { ...ctx, shell: nested.shell }, depth + 1);
    if (found === "catastrophic") return found;
    spans.push(...nested.spans);
    inner.removals.push(...found.removals.map((removal) => ({ ...removal, index: nested.index })));
    inner.git.push(...found.git.map((hit) => ({ ...hit, index: nested.index })));
  }
  const byIndex = (a: { index: number }, b: { index: number }) => a.index - b.index;
  return {
    removals: [...outside(rm.removals, spans), ...inner.removals].sort(byIndex),
    git: [...outside(git, spans), ...inner.git].sort(byIndex),
  };
}

/**
 * Classifies a Bash or PowerShell command: a recursive removal of a machine-wide target (or with
 * a substituted target, or `--no-preserve-root`) is catastrophic; a hard reset, stash, clean,
 * restore, recursive git rm, path checkout, force push to the default branch or commit that skips
 * its hooks is blocking; any other recursive removal and a force push to another branch are
 * advisory. A match needs a command position, so a quoted mention is not one, and a script handed
 * to a shell, `eval`, `pwsh -Command`, `cmd /c` or `Invoke-Expression` is classified as commands of
 * its own. `ctx` names the shell and what is known of the session: its home, working directory,
 * project root and branches.
 */
export function classify(command: string, ctx: Context = BASH): Finding | undefined {
  const found = analyze(command, ctx, 0);
  if (found === "catastrophic") return { kind: "catastrophic" };
  if (found.removals.length === 0 && found.git.length === 0) return undefined;
  return {
    kind: found.git.some((hit) => hit.isBlocking) ? "blocking" : "advisory",
    removals: found.removals.map(({ targets }) => ({ targets })),
    git: found.git.map((hit) => hit.finding),
  };
}

/**
 * The deny reason for each kind; an advisory match is denied only by a refusal. A blocking match
 * is named by its first finding that is not a force push, since a force push is blocking only to
 * the default branch.
 */
export function reasonFor(finding: Finding): string {
  switch (finding.kind) {
    case "catastrophic":
      return RM_CATASTROPHIC_REASON;
    case "blocking": {
      const operation = finding.git.find((git) => git.operation !== "push --force")?.operation;
      if (operation === undefined) return FORCE_PUSH_REASON;
      return operation === "commit --no-verify" ? NO_VERIFY_REASON : GIT_REASON;
    }
    case "advisory":
      return REVIEW_REFUSED_REASON;
  }
}
