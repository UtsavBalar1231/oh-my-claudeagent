export const GLYPH_TIERS = ["nerd", "unicode", "ascii"] as const;
export type GlyphTier = (typeof GLYPH_TIERS)[number];

export const isGlyphTier = (value: string): value is GlyphTier => GLYPH_TIERS.some((tier) => tier === value);

/** `OMCA_GLYPHS` read as a tier: unset, empty or unknown is `nerd`, since no surface can see the terminal's font. */
export function glyphTier(value: string | undefined): GlyphTier {
  const wanted = value?.trim().toLowerCase() ?? "";
  return isGlyphTier(wanted) ? wanted : "nerd";
}

const UNICODE_SET = {
  pointer: "❯",
  check: "✓",
  cross: "✗",
  warn: "!",
  info: "i",
  running: "●",
  pending: "○",
  up: "↑",
  down: "↓",
  dot: "·",
  rule: "─",
  vrule: "│",
  ellipsis: "…",
  progress: "◐",
  blocked: "⊘",
  agent: "◆",
  mask: "‹masked›",
} as const;

export type Glyphs = { readonly tier: GlyphTier } & { readonly [K in keyof typeof UNICODE_SET]: string };

const UNICODE: Glyphs = { tier: "unicode", ...UNICODE_SET };

// Nerd Font glyphs present at the same code point in Nerd Fonts v2 and v3. A plain Nerd Font draws
// them up to 1.9 cells wide on a one-cell advance, so each one is drawn before a space or a row's end.
const NERD: Glyphs = {
  ...UNICODE,
  tier: "nerd",
  check: "\u{f05d}",
  cross: "\u{f057}",
  warn: "\u{f06a}",
  info: "\u{f05a}",
  pending: "\u{f10c}",
  running: "\u{f111}",
  progress: "\u{f192}",
  blocked: "\u{f05e}",
  agent: "\u{f007}",
};

const ASCII: Glyphs = {
  tier: "ascii",
  pointer: ">",
  check: "+",
  cross: "x",
  warn: "!",
  info: "i",
  running: "*",
  pending: "o",
  up: "^",
  down: "v",
  dot: "-",
  rule: "-",
  vrule: "|",
  ellipsis: "...",
  progress: "~",
  blocked: "/",
  agent: "@",
  mask: "<masked>",
};

export function glyphs(tier: GlyphTier): Glyphs {
  switch (tier) {
    case "nerd":
      return NERD;
    case "unicode":
      return UNICODE;
    case "ascii":
      return ASCII;
  }
}

/** Each roster agent's Nerd Font icon, shared with the status line. */
export const AGENT_ICONS: Readonly<Record<string, string>> = {
  executor: "\u{f085}",
  explore: "\u{f14e}",
  hephaestus: "\u{f0ad}",
  librarian: "\u{f02d}",
  metis: "\u{f002}",
  momus: "\u{f075}",
  "multimodal-looker": "\u{f030}",
  oracle: "\u{f06e}",
  prometheus: "\u{f06d}",
  sisyphus: "\u{f01e}",
};

/** The agent's own icon in the Nerd tier, the shared agent glyph in the others. */
export function agentGlyph(type: string, g: Glyphs): string {
  if (g.tier !== "nerd") return g.agent;
  const name = shortType(type);
  return (Object.hasOwn(AGENT_ICONS, name) ? AGENT_ICONS[name] : undefined) ?? g.agent;
}

/** The cells between two columns, two keys, or a chip's neighbours, everywhere OMCA draws. */
export const COLUMN_GAP = 2;

export const KEYS = {
  next: "n",
  prev: "p",
  contents: "t",
  reload: "r",
  list: "l",
  back: "esc",
} as const;

export function keyHint(pairs: readonly (readonly [key: string, label: string])[], g: Glyphs): string {
  return pairs.map(([key, label]) => `${key} ${label}`).join(` ${g.dot} `);
}

// The engine draws a pane's close mark over the last body columns of the topmost visible
// row, whichever row that is after scrolling, so every row leaves them free.
const GUTTER = 3;

export function usableColumns(bodyColumns: number): number {
  return Math.max(0, bodyColumns - GUTTER);
}

// East Asian Wide symbols in the BMP outside the CJK blocks, such as ✅ ❌ ⭐ ⏰, which terminals
// draw two cells wide.
const WIDE_SYMBOLS: readonly (readonly [number, number])[] = [
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0xfe10, 0xfe19],
];

const ZWJ = 0x200d;

export function cells(codePoint: number): number {
  if ((codePoint >= 0x300 && codePoint <= 0x36f) || (codePoint >= 0x200b && codePoint <= 0x200f)) return 0;
  if ((codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0x20d0 && codePoint <= 0x20ff)) return 0;
  if ((codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)) return 0;
  const isWide =
    WIDE_SYMBOLS.some(([low, high]) => codePoint >= low && codePoint <= high) ||
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd);
  return isWide ? 2 : 1;
}

