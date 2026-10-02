import { baseName, SHAPE_PLATFORM, toPosix } from "./path.ts";
import { inputText } from "./tool-input.ts";

export type CommentGateMode = "off" | "advise" | "deny";

/** Holds, per file path, the finding a tier-2 deny last blocked, so the same finding on the same file passes on the retry. */
export type DenyOnce = Map<string, string>;

export type Verdict =
  | { kind: "deny"; reason: string }
  | { kind: "advise"; text: string; wouldDeny: "tier1" | "tier2" | undefined };

type Syntax = { readonly comment: RegExp; readonly marker: RegExp };
type Slop = { readonly sentence: string; readonly quoted: string };

const DISABLE_FILE_MARKER = "comment-gate-disable-file";
const DISABLE_FILE_WINDOW = 5;
const MAX_COMMENT_RUN = 5;
const MAX_SLOP_FINDINGS = 5;

// A comment marker is chosen by language. Applying one the language lacks is a false positive
// (`#` opens a preprocessor directive in C, and Lua has neither `#` nor `//`), so a language
// whose only comment form is a block delimiter, or whose line marker differs by dialect, is left
// out. `.m` is the exception: `//` and `%` cannot open a line in the other dialect.
const MARKERS_BY_EXTENSION = new Map(
  (
    [
      [["#"], "sh bash zsh fish ps1 psm1 py pyi rb pl pm r R jl ex exs cr nim tcl mk"],
      [["//"], "c h cpp cc cxx hpp hh hxx mm java cs swift kt kts scala dart js jsx mjs cjs ts tsx mts cts"],
      [["//"], "go rs zig d groovy gradle fs fsx sol proto scss less"],
      [["--"], "lua sql hs elm adb ads vhd vhdl"],
      [["%"], "erl hrl tex"],
      [[";"], "clj cljs cljc lisp el scm rkt"],
      [["!"], "f90 f95 f03 f08"],
      [["'"], "vb"],
      [["//", "%"], "m"],
      [["#", "//"], "php tf tfvars"],
    ] as const
  ).flatMap(([markers, extensions]) => extensions.split(" ").map((extension): [string, readonly string[]] => [extension, markers])),
);
const MARKERS_BY_NAME = new Map(["Makefile", "Dockerfile", "justfile", "Justfile"].map((name): [string, readonly string[]] => [name, ["#"]]));

function markersOf(filePath: string): readonly string[] | undefined {
  const name = baseName(SHAPE_PLATFORM, filePath);
  const dot = name.lastIndexOf(".");
  return (dot < 0 ? undefined : MARKERS_BY_EXTENSION.get(name.slice(dot + 1))) ?? MARKERS_BY_NAME.get(name);
}

// No marker holds a regex metacharacter, so the markers join into an alternation as they are.
function syntaxOf(markers: readonly string[]): Syntax {
  const opener = `^\\s*(?:${markers.join("|")})`;
  return { comment: new RegExp(opener), marker: new RegExp(`${opener}\\s*`) };
}

export const commentGateMode = (value: string | undefined): CommentGateMode => (value === "off" || value === "deny" ? value : "advise");

/** The lines a write adds: a Write's `content` or an Edit's `new_string`. */
function addedLines(input: unknown): string[] {
  return (inputText(input, "content") || inputText(input, "new_string")).split("\n");
}

const hasReference = (text: string): boolean => /#\d+|[A-Z]+-\d+|@[A-Za-z]/.test(text);

// A bare `TODO: implement` is a placeholder; one that goes on to say what and why is a plan.
const MIN_PLACEHOLDER_CONTEXT_WORDS = 3;
function isPlaceholderTodo(line: string): boolean {
  const rest = /todo:\s*implement\w*\b(.*)$/.exec(line.toLowerCase())?.[1];
  return rest !== undefined && !hasReference(line) && rest.trim().split(/\s+/).filter(Boolean).length < MIN_PLACEHOLDER_CONTEXT_WORDS;
}

// A literal attribution or placeholder on a comment line is near-certain slop, which is why
// these are the only findings that always deny. The phrases must open the comment body, so a
// comment that merely names one passes.
function attributionFindings(lines: readonly string[], { comment, marker }: Syntax): string[] {
  let attribution = false;
  let authorship = false;
  let placeholder = false;
  for (const line of lines) {
    if (!comment.test(line)) continue;
    const lowered = line.toLowerCase();
    const body = lowered.replace(marker, "");
    attribution ||= body.startsWith("ai-generated");
    authorship ||= body.startsWith("this code was written by");
    placeholder ||= isPlaceholderTodo(line);
  }
  const findings: string[] = [];
  if (attribution) findings.push("AI attribution comment detected.");
  if (authorship) findings.push("AI authorship comment detected.");
  if (placeholder) findings.push("Unimplemented TODO placeholder detected.");
  return findings;
}

