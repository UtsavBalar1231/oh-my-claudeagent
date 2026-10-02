export const RULE_BODY_CAP = 1000;
export const DOC_EXCERPT_CAP = 2000;
// Under the platform's 10,000-character cap on one hook output string, past which the client
// swaps the text for a file path and a preview Claude is not asked to read.
export const CONTEXT_BUDGET = 8000;
// Held back from the budget so the deferred-items marker always fits.
const MARKER_RESERVE = 400;

const PATTERN_PREFIX = "# pattern: ";

export type Rule = { readonly pattern: string; readonly body: string; readonly isTruncated: boolean };

export type Part = { readonly path: string; readonly text: string };

const withoutTrailingNewlines = (text: string): string => text.replace(/\n+$/, "");

/** A rule's first line is `# pattern: <glob>`. A rule whose body is blank injects nothing. */
export function parseRule(text: string): Rule | undefined {
  const newline = text.indexOf("\n");
  const first = newline === -1 ? text : text.slice(0, newline);
  const tail = newline === -1 ? "" : withoutTrailingNewlines(text.slice(newline + 1));
  if (!first.startsWith(PATTERN_PREFIX) || first === PATTERN_PREFIX || tail.trim() === "") return undefined;
  return { pattern: first.slice(PATTERN_PREFIX.length), body: tail.slice(0, RULE_BODY_CAP), isTruncated: tail.length > RULE_BODY_CAP };
}

export function rulePart(rule: Rule, path: string): Part {
  const note = rule.isTruncated ? ` (truncated, read full rule at ${path})` : "";
  return { path, text: `[Rule: ${rule.pattern}]: ${rule.body}${note}` };
}

/** Whole lines of an AGENTS.md or README.md, up to DOC_EXCERPT_CAP characters counting each newline. */
export function docPart(doc: { readonly name: string; readonly dir: string; readonly path: string }, text: string): Part {
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  let used = 0;
  let kept = 0;
  for (const line of lines) {
    used += line.length + 1;
    if (used > DOC_EXCERPT_CAP) break;
    kept++;
  }
  const note = kept < lines.length ? ` (truncated, read full file at ${doc.path})` : "";
  return { path: doc.path, text: `[${doc.name} from ${doc.dir}]: ${withoutTrailingNewlines(lines.slice(0, kept).join("\n"))}${note}` };
}

/**
 * Packs parts in order while they fit the budget. A part that does not fit is deferred and
 * named in a closing marker; the caller records only the parts in `kept` as injected, so a
 * deferred part injects on a later event.
 */
export function pack(parts: readonly Part[]): { context: string; kept: ReadonlySet<Part> } {
  let context = "";
  const kept = new Set<Part>();
  const deferred: string[] = [];
  for (const part of parts) {
    if (context.length + part.text.length + 1 > CONTEXT_BUDGET - MARKER_RESERVE) {
      deferred.push(part.path);
      continue;
    }
    context += `${part.text}\n`;
    kept.add(part);
  }
  if (deferred.length > 0) {
    let marker = `[context budget reached, ${deferred.length} item(s) deferred to a later event:`;
    for (const path of deferred) {
      if (context.length + marker.length + path.length + 3 > CONTEXT_BUDGET) break;
      marker += ` ${path}`;
    }
    context += `${marker}]\n`;
  }
  return { context: context.slice(0, -1), kept };
}
