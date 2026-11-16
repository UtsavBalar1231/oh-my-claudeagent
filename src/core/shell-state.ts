/**
 * The directory a command runs in, relative to the session's working directory: `""` is that
 * directory itself and `undefined` one the guard cannot resolve. `isFallback` marks the directory
 * a command stays in when the `cd` before it fails or does not run.
 */
export type Base = { dir: string | undefined; isFallback: boolean };

/**
 * What the shell holds where a command starts: each variable's value (`undefined` when unknown),
 * the names whose assignment may not have run (after `&&` or `||`, in a pipeline, or in a block
 * or loop), and the directories it can run in.
 */
export type ShellState = { vars: ReadonlyMap<string, string | undefined>; maybe: ReadonlySet<string>; bases: readonly Base[] };

export const SESSION_STATE: ShellState = { vars: new Map(), maybe: new Set(), bases: [{ dir: "", isFallback: false }] };

/** What `$(mktemp ...)` reads as: a new path under the temporary directory, which is never empty. */
export const MKTEMP_PATH = "$TMPDIR/tmp.XXXXXXXXXX";
/** A `$(mktemp ...)` substitution: one simple command, with no separator, quote or nested substitution in it. */
export const MKTEMP_SUBSTITUTION = /\$\([ \t]*mktemp(?:[ \t]+[^()$`;&|<>'"\n]*)?\)/g;
const MKTEMP_COMMAND = /^[ \t]*mktemp(?:[ \t]+[^()$`;&|<>'"\n]*)?$/;
const PWD_COMMAND = /^[ \t]*pwd(?:[ \t]+-[LP])?[ \t]*$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/;
const INDEXED = /^([A-Za-z_][A-Za-z0-9_]*)\[/;
const FUNCTION_HEADER = /^(?:function[ \t]+([A-Za-z_][\w.:-]*)(?:[ \t]*\([ \t]*\))?|([A-Za-z_][\w.:-]*)[ \t]*\([ \t]*\))[ \t]*$/;
/** A path that does not depend on the directory the command runs in. */
export const ANCHORED = /^(?:[\\/~]|\$\{?(?:HOME|USERPROFILE)\b|[A-Za-z]:)/;
// More directories than this read as one the guard cannot resolve.
const MAX_BASES = 8;

/** The index of the `)` that closes the `(` at `open`, or the text's length when none does. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quote === "'") {
      if (ch === "'") quote = "";
    } else if (ch === "\\") i++;
    else if (quote === '"' && ch === '"') quote = "";
    else if ((ch === "'" || ch === '"') && quote === "") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return text.length;
}

const closeBacktick = (text: string, open: number): number => {
  const close = text.indexOf("`", open + 1);
  return close === -1 ? text.length : close;
};

/** Where the word that starts at `from` ends: at unquoted white space, with quotes, substitutions and `${...}` kept whole. */
function wordEnd(text: string, from: number, limit: number): number {
  let quote = "";
  for (let i = from; i < limit; i++) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (quote === "'") {
      if (ch === "'") quote = "";
    } else if (ch === "\\") i++;
    else if (ch === "$" && next === "(") i = closeParen(text, i + 1);
    else if (ch === "$" && next === "{" && quote === "") i = Math.max(i, text.indexOf("}", i));
    else if (ch === "`") i = closeBacktick(text, i);
    else if (quote === '"') {
      if (ch === '"') quote = "";
    } else if (/[ \t\n\v\f\r]/.test(ch)) return i;
    else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") i = closeParen(text, i);
  }
  return limit;
}

export type RawWord = { raw: string; start: number };

/** The word of `text` that starts at or after `from` and before `limit`, as written, or undefined when none is left. */
function wordAt(text: string, from: number, limit = text.length): (RawWord & { end: number }) | undefined {
  let i = from;
  while (i < limit && (/[ \t\n\v\f\r]/.test(text.charAt(i)) || (text.charAt(i) === "\\" && text.charAt(i + 1) === "\n"))) {
    i += text.charAt(i) === "\\" ? 2 : 1;
  }
  if (i >= limit) return undefined;
  const end = wordEnd(text, i, limit);
  return { raw: text.slice(i, end), start: i, end };
}

/** Splits an argument list into the words the shell reads, each as written. */
export function rawWords(text: string, from = 0, limit = text.length): RawWord[] {
  const words: RawWord[] = [];
  for (let word = wordAt(text, from, limit); word !== undefined; word = wordAt(text, word.end, limit)) words.push({ raw: word.raw, start: word.start });
  return words;
}

const REDIRECTION = /^(?:[0-9]*(?:<<<|<<-?|<>|>>|>\||[<>]&?)|&>>?)/;

/** The words that are not redirections: an operator alone drops the word after it too. */
export function withoutRedirections(words: readonly RawWord[]): RawWord[] {
  const kept: RawWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const raw = words[i]?.raw ?? "";
    const operator = REDIRECTION.exec(raw)?.[0];
    if (operator === undefined) kept.push(words[i] as RawWord);
    else if (operator === raw && !operator.endsWith("&")) i++;
  }
  return kept;
}

/** The working directory as a path, while the command is known to be in one directory. */
function pwdOf(state: ShellState): string | undefined {
  const [only, ...rest] = state.bases;
  if (only?.dir === undefined || rest.length > 0) return undefined;
  if (only.dir === "") return "$PWD";
  return ANCHORED.test(only.dir) ? only.dir : `$PWD/${only.dir}`;
}

/**
 * The word as the shell expands it, quotes removed: a backslash escapes a quote, `$`, a backtick
 * or a blank and any other stays, so a Windows path reads as written. A variable the command assigned takes its
 * value, and one it did not stays as written, so the target still reads as one that starts with
 * it. `$(mktemp ...)` reads as a temporary path and `$(pwd)` as the working directory. Any other
 * substitution or `${...}` operator gives undefined, and so does an unquoted value with a blank
 * in it, which the shell splits into words.
 */
export function expandWord(raw: string, state: ShellState): string | undefined {
  let out = "";
  let isQuoted = false;
  // `S=/` with `"$S"/home` is `/home`, not the share root `//home` the two slashes would spell.
  const insert = (value: string, next: number): boolean => {
    if (!isQuoted && /[ \t\n]/.test(value)) return false;
    out += /^["']*\//.test(raw.slice(next, next + 3)) ? value.replace(/\/+$/, "") : value;
    return true;
  };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i);
    const next = raw.charAt(i + 1);
    if (ch === "'" && !isQuoted) {
      const close = raw.indexOf("'", i + 1);
      if (close === -1) return undefined;
      out += raw.slice(i + 1, close);
      i = close;
    } else if (ch === '"') isQuoted = !isQuoted;
    else if (ch === "\\" && (isQuoted ? '$`"\\\n' : "$`\"' \t\n").includes(next) && next !== "") {
      out += next === "\n" ? "" : next;
      i++;
    } else if (ch === "`") return undefined;
    else if (ch === "$" && next === "(") {
      const close = closeParen(raw, i + 1);
      const inner = raw.slice(i + 2, close);
      const pwd = PWD_COMMAND.test(inner) ? pwdOf(state) : undefined;
      const value = MKTEMP_COMMAND.test(inner) ? MKTEMP_PATH : pwd;
      if (value === undefined || !insert(value, close + 1)) return undefined;
      i = close;
    } else if (ch === "$" && next === "{") {
      const close = raw.indexOf("}", i);
      if (close === -1) return undefined;
      const body = /^([A-Za-z_][A-Za-z0-9_]*)(:\?[^}]*)?$/.exec(raw.slice(i + 2, close));
      if (body === null) return undefined;
      const name = body[1] ?? "";
      if (!insert(state.vars.get(name) ?? (body[2] === undefined ? `\${${name}}` : `\${${name}:?}`), close + 1)) return undefined;
      i = close;
    } else if (ch === "$" && NAME.test(raw.slice(i + 1))) {
      const name = NAME.exec(raw.slice(i + 1))?.[0] ?? "";
      const value = name === "PWD" ? pwdOf(state) : state.vars.get(name);
      if ((name === "PWD" && value === undefined) || !insert(value ?? `$${name}`, i + 1 + name.length)) return undefined;
      i += name.length;
    } else out += ch;
  }
  return out;
}

/** A directory a `cd` names, or undefined when the guard cannot resolve it. */
function cdTarget(words: readonly RawWord[], state: ShellState, home: string | undefined): string | undefined {
  let at = 1;
  while (/^-[LPe@]+$/.test(words[at]?.raw ?? "")) at++;
  if (words[at]?.raw === "--") at++;
  const word = words[at];
  if (word === undefined) return home === undefined ? "~" : home;
  if (word.raw === "-") return undefined;
  const dir = expandWord(word.raw, state)?.replace(/^\$PWD(?:\/+|$)/, "");
  if (dir === undefined || (dir.startsWith("$") && !/^\$\{?HOME\b/.test(dir))) return undefined;
  return dir === "" ? "." : dir;
}

function joinBase(base: Base, dir: string | undefined): Base {
  if (dir === undefined) return { dir: undefined, isFallback: base.isFallback };
  if (ANCHORED.test(dir) || base.dir === "") return { dir, isFallback: base.isFallback };
  if (base.dir === undefined) return base;
  return { dir: `${base.dir.replace(/[\\/]+$/, "")}/${dir}`, isFallback: base.isFallback };
}

function dedupe(bases: readonly Base[]): Base[] {
  const seen = new Map<string, Base>();
  for (const base of bases) {
    const key = base.dir ?? "\0";
    const known = seen.get(key);
    if (known === undefined || (known.isFallback && !base.isFallback)) seen.set(key, base);
  }
  const kept = [...seen.values()];
  return kept.length > MAX_BASES ? [{ dir: undefined, isFallback: true }] : kept;
}

type Kind = "subshell" | "brace" | "if" | "loop" | "case";
type Pending = { name: string } | { before: Base[] };
type Frame = {
  kind: Kind;
  start: number;
  undo: [string, boolean, string | undefined][];
  writes: { at: number; name: string }[];
  cds: number[];
  entry: Base[];
  pending: Pending[];
  statement: number;
  prev: "start" | "&&" | "||" | "|";
};
type Snapshot = { at: number; vars: Map<string, string | undefined>; maybe: Set<string>; bases: Base[] };

const OPENERS: Readonly<Record<string, Kind>> = { if: "if", while: "loop", until: "loop", for: "loop", select: "loop", case: "case" };
const CLOSERS: Readonly<Record<string, Kind>> = { fi: "if", done: "loop", esac: "case", "}": "brace" };
const READERS = new Set(["read", "mapfile", "readarray", "getopts", "unset", "let"]);
const DECLARERS = new Set(["export", "readonly", "local", "declare", "typeset"]);

/**
 * Reads a bash command once, left to right, and returns the shell state at each of `queries`
 * (offsets of `scan`, sorted), starting in the directories `initial` names. A heredoc body
 * (`bodies`) is text, so a line in it is no statement unless a substitution in it runs one. An assignment counts only as a statement of its own, and only
 * where it surely ran: one inside a subshell, a pipeline or a backgrounded command does not
 * leak, one after `||` or in a block that has ended is unknown, and one after `&&` holds only
 * while the same `&&` chain lasts. A `cd` holds while its `&&` chain lasts; after that the
 * command may run in the directory the `cd` left too. Inside a loop, a value the loop sets after
 * a query is unknown at that query, since a later pass reaches it with that value.
 */
export function walkBash(
  command: string,
  scan: string,
  queries: readonly number[],
  home: string | undefined,
  initial: readonly Base[] = SESSION_STATE.bases,
  bodies: readonly { start: number; end: number }[] = [],
): Map<number, ShellState> {
  const env = new Map<string, string | undefined>();
  const maybe = new Set<string>();
  const functions = new Set<string>();
  let bases: Base[] = [...initial];
  const frames: Frame[] = [];
  const snapshots: Snapshot[] = [];
  let top: Frame = { kind: "subshell", start: 0, undo: [], writes: [], cds: [], entry: bases, pending: [], statement: -1, prev: "start" };
  frames.push(top);
  const open = (kind: Kind, start: number) => {
    top = { kind, start, undo: [], writes: [], cds: [], entry: bases, pending: [], statement: -1, prev: "start" };
    frames.push(top);
  };
  const state = (): ShellState => ({ vars: env, maybe, bases });

  const assign = (name: string, value: string | undefined, at: number, isMaybe = false) => {
    const subshell = frames.findLast((frame) => frame.kind === "subshell");
    subshell?.undo.push([name, env.has(name), env.get(name)]);
    env.set(name, value);
    if (isMaybe) maybe.add(name);
    else maybe.delete(name);
    if (top.kind !== "subshell") top.writes.push({ at, name });
  };
  const forget = (at: number) => {
    for (const known of env.keys()) assign(known, undefined, at, true);
    bases = dedupe([...bases, { dir: undefined, isFallback: true }]);
  };
  const changeDir = (next: Base[], at: number) => {
    bases = dedupe(next);
    if (top.kind !== "subshell") top.cds.push(at);
  };
  const settle = (frame: Frame) => {
    for (const pending of frame.pending) {
      if ("name" in pending) assign(pending.name, undefined, frame.statement, true);
      else bases = dedupe([...bases, ...pending.before.map((base) => ({ ...base, isFallback: true }))]);
    }
    frame.pending = [];
  };

  // A backgrounded command runs in a subshell. A pipeline's last command may run in the shell
  // itself (zsh, or bash with lastpipe), so what a pipeline sets is unknown, not unchanged.
  const effect = (start: number, end: number, next: Frame["prev"] | "&" | "end") => {
    if (next === "&") return;
    const isPiped = top.prev === "|" || next === "|";
    const condition = top.prev;
    const words: (RawWord & { end: number })[] = [];
    for (let word = wordAt(command, start, end); word !== undefined; word = wordAt(command, word.end, end)) {
      words.push(word);
      if (!ASSIGNMENT.test(word.raw)) break;
    }
    const set = (name: string, value: string | undefined) => {
      const isMaybe = isPiped || condition === "||";
      assign(name, isMaybe ? undefined : value, start, isMaybe);
      if (condition === "&&") top.pending.push({ name });
    };
    const isPrefixed = words.length > 1 && !ASSIGNMENT.test(words.at(-1)?.raw ?? "");
    if (!isPrefixed && words.every((word) => ASSIGNMENT.test(word.raw))) {
      for (const word of words) {
        const [, name = "", append] = ASSIGNMENT.exec(word.raw) ?? [];
        set(name, append === "+" ? undefined : expandWord(word.raw.slice(word.raw.indexOf("=") + 1), state()));
      }
      return;
    }
    let first = words.at(-1);
    if (first !== undefined && /^(?:builtin|command)$/.test(first.raw)) first = wordAt(command, first.end, end);
    const name = first?.raw ?? "";
    if (functions.has(name)) {
      forget(start);
      return;
    }
    if (first === undefined || !(name === "cd" || name === "pushd" || name === "popd" || DECLARERS.has(name) || READERS.has(name) || name === "printf" || name === "source" || name === "." || name === "eval")) {
      return;
    }
    const args = rawWords(command, first.start, end);
    if (name === "cd" || name === "pushd" || name === "popd") {
      const dir = name === "popd" ? undefined : cdTarget(args, state(), home);
      const moved = bases.map((base) => joinBase(base, dir));
      if (isPiped) changeDir([...bases, { dir: undefined, isFallback: true }], start);
      else if (condition === "||") changeDir([...moved, ...bases.map((base) => ({ ...base, isFallback: true }))], start);
      else {
        top.pending.push({ before: bases });
        changeDir(moved, start);
      }
    } else if (DECLARERS.has(name)) {
      for (const arg of args.slice(1)) {
        const assignment = ASSIGNMENT.exec(arg.raw);
        if (assignment !== null) set(assignment[1] ?? "", expandWord(arg.raw.slice(arg.raw.indexOf("=") + 1), state()));
        else if (NAME.test(arg.raw) && name !== "export" && name !== "readonly") set(arg.raw, undefined);
      }
    } else if (READERS.has(name) || name === "printf") {
      for (const arg of args.slice(1)) {
        const target = INDEXED.exec(arg.raw)?.[1] ?? ASSIGNMENT.exec(arg.raw)?.[1] ?? NAME.exec(arg.raw)?.[0];
        if (target !== undefined && target === arg.raw.replace(/[[=+].*$/s, "")) set(target, undefined);
      }
    } else if (name === "source" || name === "." || name === "eval") {
      forget(start);
    }
  };

  // The bodies are in command order and do not overlap, so the one holding `at` is found by halving.
  const isText = (at: number): boolean => {
    let low = 0;
    let high = bodies.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const body = bodies[middle];
      if (body === undefined) return false;
      if (at < body.start) high = middle - 1;
      else if (at >= body.end) low = middle + 1;
      else return !frames.some((frame) => frame.kind === "subshell" && body.start <= frame.start && frame.start < body.end);
    }
    return false;
  };
  const endStatement = (end: number, next: Frame["prev"] | "&" | "end") => {
    if (top.statement !== -1 && !isText(top.statement)) effect(top.statement, end, next);
    top.statement = -1;
    top.prev = next === "&" || next === "end" ? "start" : next;
  };
  const listEnd = () => {
    settle(top);
    top.prev = "start";
  };
  const close = (frame: Frame, at: number) => {
    while (frames.length > 1) {
      const closing = frames.pop() as Frame;
      top = frames.at(-1) as Frame;
      if (closing.kind === "subshell") {
        for (const [name, had, value] of closing.undo.reverse()) {
          if (had) env.set(name, value);
          else env.delete(name);
        }
        bases = closing.entry;
      } else {
        settle(closing);
        if (closing.kind === "loop") {
          for (const snapshot of snapshots) {
            if (snapshot.at <= closing.start) continue;
            for (const write of closing.writes) {
              if (write.at <= snapshot.at) continue;
              snapshot.vars.set(write.name, undefined);
              snapshot.maybe.add(write.name);
            }
            if (closing.cds.some((cd) => cd > snapshot.at)) snapshot.bases.push({ dir: undefined, isFallback: true });
          }
        }
        for (const name of new Set(closing.writes.map((write) => write.name))) assign(name, undefined, at, true);
        if (closing.cds.length > 0) changeDir([...bases, ...closing.entry.map((base) => ({ ...base, isFallback: true }))], at);
      }
      if (closing === frame) return;
    }
  };
  const branch = () => {
    settle(top);
    for (const write of top.writes) {
      env.set(write.name, undefined);
      maybe.add(write.name);
    }
    if (top.cds.length > 0) bases = dedupe([...bases, ...top.entry.map((base) => ({ ...base, isFallback: true }))]);
    top.prev = "start";
  };

  let query = 0;
  for (let i = 0; i < scan.length; i++) {
    while (query < queries.length && (queries[query] ?? 0) <= i) {
      snapshots.push({ at: queries[query] ?? 0, vars: new Map(env), maybe: new Set(maybe), bases: [...bases] });
      query++;
    }
    const ch = scan.charAt(i);
    const next = scan.charAt(i + 1);
    if (ch === "`") {
      if (top.kind === "subshell" && frames.length > 1 && scan.charAt(top.start) === "`") {
        endStatement(i, "end");
        close(top, i);
      } else {
        if (top.statement === -1) top.statement = i;
        open("subshell", i);
      }
      continue;
    }
    if (ch === "#" && (i === 0 || /[ \t\n;&|(]/.test(scan.charAt(i - 1)))) {
      const eol = scan.indexOf("\n", i);
      i = (eol === -1 ? scan.length : eol) - 1;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "\r") {
      const isCaseBreak = ch === ";" && (next === ";" || next === "&");
      endStatement(i, "end");
      if (isCaseBreak) {
        branch();
        i += scan.charAt(i + 2) === "&" ? 2 : 1;
      } else listEnd();
      continue;
    }
    if (ch === "&" && next === "&") {
      endStatement(i, "&&");
      i++;
      continue;
    }
    if (ch === "|" && next === "|") {
      endStatement(i, "||");
      settle(top);
      i++;
      continue;
    }
    if (ch === "|") {
      endStatement(i, "|");
      if (next === "&") i++;
      continue;
    }
    if (ch === "&" && !/[<>]/.test(scan.charAt(i - 1)) && next !== ">") {
      endStatement(i, "&");
      listEnd();
      continue;
    }
    if (ch === "(") {
      open("subshell", i);
      continue;
    }
    if (ch === ")") {
      if (top.kind === "case") {
        endStatement(i, "end");
        top.prev = "start";
        continue;
      }
      const subshell = frames.findLast((frame, index) => index > 0 && frame.kind === "subshell" && scan.charAt(frame.start) !== "`");
      if (subshell !== undefined) {
        endStatement(i, "end");
        close(subshell, i);
      }
      continue;
    }
    const header = ch === "{" && top.statement !== -1 ? FUNCTION_HEADER.exec(command.slice(top.statement, i)) : null;
    if (header !== null) {
      functions.add(header[1] ?? header[2] ?? "");
      top.statement = -1;
      top.prev = "start";
      open("brace", i);
      continue;
    }
    if (/[ \t\v\f]/.test(ch) || top.statement !== -1) continue;
    const word = /^[^ \t\n\v\f\r;&|()<>`]+/.exec(scan.slice(i, i + 8))?.[0] ?? "";
    const isWordEnd = /^(?:$|[ \t\n\v\f\r;&|()<>`])/.test(scan.charAt(i + word.length));
    if (isWordEnd && word === "{") {
      open("brace", i);
    } else if (isWordEnd && CLOSERS[word] !== undefined) {
      const kind = CLOSERS[word];
      const frame = frames.findLast((one) => one.kind === kind);
      if (frame !== undefined && frames.indexOf(frame) > 0) close(frame, i);
    } else if (isWordEnd && OPENERS[word] !== undefined) {
      open(OPENERS[word] as Kind, i);
      if (word === "for" || word === "select") {
        const loopVar = /^[ \t]+([A-Za-z_][A-Za-z0-9_]*)/.exec(command.slice(i + word.length, i + word.length + 300))?.[1];
        if (loopVar !== undefined) assign(loopVar, undefined, i, true);
      }
    } else if (isWordEnd && (word === "else" || word === "elif")) {
      branch();
    } else if (isWordEnd && (word === "then" || word === "do")) {
      listEnd();
    } else if (!(isWordEnd && word === "!")) {
      top.statement = i;
      continue;
    }
    i += word.length - 1;
  }
  while (query < queries.length) {
    snapshots.push({ at: queries[query] ?? 0, vars: new Map(env), maybe: new Set(maybe), bases: [...bases] });
    query++;
  }
  return new Map(snapshots.map((snapshot) => [snapshot.at, { vars: snapshot.vars, maybe: snapshot.maybe, bases: snapshot.bases }]));
}