// A code point after a zero-width joiner joins the glyph before it, so 👨‍👩‍👧 takes the cells of one.
function widths(chars: Iterable<string>): number[] {
  let previous = 0;
  return Array.from(chars, (char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    const width = previous === ZWJ ? 0 : cells(codePoint);
    previous = codePoint;
    return width;
  });
}

export function displayWidth(text: string): number {
  return widths(text).reduce((sum, width) => sum + width, 0);
}

function head(chars: readonly string[], room: number): string {
  const sizes = widths(chars);
  let used = 0;
  let out = "";
  for (const [index, char] of chars.entries()) {
    used += sizes[index] ?? 0;
    if (used > room) break;
    out += char;
  }
  return out;
}

function tail(chars: readonly string[], room: number): string {
  return [...head([...chars].reverse(), room)].reverse().join("");
}

export function fitEnd(text: string, width: number, ellipsis: string): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  const room = width - displayWidth(ellipsis);
  if (room <= 0) return head([...ellipsis], width);
  return `${head([...text], room).trimEnd()}${ellipsis}`;
}

export function fitMiddle(text: string, width: number, ellipsis: string): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  const room = width - displayWidth(ellipsis);
  if (room <= 0) return head([...ellipsis], width);
  const chars = [...text];
  const front = Math.ceil(room / 2);
  return `${head(chars, front)}${ellipsis}${tail(chars, room - front)}`;
}

export function wrapText(text: string, width: number): string[] {
  const room = Math.max(1, width);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (word === "") continue;
    if (line !== "" && displayWidth(line) + 1 + displayWidth(word) <= room) {
      line = `${line} ${word}`;
      continue;
    }
    if (line !== "") lines.push(line);
    let rest = word;
    while (rest !== "" && displayWidth(rest) > room) {
      const piece = head([...rest], room) || String.fromCodePoint(rest.codePointAt(0) ?? 0);
      lines.push(piece);
      rest = rest.slice(piece.length);
    }
    line = rest;
  }
  if (line !== "" || lines.length === 0) lines.push(line);
  return lines;
}

export function padEnd(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - displayWidth(text)))}`;
}

export function padStart(text: string, width: number): string {
  return `${" ".repeat(Math.max(0, width - displayWidth(text)))}${text}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

// Rounded before the tier is picked, so 99,950 reads 100k and 999,500 reads 1.0M.
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const tenths = (tokens / 1000).toFixed(1);
  if (Number(tenths) < 100) return `${tenths}k`;
  const thousands = Math.round(tokens / 1000);
  if (thousands < 1000) return `${thousands}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export const two = (value: number) => String(value).padStart(2, "0");

export function formatWhen(at: number | string): string {
  const date = new Date(at);
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** The local calendar day, `2026-10-02`. */
export function dayOf(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** `09:05`, in local time. */
export function clockOf(at: number, withSeconds = false): string {
  const date = new Date(at);
  const minutes = `${two(date.getHours())}:${two(date.getMinutes())}`;
  return withSeconds ? `${minutes}:${two(date.getSeconds())}` : minutes;
}

export const shortType = (type: string): string => type.slice(type.lastIndexOf(":") + 1);

export const oneLine = (text: string): string => text.replace(/[\s\p{Cc}]+/gu, " ").trim();

/** Water-fills `room` cells over the wants: the smaller wants are met whole, the rest split evenly. */
export function share(wants: readonly number[], room: number): number[] {
  const sizes = wants.map(() => 0);
  const order = wants.map((_, index) => index).sort((a, b) => (wants[a] ?? 0) - (wants[b] ?? 0));
  let left = Math.max(0, room);
  order.forEach((index, rank) => {
    const size = Math.min(wants[index] ?? 0, Math.floor(left / (order.length - rank)));
    sizes[index] = size;
    left -= size;
  });
  return sizes;
}

export type Ranked = { priority: number; min: number };

/**
 * The segments that fit `room` cells with `gap` cells between neighbours, in their own order.
 * While they do not fit, the one with the largest priority number goes, the later one on a tie;
 * the last segment standing is kept whatever its size.
 */
export function arrange<T extends Ranked>(segments: readonly T[], room: number, gap: number): T[] {
  let kept = [...segments];
  const need = (list: readonly T[]) => list.reduce((sum, segment) => sum + segment.min, 0) + gap * Math.max(0, list.length - 1);
  while (kept.length > 1 && need(kept) > room) {
    const last = kept.reduce((worst, segment) => (segment.priority >= worst.priority ? segment : worst));
    kept = kept.filter((segment) => segment !== last);
  }
  return kept;
}
