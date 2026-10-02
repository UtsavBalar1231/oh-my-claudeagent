export type Candidate = { readonly file: string; readonly line: number; readonly text: string };

const CLAIM = /\b(done|complete|completed|finished|implemented|fixed|resolved|ready (to|for) (merge|review))\b/g;
// `n'?t` also catches any word ending in "nt"; erring toward a negation lets a stop through.
const NEGATION = /(\b(not|no|nothing|none|never|un[a-z]+ished|incomplete|yet to|remains)\b|n'?t\b)/;
const SENTENCE_BREAK = /[.!?;:\n]/;

const FOCUSED_TEST = /\b(describe|context|it|test|bench|suite|specify|concurrent|serial|sequential)\.only\b/;
const UNFINISHED = "TODO: implement";
const NOT_IMPLEMENTED_THROW = /throw new [A-Za-z]*Error\(["'].*not implemented/;
const RUNNABLE_TEST_FILE = /\.(js|jsx|ts|tsx|mjs|cjs)$/;
// A document cannot hold an executable stub, so a marker in one is always a mention.
const PROSE_FILE = /\.(md|markdown|rst|txt|adoc)$/;
const BATS_TEST_DECLARATION = /^\s*@test\s/;

/** Blanks every `delim` span that closes on the same line; an unpaired delimiter stays literal. */
export const stripPairedSpans = (text: string, delim: string): string =>
  text.replace(new RegExp(`${delim}[^${delim}\\n]*${delim}`, "g"), delim + delim);

const stripQuotes = (text: string, delims: readonly string[]): string => delims.reduce(stripPairedSpans, text);

/** A completion claim outside quotes whose own sentence carries no negation. */
export function hasCompletionClaim(message: string): boolean {
  const text = stripQuotes(message.toLowerCase(), ["`", '"']);
  for (const { index } of text.matchAll(CLAIM)) {
    const sentence = text.slice(0, index).split(SENTENCE_BREAK).at(-1) ?? "";
    if (!NEGATION.test(sentence)) return true;
  }
  return false;
}

export const hasStubMarker = (text: string): boolean =>
  FOCUSED_TEST.test(text) || text.includes(UNFINISHED) || NOT_IMPLEMENTED_THROW.test(text);

/** The added lines of a `git diff --unified=0`, numbered as in the new file. */
export function addedLines(diff: string): Candidate[] {
  const added: Candidate[] = [];
  let file = "";
  let line = 0;
  let isFileHeaderNext = false;
  for (const row of diff.split("\n")) {
    if (row.startsWith("--- ")) {
      isFileHeaderNext = true;
      continue;
    }
    if (isFileHeaderNext) {
      isFileHeaderNext = false;
      if (row.startsWith("+++ ")) {
        const path = row.slice(4).replace(/\t$/, "").replace(/^b\//, "");
        file = path === "/dev/null" ? "" : path;
        continue;
      }
    }
    if (row.startsWith("@@")) {
      line = Number((row.split(" ")[2] ?? "").replace(/^\+/, "").split(",")[0]);
    } else if (row.startsWith("+")) {
      if (file !== "") added.push({ file, line, text: row.slice(1) });
      line++;
    }
  }
  return added;
}

/**
 * A stub left on an added line. A bats test name and a quoted string mention a marker rather
 * than leave one; the unimplemented-error throw opens a quote by construction, so it is
 * matched on the raw line.
 */
export function isStubFinding({ file, text }: Candidate): boolean {
  if (PROSE_FILE.test(file) || BATS_TEST_DECLARATION.test(text)) return false;
  if (NOT_IMPLEMENTED_THROW.test(text)) return true;
  const unquoted = stripQuotes(text, ["'", '"']);
  return unquoted.includes(UNFINISHED) || (RUNNABLE_TEST_FILE.test(file) && FOCUSED_TEST.test(unquoted));
}
