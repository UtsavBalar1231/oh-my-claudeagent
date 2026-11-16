import { GIT_STASH_HEAD, GIT_TRACKED_HEAD, GIT_UNREADABLE_HEAD, GIT_UNTRACKED_HEAD, type RepoCheck, type Repository } from "./git-state.ts";
import { baseName, joinPath } from "./path.ts";
import {
  expandPowershellWord,
  neutralizePowershell,
  POWERSHELL_COMMAND_POSITION,
  powershellArgumentsEnd,
  powershellRemovalSites,
  powershellRemovals,
  powershellWordSpans,
  walkPowershell,
  type Word,
} from "./powershell.ts";
import { anyCase, ARGUMENT, type Context, commandWord, NS, S } from "./shell.ts";
import { ANCHORED, type Base, expandWord, MKTEMP_SUBSTITUTION, type RawWord, rawWords, SESSION_STATE, type ShellState, walkBash, withoutRedirections } from "./shell-state.ts";
import { CWD_SUBSTITUTION, homeRest, isCatastrophicTarget, platformOf, unknownVariable } from "./targets.ts";

export type { Context } from "./shell.ts";
export type { RepoCheck } from "./git-state.ts";

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

const RM = new RegExp(`(^|[;&|()\`\\n\\r])${S}*${PREFIX}${commandWord("rm")}(?=${S}|$)`);
// One invocation's arguments run to the next separator; a `)` ends them too, so a removal
// inside `$(...)` does not swallow the rest of the outer command. A substitution that reads as
// the working directory or a new temporary path is part of its argument.
const RM_ARGS = new RegExp(`^((?:${CWD_SUBSTITUTION.bash.source}|${MKTEMP_SUBSTITUTION.source}|[^;&|)\`\\n\\r])*)([^]?)`);

const GIT_GLOBALS = `((-C${S}+${ARGUMENT}|-c${S}+${ARGUMENT}|-c${NS}+|--git-dir[= \\t\\n\\v\\f\\r]${ARGUMENT}|--work-tree[= \\t\\n\\v\\f\\r]${ARGUMENT}|--no-pager|--paginate|-p|--bare|--literal-pathspecs|--no-replace-objects)${S}+)*`;