// Whole-hunk aggregates name no line to quote, and a mandated header can reach these ratios, so
// they only advise. Density is 40% of non-blank lines with a floor of six comments, which keeps
// a file header or a magic-number derivation in a normal hunk clear; a hunk with no code lines
// is a header or comment-block edit, where the ratio says nothing.
function aggregateFindings(lines: readonly string[], { comment }: Syntax): string[] {
  let run = 0;
  let longest = 0;
  let comments = 0;
  let code = 0;
  for (const line of lines) {
    if (comment.test(line)) {
      run++;
      comments++;
      longest = Math.max(longest, run);
      continue;
    }
    run = 0;
    if (line.trim() !== "") code++;
  }
  const findings: string[] = [];
  if (longest > MAX_COMMENT_RUN) findings.push(`Excessive consecutive comment lines (${longest} in a row) detected.`);
  if (code > 0 && comments >= 6 && comments * 10 >= (comments + code) * 4) {
    findings.push(`High comment density (${comments} comment lines to ${code} code lines): likely line-by-line narration rather than documentation.`);
  }
  return findings;
}

// "return", "value" and "values" stay out: dropping them tokenized "return the values" to nothing,
// so the restating check could never fire on the commonest narration.
const STOPWORDS = new Set("this that these those with from into your were will should would could function method".split(" "));
const tokensOf = (text: string): Set<string> =>
  new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4 && !STOPWORDS.has(word)));

// A comment echoes another text when it shares a meaningful word with it and adds at most one of
// its own: narration nearly always carries a word the code lacks ("set the path attribute").
function echoes(comment: ReadonlySet<string>, other: ReadonlySet<string>): boolean {
  const shared = [...comment].filter((word) => other.has(word)).length;
  return shared >= 1 && comment.size - shared <= 1;
}

const indentOf = (line: string): number => /^\s*/.exec(line)?.[0].length ?? 0;

function nextNonBlank(lines: readonly string[], from: number): number {
  let index = from;
  while (index < lines.length && (lines[index] ?? "").trim() === "") index++;
  return index;
}

function isOneLiner(lines: readonly string[], definition: number, indent: number): boolean {
  const header = lines[definition] ?? "";
  const body = nextNonBlank(lines, definition + 1);
  const bodyLine = lines[body];
  if (bodyLine === undefined) return false;
  if (/:\s*$/.test(header)) {
    if (indentOf(bodyLine) <= indent) return false;
    const after = lines[nextNonBlank(lines, body + 1)];
    return after === undefined || indentOf(after) <= indent;
  }
  if (!/\{\s*$/.test(header) || /^\s*\}/.test(bodyLine)) return false;
  return /^\s*\}\s*$/.test(lines[nextNonBlank(lines, body + 1)] ?? "");
}

