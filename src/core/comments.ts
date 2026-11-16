import { baseName, SHAPE_PLATFORM, toPosix } from "./path.ts";
import { hasReference, isPlaceholderTodo } from "./todo.ts";
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

function slopFindings(lines: readonly string[], syntax: Syntax): Slop[] {
  const found: Slop[] = [];
  const add = (sentence: string, quoted: string) => found.push({ sentence, quoted });
  for (const line of lines) {
    if (!syntax.comment.test(line) || line.includes("@allow")) continue;
    if (found.length >= MAX_SLOP_FINDINGS) break;
    const text = line.replace(syntax.marker, "");

    if (/^[=\-*_~^]{3,}$/.test(text.replace(/\s/g, ""))) {
      add(`Decorative separator comment ("${text}"): delete it.`, text);
      continue;
    }

    if (/\b(?:todo|fixme)\b/i.test(text) && !hasReference(text)) {
      const rest = text.replace(/^.*todo/i, "").replace(/^.*fixme/i, "").replace(/^[:,-]+\s*/, "").replace(/^\s+/, "");
      if (rest.split(/\s+/).length < 3) add(`Context-free TODO/FIXME ("${text}"): add an issue ref or TODO(owner):.`, text);
    }
  }
  return found;
}

// Without the list of what to keep, a deny invites stripping every comment.
export const KEEP_NOTICE = `The convention: names, types, and structure carry the what, so a comment earns its place only by carrying something the code cannot state, the non-obvious why, an invariant, a constraint, or the derivation of a magic number. A correct fix deletes the quoted comment, or rewrites it as the reason the code is the way it is. Do NOT remove other comments while fixing this: file headers, non-obvious function contracts, invariant notes, and magic-number derivation comments may be required by the project's own convention. Resubmit the same code change with only the quoted comments fixed. Genuine exceptions: put @allow on a comment line to exempt that line from the slop checks, or put ${DISABLE_FILE_MARKER} in the first ${DISABLE_FILE_WINDOW} lines of the hunk.`;

export const COMMENT_ATTRIBUTION_HEAD = "Blocked: AI-attribution or placeholder comment.";
export const COMMENT_SLOP_HEAD = "Blocked: comment slop.";

/**
 * Judges the comments a Write or Edit adds. Tier-1 findings (attribution, placeholder) deny in
 * `deny` mode. Tier-2 findings (separators, context-free TODOs) deny once per file and
 * finding, then pass, so a lexical false positive cannot trap an edit in a retry loop; with no
 * `slot` to remember the denial they advise instead. Every finding in `advise` mode only advises.
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
  if (attribution.length + slop.length === 0) return undefined;

  const sentences = slop.map(({ sentence }) => sentence);
  const text = ["[COMMENT CHECK] Detected AI slop comment patterns. Remove the quoted comments with a follow-up Edit unless they encode a non-obvious why.", ...attribution, ...sentences].join(" ");
  const advise = (wouldDeny: "tier1" | "tier2" | undefined): Verdict => ({ kind: "advise", text, wouldDeny });
  if (mode !== "deny") return advise(attribution.length > 0 ? "tier1" : "tier2");
  if (attribution.length > 0) return { kind: "deny", reason: `${COMMENT_ATTRIBUTION_HEAD} ${attribution.join(" ")} ${KEEP_NOTICE}` };
  if (slot === undefined) return advise(undefined);

  const signature = slop.map(({ quoted }) => quoted).join("\n");
  if (slot.get(filePath) === signature) {
    slot.delete(filePath);
    return advise(undefined);
  }
  slot.set(filePath, signature);
  return { kind: "deny", reason: `${COMMENT_SLOP_HEAD} ${sentences.join(" ")} ${KEEP_NOTICE}` };
}