function gitPatterns(commandPosition: string, git: string) {
  const at = `(?<=^|${commandPosition})${S}*${PREFIX}${commandWord(git)}${S}+(?<globals>${GIT_GLOBALS})`;
  return {
    push: new RegExp(`${at}push(?=${S}|$)(?<args>[^;&|)\`\\n\\r]*)`, "g"),
    argued: new RegExp(`${at}["']?(?<word>reset|restore|checkout|stash|clean|commit)["']?(?=${S}|$)`, "gd"),
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

const RM_HEAD = "Destructive rm -rf blocked:";
export const RM_CATASTROPHIC_REASON = `${RM_HEAD} the target is the filesystem root, home, the working directory, or a directory directly under root or home. Name a deeper path explicitly.`;
export const RM_VARIABLE_HEAD = `${RM_HEAD} the target starts with a variable that can be unset or empty when the rm runs`;
export const RM_SUBSTITUTION_REASON = `${RM_HEAD} a target holds a command substitution the guard cannot evaluate, so it can name any path. Run the substitution on its own first, then remove the path it prints by name.`;
export const RM_CD_FAILED_HEAD = `${RM_HEAD} the rm can run after its cd failed`;
export const RM_CD_UNKNOWN_HEAD = `${RM_HEAD} the rm follows a cd into a directory the guard cannot resolve`;
export const RM_NO_PRESERVE_ROOT_REASON = `${RM_HEAD} --no-preserve-root lets rm remove the filesystem root. Drop the option and name the path to remove.`;
export const FORCE_PUSH_REASON =
  "Force push to the default branch blocked: it rewrites history everyone else has pulled. Push to another branch, or ask the user to push. Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing.";
export const NO_VERIFY_REASON =
  "git commit --no-verify blocked: it skips the repository's commit hooks. Fix what the hook reports and commit without the flag. Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing.";

function rmVariableReason(variable: string, target: string, state: ShellState, shell: Context["shell"]): string {
  const name = variable.replace(/^\$\{?|\}$/g, "");
  const empty = target.slice(variable.length);
  const cause = state.maybe.has(name)
    ? ` It is assigned only where the assignment may not run (after && or ||, in a pipeline, or in a block or loop), so it can still be unset.`
    : "";
  const remedy =
    shell === "bash"
      ? `Assign ${name} in a statement of its own that always runs before the rm (${name}=/path/to/dir; cd dir && rm -rf "$${name}/..."), or write \${${name}:?} so the shell stops when ${name} is unset or empty.`
      : `Assign ${variable} in a statement of its own before the removal, or name the path explicitly.`;
  return `${RM_VARIABLE_HEAD}: ${variable}.${cause} Then ${target} is ${empty}. ${remedy}`;
}

const rmCdFailedReason = (target: string): string =>
  `${RM_CD_FAILED_HEAD}: a cd joined to it by ; or a newline leaves the rm in the original directory when the cd fails, and there ${target} is protected. Join them with && (cd dir && rm -rf ...) so the rm runs only after the cd succeeds.`;
const rmCdUnknownReason = (target: string): string =>
  `${RM_CD_UNKNOWN_HEAD}, so it judges ${target} in the working directory, where it is protected. cd into a literal path or a variable assigned in the same command, or name the full path in the rm.`;

/** How each automatic deny reason starts, what it is called and what it advises, for a surface that shows a refusal without the reason's full text. */
export const GUARD_REASONS: readonly { head: string; title: string; remedy: string }[] = [
  { head: RM_CATASTROPHIC_REASON, title: "rm -rf on a protected path", remedy: "name a deeper path explicitly" },
  { head: RM_VARIABLE_HEAD, title: "rm -rf on an unset variable", remedy: "assign the variable in the same command" },
  { head: RM_SUBSTITUTION_REASON, title: "rm -rf on a command substitution", remedy: "remove the printed path by name" },
  { head: RM_CD_FAILED_HEAD, title: "rm -rf after a cd that can fail", remedy: "join the cd and the rm with &&" },
  { head: RM_CD_UNKNOWN_HEAD, title: "rm -rf after an unresolved cd", remedy: "cd into a literal path, or name the full path" },
  { head: RM_NO_PRESERVE_ROOT_REASON, title: "rm -rf --no-preserve-root", remedy: "drop the option" },
  { head: GIT_TRACKED_HEAD, title: "git command discarding changes", remedy: "commit or stash the changes first, or report and stop" },
  { head: GIT_UNTRACKED_HEAD, title: "git clean of untracked files", remedy: "keep what should stay first, or report and stop" },
  { head: GIT_STASH_HEAD, title: "dropping stashed changes", remedy: "apply or commit the stash first, or report and stop" },
  { head: GIT_UNREADABLE_HEAD, title: "repository state unreadable", remedy: "run git status yourself, then report and stop" },
  { head: FORCE_PUSH_REASON, title: "force push to the default branch", remedy: "push to another branch, or ask the user to push" },
  { head: NO_VERIFY_REASON, title: "git commit --no-verify", remedy: "fix what the hook reports and commit without the flag" },
];

/**
 * `catastrophic` is a recursive removal of a protected path, denied with no switch. `git` holds
 * what the git rules found: `reason` when one is denied outright (a force push to the default
 * branch, a commit that skips its hooks), the whole-tree operations to check against the
 * repository, and whether a force push appeared at all, since only the branches decide it.
 * `removal` is a recursive removal that runs; the session's home and directories can still make
 * it catastrophic, so a caller that classified without them classifies again with them.
 */
export type Finding =
  | { kind: "catastrophic"; reason: string }
  | { kind: "removal" }
  | { kind: "git"; reason?: string; checks: RepoCheck[]; isForcePush: boolean };

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
const trimLines = (command: string): string => command.replace(/^[ \t\v\f\r]+/gm, "");

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

/** A command inside a backtick substitution ends at the closing backtick, before `end`. */
function backtickEnd(scan: string, start: number, end: number): number {
  const isInBackticks = (scan.slice(0, start).match(/`/g) ?? []).length % 2 === 1;
  const close = isInBackticks ? scan.indexOf("`", start) : -1;
  return close === -1 ? end : Math.min(close, end);
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
type GitHit = { reason?: string; check?: RepoCheck; isForcePush?: boolean };
type Found = { catastrophic?: string; removes: boolean; git: Located<GitHit>[] };
type Span = { start: number; end: number };
/** One rm's arguments; `opensBacktick` marks arguments cut short by a backtick substitution they start. */
type Invocation = { start: number; end: number; scanned: string; opensBacktick: boolean };

function rmInvocations(scan: string): Invocation[] {
  const found: Invocation[] = [];
  let offset = 0;
  for (let match = RM.exec(scan); match !== null; match = RM.exec(scan.slice(offset))) {
    const start = offset + match.index + match[0].length;
    const args = RM_ARGS.exec(scan.slice(start));
    const scanned = args?.[1] ?? "";
    offset = start + scanned.length;
    const closesItsSubstitution = (scan.slice(0, start).match(/`/g) ?? []).length % 2 === 1;
    found.push({ start, end: offset, scanned, opensBacktick: args?.[2] === "`" && !closesItsSubstitution });
  }
  return found;
}

/** A word with its quotes removed, for reading it as an option. */
const plainWord = (raw: string): string => shellWords(raw).join(" ");

/**
 * The reason a target is catastrophic from one of the directories the command can be in there,
 * if it is. A relative target is judged under each; under the one a failed `cd` leaves, the
 * reason names the `cd`.
 */
function targetReason(target: string, state: ShellState, ctx: Context): string | undefined {
  const judged = (path: string): string | undefined => {
    if (!isCatastrophicTarget(path, ctx)) return undefined;
    const variable = unknownVariable(path, ctx);
    return variable === undefined ? RM_CATASTROPHIC_REASON : rmVariableReason(variable, path, state, ctx.shell);
  };
  if (ANCHORED.test(target) || target.startsWith("$")) return judged(target);
  for (const base of state.bases) {
    if (base.dir === undefined) {
      if (isCatastrophicTarget(target, ctx)) return rmCdUnknownReason(target);
      continue;
    }
    const reason = judged(base.dir === "" ? target : `${base.dir.replace(/[\\/]+$/, "")}/${target}`);
    if (reason !== undefined) return base.isFallback ? rmCdFailedReason(target) : reason;
  }
  return undefined;
}

// GNU rm reads options anywhere before `--`, so `rm ~ -rf` is as recursive as `rm -rf ~`.
/** A recursive removal with its deny reason, which is undefined when it runs, or undefined when the rm is not recursive. */
function recursiveRemoval(command: string, invocation: Invocation, state: ShellState, ctx: Context): { reason: string | undefined } | undefined {
  const options: string[] = [];
  const operands: RawWord[] = [];
  let isEndOfOptions = false;
  for (const word of withoutRedirections(rawWords(command, invocation.start, invocation.end))) {
    const text = plainWord(word.raw);
    if (isEndOfOptions) operands.push(word);
    else if (text === "--") isEndOfOptions = true;
    else if (text.startsWith("-")) options.push(text);
    else operands.push(word);
  }
  if (!options.some(isRecursiveRm)) return undefined;
  const scanned = invocation.scanned.replace(CWD_SUBSTITUTION.bash, "").replace(MKTEMP_SUBSTITUTION, "");
  if (scanned.includes("$(") || invocation.opensBacktick) return { reason: RM_SUBSTITUTION_REASON };
  if (options.some((option) => abbreviates(option, "--no-preserve-root", 4))) return { reason: RM_NO_PRESERVE_ROOT_REASON };
  for (const operand of operands) {
    const reason = targetReason(expandWord(operand.raw, state) ?? plainWord(operand.raw), state, ctx);
    if (reason !== undefined) return { reason };
  }
  return { reason: undefined };
}

/** Whether `word` spells the long option `option` or a prefix of it at least `shortest` characters long, as git and GNU tools accept. */
const abbreviates = (word: string, option: string, shortest: number): boolean => word.length >= shortest && option.startsWith(word);

const isRecursiveRm = (option: string): boolean => /^-(?!-)[a-zA-Z]*[rR]/.test(option) || abbreviates(option, "--recursive", 3);

/** `git restore` discards work only where it writes the worktree: with `--worktree`, or without `--staged`. */
function restoresWorktree(words: readonly string[]): boolean {
  let isStaged = false;
  let isWorktree = false;
  for (const option of splitOptions(words).options) {
    if (option.startsWith("--")) {
      if (abbreviates(option, "--staged", 4)) isStaged = true;
      else if (abbreviates(option, "--worktree", 3)) isWorktree = true;
      continue;
    }
    for (const letter of option.slice(1)) {
      if (letter === "s") break;
      if (letter === "S") isStaged = true;
      if (letter === "W") isWorktree = true;
    }
  }
  return isWorktree || !isStaged;
}

const FORCE = /^(?:-[a-zA-Z]*f[a-zA-Z]*|--force|--force-with-lease(?:=.*)?|--force-if-includes|--mirror)$/;
const EVERY_BRANCH = /^--(?:all|branches|mirror)$/;

const isDefaultBranch = (branch: string, ctx: Context): boolean =>
  ctx.defaultBranch === undefined ? branch === "main" || branch === "master" : branch === ctx.defaultBranch;

const refspecBranch = (refspec: string): string | undefined =>
  refspec.replace(/^\+/, "").split(":").at(-1)?.replace(/^refs\/heads\//, "");

/**
 * Whether a force push forces the default branch, or undefined when the push forces nothing: a
 * refspec's destination, or the checked-out branch when it names none or names `HEAD`, or every
 * branch under `--all`.
 */
function forcesDefault(args: string, ctx: Context): boolean | undefined {
  const words = shellWords(args);
  const { options, operands } = splitOptions(words);
  const refspecs = operands.slice(1);
  const isForced = words.some((word) => FORCE.test(word));
  const forced = isForced ? refspecs : refspecs.filter((refspec) => refspec.startsWith("+"));
  if (forced.length === 0 && !isForced) return undefined;
  const targets = refspecs.length === 0 ? [ctx.branch] : forced.map(refspecBranch);
  const pushed = targets.map((branch) => (branch === "HEAD" || branch === "@" ? ctx.branch : branch));
  return options.some((option) => EVERY_BRANCH.test(option)) || pushed.some((target) => target !== undefined && isDefaultBranch(target, ctx));
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
      for (const [at, letter] of Array.from(word.slice(1)).entries()) {
        if (letter === "n") skips = true;
        if ("mFcCt".includes(letter) && at === word.length - 2) i++;
        if ("mFcCtSu".includes(letter)) break;
      }
    }
  }
  return skips;
}

// A pathspec that names the whole tree, or the whole of the directory git runs in.
const WHOLE_TREE = /^(?:\.{1,2}(?:[\\/]+\.{1,2})*[\\/]*\*?|:\/?\.?\*?|\*)$/;

/**
 * The options of a `git clean` dry run that lists what the command would delete, or undefined
 * when the command is a dry run itself. A pathspec the shell expands first (a variable, a
 * substitution, `~` or a glob) is dropped, so the dry run lists a superset.
 */
function cleanDryRun(words: readonly string[]): string[] | undefined {
  const kept = new Set<string>();
  const paths: string[] = [];
  let forces = 0;
  let isEndOfOptions = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    if (isEndOfOptions || !word.startsWith("-") || word === "-") paths.push(word);
    else if (word === "--") isEndOfOptions = true;
    else if (word.startsWith("--")) {
      const name = word.split("=")[0] ?? "";
      if (abbreviates(name, "--dry-run", 4)) return undefined;
      if (abbreviates(name, "--force", 4)) forces++;
      else if (abbreviates(name, "--exclude", 4) && !word.includes("=")) i++;
    } else {
      for (const [at, letter] of Array.from(word.slice(1)).entries()) {
        if (letter === "n") return undefined;
        if (letter === "f") forces++;
        if ("dxX".includes(letter)) kept.add(`-${letter}`);
        if (letter === "e") {
          if (at === word.length - 2) i++;
          break;
        }
      }
    }
  }
  const isLiteral = paths.length > 0 && paths.every((path) => !/[$`~*?[]/.test(path));
  return [...kept, ...Array.from({ length: forces }, () => "-f"), ...(isLiteral ? ["--", ...paths] : [])];
}

type Discard = Omit<RepoCheck, "at">;

// git reads options anywhere before `--`, so these subcommands are judged on their whole argument list.
const DISCARDS: Readonly<Record<string, (words: readonly string[]) => Discard | undefined>> = {
  reset: (words) =>
    splitOptions(words).options.some((option) => abbreviates(option, "--hard", 4)) ? { operation: "git reset --hard", query: "tracked" } : undefined,
  restore: (words) =>
    restoresWorktree(words) && splitOptions(words).operands.some((word) => WHOLE_TREE.test(word)) ? { operation: "git restore .", query: "tracked" } : undefined,
  checkout: (words) => (splitOptions(words).operands.some((word) => WHOLE_TREE.test(word)) ? { operation: "git checkout .", query: "tracked" } : undefined),
  stash: (words) => {
    const subcommand = words.find((word) => !word.startsWith("-"));
    return subcommand === "drop" || subcommand === "clear" ? { operation: `git stash ${subcommand}`, query: "stash" } : undefined;
  },
  clean: (words) => {
    const clean = cleanDryRun(words);
    return clean === undefined ? undefined : { operation: "git clean", query: "untracked", clean };
  },
};

/** A directory a git command runs in, as git reads it: a home reference is expanded, and any other variable is unknown. */
function resolveDir(dir: string | undefined, ctx: Context): string | undefined {
  if (dir === undefined) return undefined;
  const rest = homeRest(dir);
  if (rest !== undefined) return ctx.home === undefined ? undefined : joinPath(platformOf(ctx), ctx.home, rest);
  return dir.startsWith("$") ? undefined : dir;
}

/** The repositories a git command can run in: each directory the command can be in, moved by `-C`, with `--git-dir` and `--work-tree`. */
function repositories(globals: string, state: ShellState, ctx: Context, expand: (raw: string) => string | undefined): Repository[] {
  const words = rawWords(globals);
  let dirs = state.bases.map((base) => resolveDir(base.dir, ctx));
  const repo: Omit<Repository, "dir"> = {};
  let isKnown = true;
  const valueOf = (raw: string | undefined) => (raw === undefined ? undefined : resolveDir(expand(raw), ctx));
  for (let i = 0; i < words.length; i++) {
    const word = words[i]?.raw ?? "";
    const long = /^--(git-dir|work-tree)(?:=(.*))?$/s.exec(word);
    if (word === "-C") {
      const dir = valueOf(words[++i]?.raw);
      dirs = dirs.map((base) => (base === undefined || dir === undefined ? undefined : ANCHORED.test(dir) || base === "" ? dir : `${base}/${dir}`));
    } else if (word === "-c") i++;
    else if (long !== null) {
      const value = valueOf(long[2] ?? words[++i]?.raw);
      if (value === undefined) isKnown = false;
      else if (long[1] === "git-dir") repo.gitDir = value;
      else repo.workTree = value;
    }
  }
  return dirs.map((dir) => ({ dir: isKnown ? dir : undefined, ...repo }));
}

type GitScan = { push: RegExpMatchArray[]; argued: RegExpMatchArray[] };

function gitMatches(scan: string, ctx: Context): GitScan {
  const { push, argued } = ctx.shell === "powershell" ? POWERSHELL_GIT : BASH_GIT;
  return { push: [...scan.matchAll(push)], argued: [...scan.matchAll(argued)] };
}

function gitFindings(command: string, scan: string, matches: GitScan, ctx: Context, stateAt: (at: number) => ShellState, expand: (raw: string, state: ShellState) => string | undefined): Located<GitHit>[] {
  const found: Located<GitHit>[] = [];
  for (const match of matches.push) {
    const end = (match.index ?? 0) + match[0].length;
    const isDefault = forcesDefault(command.slice(end - (match.groups?.["args"] ?? "").length, end), ctx);
    if (isDefault !== undefined) found.push({ index: match.index ?? 0, isForcePush: true, ...(isDefault && { reason: FORCE_PUSH_REASON }) });
  }
  // A commit's arguments are read once, so a commit nested in its own message is not read again;
  // a tree operation inside a commit message still counts.
  const reached = { commit: 0, tree: 0 };
  for (const match of matches.argued) {
    const index = match.index ?? 0;
    const word = match.groups?.["word"] ?? "";
    const kind = word === "commit" ? "commit" : "tree";
    if (index < reached[kind]) continue;
    const start = index + match[0].length;
    reached[kind] = ctx.shell === "powershell" ? powershellArgumentsEnd(command, scan, start) : backtickEnd(scan, start, argumentsEnd(scan, start));
    const words = shellWords(command.slice(start, reached[kind]));
    if (word === "commit") {
      if (skipsHooks(words)) found.push({ index, reason: NO_VERIFY_REASON });
      continue;
    }
    const discard = DISCARDS[word]?.(words);
    if (discard === undefined) continue;
    const [globalsStart = 0, globalsEnd = 0] = match.indices?.groups?.["globals"] ?? [];
    const state = stateAt(index);
    const at = repositories(command.slice(globalsStart, globalsEnd), state, ctx, (raw) => expand(raw, state));
    found.push({ index, check: { ...discard, at } });
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

function analyze(command: string, ctx: Context, depth: number, bases: readonly Base[]): Found {
  const trimmed = trimLines(command);
  const isPowershell = ctx.shell === "powershell";
  const { scan, bodies } = isPowershell ? { scan: neutralizePowershell(trimmed), bodies: [] } : neutralize(trimmed);
  const invocations = isPowershell ? [] : rmInvocations(scan);
  const sites = isPowershell ? powershellRemovalSites(scan) : [];
  const matches = gitMatches(scan, ctx);
  const nested = depth === NESTING_LIMIT ? [] : nestedScripts(trimmed, scan, bodies, ctx.shell);
  const queries = [
    ...new Set([
      ...invocations.map((invocation) => invocation.start),
      ...sites,
      ...matches.argued.map((match) => match.index ?? 0),
      ...nested.map((script) => script.index),
    ]),
  ].sort((a, b) => a - b);
  const states = isPowershell ? walkPowershell(trimmed, scan, queries) : walkBash(trimmed, scan, queries, ctx.home, bases, bodies);
  const stateAt = (at: number): ShellState => states.get(at) ?? SESSION_STATE;
  let removes = false;
  for (const invocation of invocations) {
    const removal = recursiveRemoval(trimmed, invocation, stateAt(invocation.start), ctx);
    if (removal?.reason !== undefined) return { catastrophic: removal.reason, removes: true, git: [] };
    removes ||= removal !== undefined;
  }
  for (const removal of isPowershell ? powershellRemovals(trimmed, scan, stateAt) : []) {
    if (removal.isSubstituted) return { catastrophic: RM_SUBSTITUTION_REASON, removes: true, git: [] };
    for (const target of removal.targets) {
      const reason = targetReason(target, SESSION_STATE, ctx);
      if (reason !== undefined) return { catastrophic: reason, removes: true, git: [] };
    }
    removes = true;
  }
  const git = gitFindings(trimmed, scan, matches, ctx, stateAt, isPowershell ? expandPowershellWord : expandWord);
  const spans: Span[] = [];
  const inner: Located<GitHit>[] = [];
  for (const script of nested) {
    const found = analyze(script.text, { ...ctx, shell: script.shell }, depth + 1, script.shell === "bash" ? stateAt(script.index).bases : SESSION_STATE.bases);
    if (found.catastrophic !== undefined) return found;
    removes ||= found.removes;
    spans.push(...script.spans);
    inner.push(...found.git.map((hit) => ({ ...hit, index: script.index })));
  }
  return { removes, git: [...outside(git, spans), ...inner].sort((a, b) => a.index - b.index) };
}

/**
 * Classifies a Bash or PowerShell command. A recursive removal of a machine-wide target is
 * catastrophic, with a reason that names the cause: the path itself, a variable the command does
 * not set, a command substitution, or a `cd` that may fail or cannot be resolved. A force push to
 * the default branch and a commit that skips its hooks carry their deny reason; a hard reset, a
 * whole-tree checkout or restore, a clean that is not a dry run and a stash drop or clear are
 * checks to run against the repository. A match needs a command position, so a quoted mention is
 * not one, and a script handed to a shell, `eval`, `pwsh -Command`, `cmd /c` or
 * `Invoke-Expression` is classified as commands of its own. `ctx` names the shell and what is
 * known of the session: its home, working directory, project root and branches.
 */
export function classify(command: string, ctx: Context = BASH): Finding | undefined {
  const found = analyze(command, ctx, 0, SESSION_STATE.bases);
  if (found.catastrophic !== undefined) return { kind: "catastrophic", reason: found.catastrophic };
  if (found.git.length === 0) return found.removes ? { kind: "removal" } : undefined;
  const reason = found.git.find((hit) => hit.reason !== undefined)?.reason;
  return {
    kind: "git",
    ...(reason !== undefined && { reason }),
    checks: found.git.flatMap((hit) => (hit.check === undefined ? [] : [hit.check])),
    isForcePush: found.git.some((hit) => hit.isForcePush === true),
  };
}
