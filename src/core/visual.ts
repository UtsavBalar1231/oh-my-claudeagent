import { displayWidth, fitEnd, type Glyphs, glyphs, shortType } from "./ui-kit.ts";

// Every key here draws its theme's value for a mod, measured on 2.1.288 under a custom theme and
// the built-in light theme. `link`, `thinking` and `messageActionsBackground` draw nothing for a
// mod, and one invalid color string refuses the whole pane tree, so colors come only from here.
export const THEME_KEYS = [
  "claude",
  "claudeShimmer",
  "text",
  "inverseText",
  "inactive",
  "inactiveShimmer",
  "subtle",
  "suggestion",
  "permission",
  "permissionShimmer",
  "remember",
  "success",
  "error",
  "warning",
  "warningShimmer",
  "merged",
  "promptBorder",
  "promptBorderShimmer",
  "planMode",
  "autoAccept",
  "bashBorder",
  "ide",
  "fastMode",
  "fastModeShimmer",
  "diffAdded",
  "diffAddedWord",
  "diffAddedDimmed",
  "diffRemoved",
  "diffRemovedWord",
  "diffRemovedDimmed",
  "userMessageBackground",
  "userMessageBackgroundHover",
  "bashMessageBackgroundColor",
  "memoryBackgroundColor",
  "selectionBg",
  "rate_limit_fill",
  "rate_limit_empty",
  "briefLabelYou",
  "briefLabelClaude",
  "red_FOR_SUBAGENTS_ONLY",
  "blue_FOR_SUBAGENTS_ONLY",
  "green_FOR_SUBAGENTS_ONLY",
  "yellow_FOR_SUBAGENTS_ONLY",
  "purple_FOR_SUBAGENTS_ONLY",
  "orange_FOR_SUBAGENTS_ONLY",
  "pink_FOR_SUBAGENTS_ONLY",
  "cyan_FOR_SUBAGENTS_ONLY",
  "rainbow_red",
  "rainbow_red_shimmer",
  "rainbow_orange",
  "rainbow_orange_shimmer",
  "rainbow_yellow",
  "rainbow_yellow_shimmer",
  "rainbow_green",
  "rainbow_green_shimmer",
  "rainbow_blue",
  "rainbow_blue_shimmer",
  "rainbow_indigo",
  "rainbow_indigo_shimmer",
  "rainbow_violet",
  "rainbow_violet_shimmer",
] as const;

export type ThemeKey = (typeof THEME_KEYS)[number];

export const TONE_KEYS = {
  ok: "success",
  fail: "error",
  warn: "warning",
  active: "claude",
  shimmer: "claudeShimmer",
  info: "permission",
  plan: "planMode",
  muted: "inactive",
  rule: "subtle",
  focus: "selectionBg",
  raised: "userMessageBackground",
  fill: "rate_limit_fill",
  track: "rate_limit_empty",
} as const satisfies Record<string, ThemeKey>;

export type Tone = keyof typeof TONE_KEYS;
export type Paint = Tone | ThemeKey;

const isTone = (paint: Paint): paint is Tone => Object.hasOwn(TONE_KEYS, paint);

export const themeKey = (paint: Paint): ThemeKey => (isTone(paint) ? TONE_KEYS[paint] : paint);

export const AGENT_KEYS = {
  red: "red_FOR_SUBAGENTS_ONLY",
  blue: "blue_FOR_SUBAGENTS_ONLY",
  green: "green_FOR_SUBAGENTS_ONLY",
  yellow: "yellow_FOR_SUBAGENTS_ONLY",
  purple: "purple_FOR_SUBAGENTS_ONLY",
  orange: "orange_FOR_SUBAGENTS_ONLY",
  pink: "pink_FOR_SUBAGENTS_ONLY",
  cyan: "cyan_FOR_SUBAGENTS_ONLY",
} as const satisfies Record<string, ThemeKey>;

export type AgentColor = keyof typeof AGENT_KEYS;

// The `color` of each agents/*.md, so an agent draws in the color the transcript gives it.
export const ROSTER: Readonly<Record<string, AgentColor>> = {
  executor: "green",
  explore: "blue",
  hephaestus: "yellow",
  librarian: "orange",
  metis: "yellow",
  momus: "red",
  "multimodal-looker": "pink",
  oracle: "purple",
  prometheus: "cyan",
  sisyphus: "purple",
};

