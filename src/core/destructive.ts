const S = "[ \\t\\n\\v\\f\\r]";
const NS = "[^ \\t\\n\\v\\f\\r]";
// Leading `VAR=value` assignments and an `env` wrapper run the same command, so the command
// position admits them.
const ENV_ASSIGN = `([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^ \\t\\n\\v\\f\\r;&|\`"']*)${S}+)*`;
const PREFIX = `${S}*${ENV_ASSIGN}(sudo${S}+)?(env${S}+)?${ENV_ASSIGN}`;

const RM = new RegExp(
  `(^|[;&|()\`\\n\\r])${PREFIX}rm${S}+((-[a-zA-Z]+|--[a-zA-Z-]+)${S}+)*(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(${S}|$)`,
);
// One invocation's arguments run to the next separator; a `)` ends them too, so a removal
// inside `$(...)` does not swallow the rest of the outer command.
const RM_ARGS = /^([^;&|)`\n\r]*)([^]?)/;

const GIT_GLOBALS = `((-C${S}+${NS}+|-c${S}+${NS}+|-c${NS}+|--git-dir[= \\t\\n\\v\\f\\r]${NS}+|--work-tree[= \\t\\n\\v\\f\\r]${NS}+|--no-pager|--paginate|-p|--bare|--literal-pathspecs|--no-replace-objects)${S}+)*`;
const GIT_SUBCOMMAND = `(?<subcommand>reset["']?${S}+--hard|stash|clean|restore|rm${S}+-[a-zA-Z]*[rR][a-zA-Z]*|checkout(${S}+[^ \\t\\n\\v\\f\\r;&|\`]+)*${S}+--)`;
const GIT_AT = `(?<=^|[;&|(\`\\n\\r]|[$]\\()${PREFIX}git${S}+${GIT_GLOBALS}`;
const GIT = new RegExp(`${GIT_AT}["']?${GIT_SUBCOMMAND}["']?(?=[ \\t\\n\\v\\f\\r);&|<>\`]|$)`, "g");
const PUSH = new RegExp(`${GIT_AT}push(?=${S}|$)(?<args>[^;&|)\`\\n\\r]*)`, "g");

export const RM_CATASTROPHIC_REASON =
  "Destructive rm -rf blocked: the target is the filesystem root, home, the working directory, or a directory directly under root or home. Name a deeper path explicitly.";
export const REVIEW_REFUSED_REASON =
  "The user refused this command in OMCA's review. Do not retry it; ask the user how to proceed.";
export const GIT_REASON =
  "Destructive git command blocked. If working tree is dirty, REPORT and STOP — never modify history. Set OMCA_DISABLED_HOOKS=bash-guard to turn this check off for testing.";

export type GitOperation = "reset --hard" | "stash" | "clean" | "restore" | "rm -r" | "checkout --" | "push --force";
export type GitFinding = { operation: GitOperation; remote?: string; branch?: string };
export type Removal = { targets: string[] };
/**
 * `blocking` holds a git operation that discards work in the tree or the index, denied where no
 * dialog can show it; `advisory` holds only a recursive rm of a deeper path or a force push,
 * which runs where no dialog can show it.
 */
export type Reviewable = { kind: "blocking" | "advisory"; removals: Removal[]; git: GitFinding[] };
export type Finding = { kind: "catastrophic" } | Reviewable;

/**
 * Blanks the characters that open a command position inside a quoted span, so a mention is
 * never read as an invocation: `; & | ( )`, newline and CR become `_`, and inside single quotes
 * `$` and backtick too. Length is preserved. An unbalanced quote reads the rest as quoted,
 * which under-matches rather than over-matches.
 */
export function neutralizeQuotedPositions(command: string): string {
  let quote = "";
  let out = "";
  for (const ch of command) {
    let next = ch;
    if (quote !== "") {
      if (ch === quote) quote = "";
      else if (";&|()\n\r".includes(ch)) next = "_";
      else if (quote === "'" && (ch === "$" || ch === "`")) next = "_";
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    }
    out += next;
  }
  return out;
}

const trimLines = (command: string) => command.replace(/^[ \t\v\f\r]+/gm, "");

/**
 * Only a target whose loss is machine-wide is catastrophic: the root, home, the working
 * directory or a parent of it, and anything directly under the root or home. A leading `$VAR`
 * reads as empty, since `rm -rf "$DIR/"*` with DIR unset is the classic way to reach `/`; a
 * trailing glob removes its parent's contents, which is the parent's loss.
 */
export function isCatastrophicTarget(word: string): boolean {
  const target = word.replace(/["']/g, "");
  let rest = target;
  let limit = 0;
  const home = /^(~[^/]*|\$HOME|\$\{HOME\})(\/.*)?$/.exec(target);
  const variable = /^\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(target);
  if (home !== null) {
    rest = home[2] ?? "";
    limit = 1;
  } else if (variable !== null) {
    rest = variable[2] ?? "";
    limit = 1;
    if (!rest.startsWith("/")) return false;
  } else if (target.startsWith("/")) {
    limit = 1;
  }
  const kept: string[] = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (kept.length > 0 && kept.at(-1) !== "..") kept.pop();
      else if (limit === 0) kept.push("..");
    } else kept.push(part);
  }
  while (kept.at(-1) === "*" || kept.at(-1) === ".*") kept.pop();
  return limit === 0 ? kept.every((part) => part === "..") : kept.length <= limit;
}

/** Splits an argument list into words the way the shell would, quotes removed, for display. */
export function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let isOpen = false;
  for (const ch of text) {
    if (quote !== "") {
      if (ch === quote) quote = "";
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
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

function removals(command: string, scan: string): { isCatastrophic: boolean; removals: Removal[] } {
  const found: Removal[] = [];
  let offset = 0;
  for (let match = RM.exec(scan); match !== null; match = RM.exec(scan.slice(offset))) {
    offset += match.index + match[0].length;
    const args = RM_ARGS.exec(scan.slice(offset));
    const scanned = args?.[1] ?? "";
    if (scanned.includes("$(") || args?.[2] === "`") return { isCatastrophic: true, removals: [] };
    const words = scanned.split(/[ \t\n]+/).filter((word) => word !== "");
    let isEndOfOptions = false;
    for (const word of words) {
      if (!isEndOfOptions && word === "--") isEndOfOptions = true;
      else if (!isEndOfOptions && word === "--no-preserve-root") return { isCatastrophic: true, removals: [] };
      else if ((isEndOfOptions || !word.startsWith("-")) && isCatastrophicTarget(word)) {
        return { isCatastrophic: true, removals: [] };
      }
    }
    found.push({ targets: operands(shellWords(command.slice(offset, offset + scanned.length))) });
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

function gitFindings(command: string, scan: string): GitFinding[] {
  const found = [...scan.matchAll(GIT)].map((match) => ({
    index: match.index,
    operation: treeOperation(match.groups?.["subcommand"] ?? ""),
  }));
  for (const match of scan.matchAll(PUSH)) {
    const end = match.index + match[0].length;
    const push = forcePush(command.slice(end - (match.groups?.["args"] ?? "").length, end));
    if (push !== undefined) found.push({ index: match.index, ...push });
  }
  return found.sort((a, b) => a.index - b.index).map(({ index: _, ...finding }) => finding);
}

function reviewable(removals: Removal[], git: GitFinding[]): Reviewable | undefined {
  if (removals.length === 0 && git.length === 0) return undefined;
  const isBlocking = git.some((finding) => finding.operation !== "push --force");
  return { kind: isBlocking ? "blocking" : "advisory", removals, git };
}

/**
 * Classifies a Bash command: a recursive rm of a machine-wide target (or with a substituted
 * target, or `--no-preserve-root`) is catastrophic; a hard reset, stash, clean, restore, recursive
 * git rm or path checkout is blocking; any other recursive rm and a force push are advisory. A
 * match needs a command position, so a quoted mention is not one.
 */
export function classify(command: string): Finding | undefined {
  const trimmed = trimLines(command);
  const scan = neutralizeQuotedPositions(trimmed);
  const rm = removals(trimmed, scan);
  if (rm.isCatastrophic) return { kind: "catastrophic" };
  return reviewable(rm.removals, gitFindings(trimmed, scan));
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
