import { oneLine } from "./ui-kit.ts";
import { mergePieces, type Piece, type ThemeKey, TONE_KEYS } from "./visual.ts";

/** The theme key Claude Code's own markdown draws inline code in, measured from its rendering. */
export const CODE_KEY: ThemeKey = "permission";

type Style = Omit<Piece, "text">;

const FENCE = /^\s*(?:`{3,}|~{3,})/;
const RULE = /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const isTableRule = (line: string): boolean => /^[\s|:-]+$/.test(line) && line.includes("-") && line.includes("|");

/** The lines of `text` that carry words, each made one line: no blank, fence, rule or table-rule line. */
export const contentLines = (text: string): string[] =>
  text
    .split("\n")
    .filter((line) => !FENCE.test(line) && !RULE.test(line) && !isTableRule(line))
    .map(oneLine)
    .filter((line) => line !== "");

const ESCAPABLE = /[!-/:-@[-`{-~]/;
const isWord = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}]/u.test(char);
const isBlank = (char: string | undefined): boolean => char === undefined || /\s/.test(char);

const runAt = (text: string, at: number): number => {
  let end = at;
  while (text[end] === "`") end += 1;
  return end - at;
};

function closingRun(text: string, size: number, from: number): number {
  for (let at = text.indexOf("`", from); at !== -1; at = text.indexOf("`", at + runAt(text, at))) {
    if (runAt(text, at) === size) return at;
  }
  return -1;
}

// An opener is followed by a non-blank character; an underscore one also starts a word, so
// snake_case stays as written.
const opens = (text: string, at: number, delimiter: string): boolean =>
  !isBlank(text[at + delimiter.length]) && !(delimiter.startsWith("_") && isWord(text[at - 1]));

// A closer follows a non-blank character past at least one character of content; a single
// delimiter is not half of a double, and an underscore one ends a word.
function closer(text: string, delimiter: string, from: number): number {
  for (let at = text.indexOf(delimiter, from + 1); at !== -1; at = text.indexOf(delimiter, at + 1)) {
    if (isBlank(text[at - 1])) continue;
    if (delimiter.length === 1 && (text[at + 1] === delimiter || text[at - 1] === delimiter)) continue;
    if (delimiter.startsWith("_") && isWord(text[at + delimiter.length])) continue;
    return at;
  }
  return -1;
}

function bracketEnd(text: string, at: number): number {
  let depth = 0;
  for (let index = at; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === "[") depth += 1;
    else if (text[index] === "]" && --depth === 0) return index;
  }
  return -1;
}

function parse(text: string, style: Style): Piece[] {
  const out: Piece[] = [];
  let plain = "";
  const flush = () => {
    if (plain !== "") out.push({ ...style, text: plain });
    plain = "";
  };
  const inner = (from: number, to: number, added: Style) => {
    flush();
    out.push(...parse(text.slice(from, to), { ...style, ...added }));
  };
  let at = 0;
  while (at < text.length) {
    const char = text[at] ?? "";
    if (char === "\\" && ESCAPABLE.test(text[at + 1] ?? "")) {
      plain += text[at + 1];
      at += 2;
      continue;
    }
    if (char === "`") {
      const size = runAt(text, at);
      const end = closingRun(text, size, at + size);
      if (end === -1) {
        plain += text.slice(at, at + size);
        at += size;
        continue;
      }
      const raw = text.slice(at + size, end);
      const code = raw.length > 2 && raw.startsWith(" ") && raw.endsWith(" ") && raw.trim() !== "" ? raw.slice(1, -1) : raw;
      flush();
      out.push({ ...style, color: CODE_KEY, ...(style.color === TONE_KEYS.muted ? { dimColor: true } : {}), text: code });
      at = end + size;
      continue;
    }
    const pair = ["**", "__", "~~"].find((delimiter) => text.startsWith(delimiter, at));
    if (pair !== undefined) {
      const end = opens(text, at, pair) ? closer(text, pair, at + 2) : -1;
      if (end === -1) plain += pair;
      else inner(at + 2, end, pair === "~~" ? { strikethrough: true } : { bold: true });
      at = end === -1 ? at + 2 : end + 2;
      continue;
    }
    if ((char === "*" || char === "_") && opens(text, at, char)) {
      const end = closer(text, char, at + 1);
      if (end !== -1) {
        inner(at + 1, end, { italic: true });
        at = end + 1;
        continue;
      }
    }
    const isImage = char === "!" && text[at + 1] === "[";
    if (char === "[" || isImage) {
      const open = isImage ? at + 1 : at;
      const end = bracketEnd(text, open);
      const close = end === -1 || text[end + 1] !== "(" ? -1 : text.indexOf(")", end + 2);
      if (close !== -1) {
        inner(open + 1, end, { underline: true });
        at = close + 1;
        continue;
      }
    }
    if (char === "<") {
      const link = /^<(https?:\/\/[^\s>]+)>/.exec(text.slice(at));
      if (link !== null) {
        flush();
        out.push({ ...style, underline: true, text: link[1] ?? "" });
        at += link[0].length;
        continue;
      }
    }
    plain += char;
    at += 1;
  }
  flush();
  return out;
}

const HEADING = /^#{1,6}\s+/;
const QUOTE = /^(?:>\s?)+/;

/**
 * One line of markdown as pieces in `base`'s style: code spans in CODE_KEY, strong text bold,
 * emphasis italic, strikethrough struck, a link's text underlined, a heading's line bold and a
 * quote's italic. A marker without its pair stays as written.
 */
export function inlineMarkdown(line: string, base: Style = {}): Piece[] {
  const text = line.trim();
  const heading = HEADING.exec(text);
  const quote = heading === null ? QUOTE.exec(text) : null;
  if (heading !== null) return mergePieces(parse(text.slice(heading[0].length).replace(/\s+#+$/, ""), { ...base, bold: true }));
  if (quote !== null) return mergePieces(parse(text.slice(quote[0].length), { ...base, italic: true }));
  return mergePieces(parse(text, base));
}

/** Every content line of `text` as pieces, joined by a space. */
export function markdownPieces(text: string, base: Style = {}): Piece[] {
  return mergePieces(contentLines(text).flatMap((line, index) => [...(index === 0 ? [] : [{ ...base, text: " " }]), ...inlineMarkdown(line, base)]));
}