export function agentKey(type: string): ThemeKey {
  const name = shortType(type);
  const color = Object.hasOwn(ROSTER, name) ? ROSTER[name] : undefined;
  return color === undefined ? TONE_KEYS.muted : AGENT_KEYS[color];
}

export type Piece = { text: string; color?: ThemeKey; backgroundColor?: ThemeKey; bold?: true };

// Chip text is `inverseText` on a solid tone, the only chip pairing that reads in both themes;
// tint keys such as `diffAdded` measure 1.5 to 3.0 under text in the light theme.
export const CHIP_TONES = ["ok", "fail", "warn", "active", "info", "plan", "muted"] as const;
export type ChipTone = (typeof CHIP_TONES)[number];
export const CHIP_TEXT: ThemeKey = "inverseText";
const CHIP_MAX = 12;
export const ON_SURFACE: ThemeKey = "text";

export type Pair = { fg: ThemeKey; bg: ThemeKey; isShortBold: boolean };

export const DRAWN_PAIRS: readonly Pair[] = [
  ...CHIP_TONES.map((tone) => ({ fg: CHIP_TEXT, bg: TONE_KEYS[tone], isShortBold: true })),
  { fg: ON_SURFACE, bg: TONE_KEYS.raised, isShortBold: false },
  { fg: ON_SURFACE, bg: TONE_KEYS.focus, isShortBold: false },
];

export function chip(label: string, tone: ChipTone, ascii: boolean): Piece {
  const text = fitEnd(label, CHIP_MAX, ascii ? "..." : "…");
  return { text: ascii ? `[${text}]` : ` ${text} `, color: CHIP_TEXT, backgroundColor: TONE_KEYS[tone], bold: true };
}

export type Level = "ok" | "warn" | "fail" | "info";

export function levelMark(level: Level, g: Glyphs): { glyph: string; color: ThemeKey } {
  switch (level) {
    case "ok":
      return { glyph: g.check, color: TONE_KEYS.ok };
    case "warn":
      return { glyph: g.warn, color: TONE_KEYS.warn };
    case "fail":
      return { glyph: g.cross, color: TONE_KEYS.fail };
    case "info":
      return { glyph: g.dot, color: TONE_KEYS.muted };
  }
}

export type ViewState<T> =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "empty" }
  | { kind: "populated"; value: T };

export type Notice = { text: string; color: ThemeKey; isDim: boolean };

export function notice(
  state: Exclude<ViewState<unknown>, { kind: "populated" }>,
  words: { loading: string; empty: string },
  g: Glyphs,
  width: number,
): Notice {
  switch (state.kind) {
    case "loading":
      return { text: fitEnd(`${words.loading}${g.ellipsis}`, width, g.ellipsis), color: TONE_KEYS.muted, isDim: true };
    case "empty":
      return { text: fitEnd(words.empty, width, g.ellipsis), color: TONE_KEYS.muted, isDim: true };
    case "error":
      return { text: fitEnd(`${g.cross} ${state.reason}`, width, g.ellipsis), color: TONE_KEYS.fail, isDim: false };
  }
}

const BLOCK = "█";
const EIGHTHS = ["▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;
const SPARK = {
  unicode: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
  ascii: [".", ":", "-", "=", "+", "*", "#", "@"],
} as const;
const DOTS = {
  unicode: { ok: "●", fail: "✗", warn: "!", info: "○" },
  ascii: { ok: "o", fail: "x", warn: "!", info: "." },
} as const;

export type BarParts = { done: number; active?: number; failed?: number; todo: number };

const SEGMENTS = [
  { part: "done", tone: "ok", ascii: "#" },
  { part: "active", tone: "active", ascii: "=" },
  { part: "failed", tone: "fail", ascii: "x" },
  { part: "todo", tone: "track", ascii: "." },
] as const;

// Splits `room` units in proportion to the values, by largest remainder, so the sizes sum to
// `room` exactly and a non-zero value keeps at least one unit while there is room for it.
function allocate(values: readonly number[], room: number): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return values.map((_, index) => (index === values.length - 1 ? room : 0));
  const exact = values.map((value) => (value * room) / total);
  const sizes = exact.map((share, index) => ((values[index] ?? 0) > 0 ? Math.max(1, Math.floor(share)) : 0));
  let left = room - sizes.reduce((sum, size) => sum + size, 0);
  const pick = (score: (index: number) => number): number =>
    sizes.reduce((best, _, index) => (score(index) > score(best) ? index : best), 0);
  while (left > 0) {
    const index = pick((at) => ((values[at] ?? 0) > 0 ? (exact[at] ?? 0) - (sizes[at] ?? 0) : Number.NEGATIVE_INFINITY));
    sizes[index] = (sizes[index] ?? 0) + 1;
    left -= 1;
  }
  while (left < 0) {
    const index = pick((at) => sizes[at] ?? 0);
    sizes[index] = (sizes[index] ?? 0) - 1;
    left += 1;
  }
  return sizes;
}

