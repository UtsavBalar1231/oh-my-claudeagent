export const COLORS = {
  accent: "claude",
  ok: "success",
  fail: "error",
  warn: "warning",
  info: "suggestion",
  muted: "inactive",
} as const;

export type Color = (typeof COLORS)[keyof typeof COLORS];

const UNICODE = {
  pointer: "❯",
  check: "✓",
  cross: "✗",
  warn: "!",
  running: "●",
  pending: "○",
  up: "↑",
  down: "↓",
  dot: "·",
  rule: "─",
  ellipsis: "…",
} as const;

export type Glyphs = { readonly [K in keyof typeof UNICODE]: string };

const ASCII: Glyphs = {
  pointer: ">",
  check: "+",
  cross: "x",
  warn: "!",
  running: "*",
  pending: "o",
  up: "^",
  down: "v",
  dot: "-",
  rule: "-",
  ellipsis: "...",
};

export function isAsciiRequested(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}

export function glyphs(ascii: boolean): Glyphs {
  return ascii ? ASCII : UNICODE;
}

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

export function cells(codePoint: number): number {
  if ((codePoint >= 0x300 && codePoint <= 0x36f) || (codePoint >= 0x200b && codePoint <= 0x200f)) return 0;
  if ((codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0x20d0 && codePoint <= 0x20ff)) return 0;
  const isWide =
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

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += cells(char.codePointAt(0) ?? 0);
  return width;
}

function head(chars: readonly string[], room: number): string {
  let used = 0;
  let out = "";
  for (const char of chars) {
    used += cells(char.codePointAt(0) ?? 0);
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

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 100_000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

const two = (value: number) => String(value).padStart(2, "0");

export function formatWhen(at: number | string): string {
  const date = new Date(at);
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

export const shortType = (type: string): string => type.slice(type.lastIndexOf(":") + 1);

export type ViewState<T> =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "empty" }
  | { kind: "populated"; value: T };

export type Notice = { text: string; color: Color; isDim: boolean };

export function notice(
  state: Exclude<ViewState<unknown>, { kind: "populated" }>,
  words: { loading: string; empty: string },
  g: Glyphs,
  width: number,
): Notice {
  switch (state.kind) {
    case "loading":
      return { text: fitEnd(`${words.loading}${g.ellipsis}`, width, g.ellipsis), color: COLORS.muted, isDim: true };
    case "empty":
      return { text: fitEnd(words.empty, width, g.ellipsis), color: COLORS.muted, isDim: true };
    case "error":
      return { text: fitEnd(`${g.cross} ${state.reason}`, width, g.ellipsis), color: COLORS.fail, isDim: false };
  }
}

export type Level = "ok" | "warn" | "fail" | "info";

export function levelMark(level: Level, g: Glyphs): { glyph: string; color: Color } {
  switch (level) {
    case "ok":
      return { glyph: g.check, color: COLORS.ok };
    case "warn":
      return { glyph: g.warn, color: COLORS.warn };
    case "fail":
      return { glyph: g.cross, color: COLORS.fail };
    case "info":
      return { glyph: g.dot, color: COLORS.muted };
  }
}
