const TAB = 9;
const NEWLINE = 10;
const CR = 13;

// Filtered by char code: the engine's parser refuses a regex literal holding `\u0000`-style
// escapes and fails the whole module.
function isUnsafe(code: number): boolean {
  return (
    (code < 32 && code !== TAB && code !== NEWLINE) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff
  );
}

/** CRLF folded to LF and control or invisible characters dropped, so every reader sees one text. */
export function clean(text: string): string {
  let out = "";
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (!isUnsafe(code)) continue;
    out += text.slice(start, index);
    if (code === CR) {
      out += "\n";
      if (text.charCodeAt(index + 1) === NEWLINE) index += 1;
    }
    start = index + 1;
  }
  return start === 0 ? text : out + text.slice(start);
}

// The Markdown element refuses text over 10,000 characters; the margin keeps a split line safe.
export const MARKDOWN_CHUNK = 9_000;

/** Text cut at line ends into pieces the Markdown element takes; a longer line is cut where it must be. */
export function chunks(body: string, limit = MARKDOWN_CHUNK): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of body.split("\n")) {
    for (let start = 0; start === 0 || start < line.length; start += limit) {
      const piece = line.slice(start, start + limit);
      if (current !== "" && current.length + piece.length + 1 > limit) {
        out.push(current);
        current = "";
      }
      current = current === "" ? piece : `${current}\n${piece}`;
    }
  }
  if (current !== "") out.push(current);
  return out;
}