function coalesce(pieces: readonly Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const piece of pieces) {
    const last = out.at(-1);
    if (last !== undefined && last.color === piece.color && last.backgroundColor === piece.backgroundColor && last.bold === piece.bold) {
      out[out.length - 1] = { ...last, text: `${last.text}${piece.text}` };
    } else {
      out.push(piece);
    }
  }
  return out;
}

const partsOf = (parts: BarParts) => SEGMENTS.map(({ part }) => Math.max(0, Math.floor(parts[part] ?? 0)));

/** A bar of exactly `width` cells: eighth-block seams in Unicode, `[##==x..]` in ASCII. */
export function bar(parts: BarParts, width: number, ascii: boolean): Piece[] {
  if (width <= 0) return [];
  const values = partsOf(parts);
  if (ascii) {
    const inner = width >= 3 ? width - 2 : width;
    const cells = allocate(values, inner).flatMap((size, index) => {
      const segment = SEGMENTS[index];
      return segment === undefined || size === 0 ? [] : [{ text: segment.ascii.repeat(size), color: TONE_KEYS[segment.tone] }];
    });
    return width >= 3 ? [{ text: "[" }, ...coalesce(cells), { text: "]" }] : coalesce(cells);
  }
  const ends: number[] = [];
  allocate(values, width * 8).reduce((end, size) => (ends.push(end + size), end + size), 0);
  const segmentAt = (unit: number) => ends.findIndex((end) => unit < end);
  const keyOf = (index: number) => TONE_KEYS[SEGMENTS[index]?.tone ?? "track"];
  const cells: Piece[] = [];
  for (let cell = 0; cell < width; cell += 1) {
    const first = segmentAt(cell * 8);
    const last = segmentAt(cell * 8 + 7);
    const covered = (ends[first] ?? 0) - cell * 8;
    cells.push(
      first === last
        ? { text: BLOCK, color: keyOf(first) }
        : { text: EIGHTHS[covered - 1] ?? BLOCK, color: keyOf(first), backgroundColor: keyOf(last) },
    );
  }
  return coalesce(cells);
}

/** One cell per value, scaled from zero to the largest value. */
export function spark(values: readonly number[], ascii: boolean): string {
  const levels = ascii ? SPARK.ascii : SPARK.unicode;
  const top = Math.max(0, ...values);
  return values
    .map((value) => levels[top === 0 ? 0 : Math.round((Math.max(0, value) / top) * (levels.length - 1))] ?? "")
    .join("");
}

/** One glyph per outcome, so the strip reads without color too. */
export function dots(levels: readonly Level[], ascii: boolean): Piece[] {
  const set = ascii ? DOTS.ascii : DOTS.unicode;
  const tone = { ok: TONE_KEYS.ok, fail: TONE_KEYS.fail, warn: TONE_KEYS.warn, info: TONE_KEYS.muted } as const;
  return coalesce(levels.map((level) => ({ text: set[level], color: tone[level] })));
}

const MINI_BAR = 8;
// Below this many cells a section label stops reading as a name, so the mini bar goes first.
const MIN_LABEL = 8;