const DEFINITION = /^(\s*)(?:def|function|fn|func)\s+([A-Za-z_]\w*)\s*\(/;
// A magic number's derivation comment restates its constant by construction, and the codebase
// requires it, so the shape is exempt rather than the rule blocked.
const NUMERIC_CONSTANT = /^\s*(?:\w+\s+)*[A-Za-z_]\w*(?:\s*:\s*[\w<>[\]]+)?\s*=\s*-?[0-9]/;
// A tool directive addresses the tool, not a reader, so its overlap with the line below is the
// directive naming its own target. Anchored at the comment body so a comment that merely
// mentions a linter is still judged as prose.
const PRAGMA = /^(?:shellcheck\s|noqa(?:[\s:]|$)|type:|pylint:|ruff:|mypy:)/;

function slopFindings(lines: readonly string[], syntax: Syntax): Slop[] {
  const found: Slop[] = [];
  const add = (sentence: string, quoted: string) => found.push({ sentence, quoted });
  for (const [index, line] of lines.entries()) {
    if (!syntax.comment.test(line) || line.includes("@allow")) continue;
    if (found.length >= MAX_SLOP_FINDINGS) break;
    const text = line.replace(syntax.marker, "");
    const lowered = text.toLowerCase();

    if (/^[=\-*_~^]{3,}$/.test(text.replace(/\s/g, ""))) {
      add(`Decorative separator comment ("${text}"): delete it.`, text);
      continue;
    }

    if (/(?:^|[^a-z])(?:obviously|clearly|simply|just|basically)(?:[^a-z]|$)/.test(lowered)) {
      add(`Filler-word comment ("${text}"): delete it.`, text);
    }

    if (/todo|fixme/.test(lowered) && found.length < MAX_SLOP_FINDINGS && !hasReference(text)) {
      const rest = text.replace(/^.*todo/i, "").replace(/^.*fixme/i, "").replace(/^[:,-]+\s*/, "").replace(/^\s+/, "");
      if (rest.split(/\s+/).length < 3) add(`Context-free TODO/FIXME ("${text}"): add an issue ref or TODO(owner):.`, text);
    }

    const next = lines[nextNonBlank(lines, index + 1)];
    if (found.length < MAX_SLOP_FINDINGS && next !== undefined && !syntax.comment.test(next)) {
      const exempt = (/[0-9]/.test(text) && NUMERIC_CONSTANT.test(next)) || PRAGMA.test(text);
      if (!exempt && echoes(tokensOf(lowered), tokensOf(next))) {
        add(`Comment restates the following code line ("${text}"): delete it, or replace it with the non-obvious why.`, text);
      }
    }

    const definition = DEFINITION.exec(lines[index + 1] ?? "");
    if (found.length < MAX_SLOP_FINDINGS && definition !== null && isOneLiner(lines, index + 1, (definition[1] ?? "").length)) {
      const nameWords = new Set(
        (definition[2] ?? "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== ""),
      );
      if (echoes(tokensOf(lowered), nameWords)) add(`Doc comment adds nothing beyond the function name ("${text}"): delete it.`, text);
    }
  }
  return found;
}

// Without the list of what to keep, a deny invites stripping every comment.
const KEEP_NOTICE = `The convention: names, types, and structure carry the what, so a comment earns its place only by carrying something the code cannot state, the non-obvious why, an invariant, a constraint, or the derivation of a magic number. A correct fix deletes the quoted comment, or rewrites it as the reason the code is the way it is. A clearer name beats a comment that restates the line below it. Do NOT remove other comments while fixing this: file headers, non-obvious function contracts, invariant notes, and magic-number derivation comments are REQUIRED and must survive. Resubmit the same code change with only the quoted comments fixed. Genuine exceptions: put ${DISABLE_FILE_MARKER} in the first ${DISABLE_FILE_WINDOW} lines of the hunk.`;

/**
 * Judges the comments a Write or Edit adds. Tier-1 findings (attribution, placeholder) deny in
 * `deny` mode. Tier-2 findings (restating, filler, separators, context-free TODOs, trivial doc
 * comments) deny once per file and finding, then pass, so a lexical false positive cannot trap an
 * edit in a retry loop; with no `slot` to remember the denial they advise instead. Tier-3
 * aggregates and every finding in `advise` mode only advise.
 */
export function judgeWrite(mode: "advise" | "deny", input: unknown, slot: DenyOnce | undefined): Verdict | undefined {
  const filePath = inputText(input, "file_path");
  const markers = markersOf(filePath);
  if (markers === undefined || toPosix(SHAPE_PLATFORM, filePath).includes("/tests/")) return undefined;
  const lines = addedLines(input);
  if (lines.slice(0, DISABLE_FILE_WINDOW).some((line) => line.includes(DISABLE_FILE_MARKER))) return undefined;
  const syntax = syntaxOf(markers);
  const attribution = attributionFindings(lines, syntax);
  const slop = slopFindings(lines, syntax);
  const aggregate = aggregateFindings(lines, syntax);
  if (attribution.length + slop.length + aggregate.length === 0) return undefined;

  const sentences = slop.map(({ sentence }) => sentence);
  const text = ["[COMMENT CHECK] Detected AI slop comment patterns. Remove the quoted comments with a follow-up Edit unless they encode a non-obvious why.", ...attribution, ...sentences, ...aggregate].join(" ");
  const advise = (wouldDeny: "tier1" | "tier2" | undefined): Verdict => ({ kind: "advise", text, wouldDeny });
  if (mode !== "deny") return advise(attribution.length > 0 ? "tier1" : slop.length > 0 ? "tier2" : undefined);
  if (attribution.length > 0) return { kind: "deny", reason: `Blocked: AI-attribution or placeholder comment. ${attribution.join(" ")} ${KEEP_NOTICE}` };
  if (slop.length === 0 || slot === undefined) return advise(undefined);

  const signature = slop.map(({ quoted }) => quoted).join("\n");
  if (slot.get(filePath) === signature) {
    slot.delete(filePath);
    return advise(undefined);
  }
  slot.set(filePath, signature);
  return { kind: "deny", reason: `Blocked: comment slop. ${sentences.join(" ")} ${KEEP_NOTICE}` };
}
