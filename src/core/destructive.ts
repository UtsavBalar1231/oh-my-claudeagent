import {
  neutralizePowershell,
  POWERSHELL_CMD_WRAPPER,
  POWERSHELL_COMMAND_POSITION,
  powershellRemovals,
} from "./powershell.ts";
import { anyCase, ARGUMENT, type Context, commandWord, NS, type Removal, S } from "./shell.ts";
import { isCatastrophicTarget } from "./targets.ts";

export type { Context, Removal } from "./shell.ts";

// Leading `VAR=value` assignments and an `env` wrapper run the same command, so the command
// position admits them.
const ENV_ASSIGN = `([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^ \\t\\n\\v\\f\\r;&|\`"']*)${S}+)*`;
const PREFIX = `${S}*${ENV_ASSIGN}(sudo${S}+)?(env${S}+)?(command${S}+(-p${S}+)?)?${ENV_ASSIGN}`;

const RM = new RegExp(
  `(^|[;&|()\`\\n\\r])${PREFIX}${commandWord("rm")}${S}+((-[a-zA-Z]+|--[a-zA-Z-]+)${S}+)*(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(${S}|$)`,
);
// One invocation's arguments run to the next separator; a `)` ends them too, so a removal
// inside `$(...)` does not swallow the rest of the outer command.
const RM_ARGS = /^([^;&|)`\n\r]*)([^]?)/;

const GIT_GLOBALS = `((-C${S}+${ARGUMENT}|-c${S}+${ARGUMENT}|-c${NS}+|--git-dir[= \\t\\n\\v\\f\\r]${ARGUMENT}|--work-tree[= \\t\\n\\v\\f\\r]${ARGUMENT}|--no-pager|--paginate|-p|--bare|--literal-pathspecs|--no-replace-objects)${S}+)*`;
const GIT_SUBCOMMAND = `(?<subcommand>reset["']?${S}+--hard|stash|clean|restore|rm${S}+-[a-zA-Z]*[rR][a-zA-Z]*|checkout(${S}+[^ \\t\\n\\v\\f\\r;&|\`]+)*${S}+--)`;

function gitPatterns(commandPosition: string, wrapper: string, git: string) {
  const at = `(?<=^|${commandPosition}|[$]\\()${S}*${wrapper}${PREFIX}${commandWord(git)}${S}+${GIT_GLOBALS}`;
  return {
    git: new RegExp(`${at}["']?${GIT_SUBCOMMAND}["']?(?=[ \\t\\n\\v\\f\\r);&|<>\`]|$)`, "g"),
    push: new RegExp(`${at}push(?=${S}|$)(?<args>[^;&|)\`\\n\\r]*)`, "g"),
  };
}
const BASH_GIT = gitPatterns("[;&|(`\\n\\r]", "", "git");
const POWERSHELL_GIT = gitPatterns(POWERSHELL_COMMAND_POSITION, POWERSHELL_CMD_WRAPPER, anyCase("git"));
const BASH: Context = { shell: "bash" };

export const RM_CATASTROPHIC_REASON =
  "Destructive rm -rf blocked: the target is the filesystem root, home, the working directory, or a directory directly under root or home. Name a deeper path explicitly.";
export const REVIEW_REFUSED_REASON =
  "The user refused this command in OMCA's review. Do not retry it; ask the user how to proceed.";
export const GIT_REASON =
  "Destructive git command blocked. If working tree is dirty, REPORT and STOP — never modify history. Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing.";

export type GitOperation = "reset --hard" | "stash" | "clean" | "restore" | "rm -r" | "checkout --" | "push --force";
export type GitFinding = { operation: GitOperation; remote?: string; branch?: string };
/**
 * `blocking` holds a git operation that discards work in the tree or the index, denied where no
 * dialog can show it; `advisory` holds only a recursive rm of a deeper path or a force push,
 * which runs where no dialog can show it.
 */
export type Reviewable = { kind: "blocking" | "advisory"; removals: Removal[]; git: GitFinding[] };
export type Finding = { kind: "catastrophic" } | Reviewable;

type Heredoc = { word: string; stripsTabs: boolean };

// Only a heredoc whose delimiter is quoted is inert: an unquoted body still runs `$(...)`.
const QUOTED_HEREDOC = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\([A-Za-z_][A-Za-z0-9_.-]*))/;

function blankBodies(command: string, from: number, pending: readonly Heredoc[]): string {
  let out = "";
  let at = from;
  for (const { word, stripsTabs } of pending) {
    while (at < command.length) {
      const eol = command.indexOf("\n", at);
      const line = command.slice(at, eol === -1 ? command.length : eol);
      const isTerminator = (stripsTabs ? line.replace(/^\t+/, "") : line).replace(/\r$/, "") === word;
      out += (isTerminator ? line : "_".repeat(line.length)) + (eol === -1 ? "" : "\n");
      at += line.length + 1;
      if (isTerminator) break;
    }
  }
  return out;
}

/**
 * Blanks the characters that open a command position inside a quoted span, so a mention is
 * never read as an invocation: `; & | ( )`, newline and CR become `_`, and inside single quotes
 * `$` and backtick too. The body of a heredoc with a quoted delimiter becomes `_` whole. Length
 * is preserved. An unbalanced quote reads the rest as quoted, which under-matches rather than
 * over-matches.
 */
export function neutralizeQuotedPositions(command: string): string {
  let quote = "";
  let out = "";
  const pending: Heredoc[] = [];
  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);
    const next = command.charAt(i + 1);
    if (quote !== "") {
      const isBlanked = ";&|()\n\r".includes(ch) || (quote === "'" && (ch === "$" || ch === "`"));
      out += isBlanked ? "_" : ch;
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === "\n" && pending.length > 0) {
      const bodies = blankBodies(command, i + 1, pending);
      pending.length = 0;
      out += ch + bodies;
      i += bodies.length;
    } else if (ch === "<" && next === "<" && command.charAt(i - 1) !== "<") {
      const heredoc = QUOTED_HEREDOC.exec(command.slice(i));
      if (heredoc === null) {
        out += ch;
      } else {
        pending.push({ word: heredoc[2] ?? heredoc[3] ?? heredoc[4] ?? "", stripsTabs: heredoc[1] === "-" });
        out += heredoc[0];
        i += heredoc[0].length - 1;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

const trimLines = (command: string) => command.replace(/^[ \t\v\f\r]+/gm, "");

/** Splits an argument list into words the way the shell would, quotes removed and `\ ` read as a space, for display. */
export function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let isOpen = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quote !== "") {
      if (ch === quote) quote = "";
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      isOpen = true;
    } else if (ch === "\\" && /[ \t]/.test(text.charAt(i + 1))) {
      word += text.charAt(i + 1);
      i++;
      isOpen = true;
    } else if (/[ \t\n\v\f\r]/.test(ch)) {
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

function operands(words: readonly string[]): string[] {
  let isEndOfOptions = false;
  return words.filter((word) => {
    if (isEndOfOptions) return true;
    if (word === "--") {
      isEndOfOptions = true;
      return false;
    }
    return !word.startsWith("-");
  });
}

function removals(command: string, scan: string, ctx: Context): { isCatastrophic: boolean; removals: Removal[] } {
  const found: Removal[] = [];
  let offset = 0;
  for (let match = RM.exec(scan); match !== null; match = RM.exec(scan.slice(offset))) {
    offset += match.index + match[0].length;
    const args = RM_ARGS.exec(scan.slice(offset));
    const scanned = args?.[1] ?? "";
    if (scanned.includes("$(") || args?.[2] === "`") return { isCatastrophic: true, removals: [] };
    const words = shellWords(command.slice(offset, offset + scanned.length));
    let isEndOfOptions = false;
    for (const word of words) {
      if (!isEndOfOptions && word === "--") isEndOfOptions = true;
      else if (!isEndOfOptions && word === "--no-preserve-root") return { isCatastrophic: true, removals: [] };
      else if ((isEndOfOptions || !word.startsWith("-")) && isCatastrophicTarget(word, ctx)) {
        return { isCatastrophic: true, removals: [] };
      }
    }
    found.push({ targets: operands(words) });
  }
  return { isCatastrophic: false, removals: found };
}

const TREE_OPERATIONS = ["reset --hard", "stash", "clean", "restore", "rm -r", "checkout --"] as const;

const treeOperation = (subcommand: string): GitOperation =>
  TREE_OPERATIONS.find((operation) => subcommand.startsWith(operation.split(" ")[0] ?? operation)) ?? "reset --hard";

function forcePush(args: string): GitFinding | undefined {
  const words = shellWords(args);
  const isForced =
    words.some((word) => /^(-[a-zA-Z]*f[a-zA-Z]*|--force|--force-with-lease(=.*)?)$/.test(word)) ||
    operands(words).slice(1).some((refspec) => refspec.startsWith("+"));
  if (!isForced) return undefined;
  const [remote, refspec] = operands(words);
  const branch = refspec?.replace(/^\+/, "").split(":").at(-1)?.replace(/^refs\/heads\//, "");
  return {
    operation: "push --force",
    ...(remote !== undefined && { remote }),
    ...(branch !== undefined && branch !== "" && { branch }),
  };
}

function gitFindings(command: string, scan: string, { git, push }: typeof BASH_GIT): GitFinding[] {
  const found = [...scan.matchAll(git)].map((match) => ({
    index: match.index,
    operation: treeOperation(match.groups?.["subcommand"] ?? ""),
  }));
  for (const match of scan.matchAll(push)) {
    const end = match.index + match[0].length;
    const finding = forcePush(command.slice(end - (match.groups?.["args"] ?? "").length, end));
    if (finding !== undefined) found.push({ index: match.index, ...finding });
  }
  return found.sort((a, b) => a.index - b.index).map(({ index: _, ...finding }) => finding);
}

function reviewable(removals: Removal[], git: GitFinding[]): Reviewable | undefined {
  if (removals.length === 0 && git.length === 0) return undefined;
  const isBlocking = git.some((finding) => finding.operation !== "push --force");
  return { kind: isBlocking ? "blocking" : "advisory", removals, git };
}

/**
 * Classifies a Bash or PowerShell command: a recursive removal of a machine-wide target (or with
 * a substituted target, or `--no-preserve-root`) is catastrophic; a hard reset, stash, clean,
 * restore, recursive git rm or path checkout is blocking; any other recursive removal and a force
 * push are advisory. A match needs a command position, so a quoted mention is not one. `ctx`
 * names the shell and what is known of the session: its home, working directory and project root.
 */
export function classify(command: string, ctx: Context = BASH): Finding | undefined {
  const trimmed = trimLines(command);
  const isPowershell = ctx.shell === "powershell";
  const scan = isPowershell ? neutralizePowershell(trimmed) : neutralizeQuotedPositions(trimmed);
  const rm = isPowershell ? powershellRemovals(trimmed, scan, ctx) : removals(trimmed, scan, ctx);
  if (rm.isCatastrophic) return { kind: "catastrophic" };
  return reviewable(rm.removals, gitFindings(trimmed, scan, isPowershell ? POWERSHELL_GIT : BASH_GIT));
}

/** The deny reason for each kind; an advisory match is denied only by a refusal. */
export function reasonFor(finding: Finding): string {
  switch (finding.kind) {
    case "catastrophic":
      return RM_CATASTROPHIC_REASON;
    case "blocking":
      return GIT_REASON;
    case "advisory":
      return REVIEW_REFUSED_REASON;
  }
}