/** A section divider of exactly `width` cells: `── Label ── ████▌    3/7 ─────`. */
export function rule(
  width: number,
  g: Glyphs,
  ascii: boolean,
  label = "",
  tally?: { done: number; total: number },
): Piece[] {
  if (width <= 0) return [];
  const line = (cells: number): Piece[] => (cells > 0 ? [{ text: g.rule.repeat(cells), color: TONE_KEYS.rule }] : []);
  const count = tally === undefined ? "" : `${tally.done}/${tally.total}`;
  const tails: Piece[][] =
    tally === undefined
      ? [[]]
      : [
          [...line(2), { text: " " }, ...bar({ done: tally.done, todo: tally.total - tally.done }, MINI_BAR, ascii), { text: ` ${count} ` }],
          [...line(2), { text: ` ${count} ` }],
          [],
        ];
  const wanted = displayWidth(label);
  for (const [index, tail] of tails.entries()) {
    const tailWidth = tail.reduce((sum, piece) => sum + displayWidth(piece.text), 0);
    const room = width - 4 - tailWidth;
    const isLast = index === tails.length - 1;
    if (!isLast && room < Math.min(wanted, MIN_LABEL)) continue;
    const name = label === "" ? "" : fitEnd(label, Math.max(0, room), g.ellipsis);
    const head: Piece[] = name === "" ? [] : [...line(2), { text: " " }, { text: name, color: ON_SURFACE, bold: true }, { text: " " }];
    const used = [...head, ...tail].reduce((sum, piece) => sum + displayWidth(piece.text), 0);
    if (used > width) return line(width);
    return [...head, ...tail, ...line(width - used)];
  }
  return line(width);
}

export type WidthTier = "page" | "inline" | "split";

// Measured on 2.1.288: a dock at 120 columns has a 56-column body and one at 200 a 90-column
// body, the narrowest where a master list and its detail both fit side by side.
const SPLIT_FROM = 90;
const INLINE_FROM = 56;

export function widthTier(bodyColumns: number): WidthTier {
  if (bodyColumns >= SPLIT_FROM) return "split";
  return bodyColumns >= INLINE_FROM ? "inline" : "page";
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const DIFF_HEADER = /^(?:diff |index |--- |\+\+\+ |new file mode |deleted file mode |similarity |rename )/;

/**
 * True when every hunk's line counts match its header. The engine draws a mismatched diff as
 * plain code and posts a transcript row about it, so only a valid diff is drawn as a diff.
 */
export function isValidDiff(source: string): boolean {
  const lines = source.endsWith("\n") ? source.slice(0, -1).split("\n") : source.split("\n");
  let old = 0;
  let next = 0;
  let hunks = 0;
  for (const line of lines) {
    const header = HUNK.exec(line);
    if (header !== null) {
      if (old !== 0 || next !== 0) return false;
      old = Number(header[1] ?? 1);
      next = Number(header[2] ?? 1);
      hunks += 1;
      continue;
    }
    if (hunks === 0) {
      if (!DIFF_HEADER.test(line)) return false;
      continue;
    }
    if (line.startsWith("\\")) continue;
    if (old === 0 && next === 0 && DIFF_HEADER.test(line)) continue;
    const mark = line[0];
    if (mark === " " || line === "") {
      old -= 1;
      next -= 1;
    } else if (mark === "-") {
      old -= 1;
    } else if (mark === "+") {
      next -= 1;
    } else {
      return false;
    }
    if (old < 0 || next < 0) return false;
  }
  return hunks > 0 && old === 0 && next === 0;
}

const SECRETS: readonly { pattern: RegExp; keep?: (match: string, ...groups: string[]) => string }[] = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[\s\S]*$)/g },
  {
    pattern: /(?<![A-Za-z0-9])([A-Za-z0-9_-]*(?:password|passwd|token|secret|api_key))(\s*=\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s"'&;,‹]+)/gi,
    keep: (_match, key = "", equals = "") => `${key}${equals}`,
  },
  { pattern: /\b([Bb]earer\s+)[A-Za-z0-9._~+/-]{8,}=*/g, keep: (_match, word = "") => word },
  { pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g },
  { pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { pattern: /(?<![A-Za-z0-9])xox[abpr]-[A-Za-z0-9-]{10,}/g },
  { pattern: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g },
  { pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}/g },
  { pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
];

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Masks secrets and shortens the home directory to `~`; `masked` counts the secrets only. */
export function redact(text: string, home: string, mask = glyphs(false).mask): { text: string; masked: number } {
  let masked = 0;
  let out = text;
  for (const { pattern, keep } of SECRETS) {
    out = out.replace(pattern, (match: string, ...groups: unknown[]) => {
      masked += 1;
      return `${keep === undefined ? "" : keep(match, ...groups.filter((group): group is string => typeof group === "string"))}${mask}`;
    });
  }
  const root = home.replace(/[\\/]+$/, "");
  if (root !== "") out = out.replace(new RegExp(`(?<![\\w.-])${escaped(root)}(?![\\w.-])`, "g"), "~");
  return { text: out, masked };
}
