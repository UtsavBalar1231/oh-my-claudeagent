import { describe, expect, test } from "bun:test";
import {
  AGENT_ICONS,
  cells,
  agentGlyph,
  arrange,
  displayWidth,
  fitEnd,
  fitMiddle,
  formatDuration,
  formatTokens,
  formatWhen,
  glyphs,
  glyphTier,
  type GlyphTier,
  keyHint,
  oneLine,
  padEnd,
  padStart,
  share,
  shortType,
  usableColumns,
  wrapText,
} from "./ui-kit.ts";

const E = glyphs("unicode").ellipsis;

describe("displayWidth", () => {
  test.each([
    ["ascii", "abc", 3],
    ["CJK", "日本", 4],
    ["wide BMP symbols", "✅❌⭐⏰", 8],
    ["narrow BMP symbols OMCA draws", "✓✗●○◐⊘◆·✢✳✶✻✽", 13],
    ["Nerd Font glyphs in the private use area", "\u{f05d}\u{f057}\u{f06a}\u{f085}", 4],
    ["a skin tone joins its emoji", "👍🏽", 2],
    ["a ZWJ family is one glyph", "👨‍👩‍👧", 2],
  ])("%s", (_name, text, width) => {
    expect(displayWidth(text)).toBe(width);
  });

  test("a cut never splits a ZWJ sequence's width", () => {
    expect(fitEnd("👨‍👩‍👧 family", 4, E)).toBe("👨‍👩‍👧…");
  });
});

// The width rules as first written, one array pass per call, kept to hold the fast paths to them.
const REFERENCE_WIDE: readonly (readonly [number, number])[] = [
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0xfe10, 0xfe19],
];

function referenceCells(codePoint: number): number {
  if ((codePoint >= 0x300 && codePoint <= 0x36f) || (codePoint >= 0x200b && codePoint <= 0x200f)) return 0;
  if ((codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0x20d0 && codePoint <= 0x20ff)) return 0;
  if ((codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)) return 0;
  const isWide =
    REFERENCE_WIDE.some(([low, high]) => codePoint >= low && codePoint <= high) ||
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

function referenceWidths(chars: Iterable<string>): number[] {
  let previous = 0;
  return Array.from(chars, (char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    const width = previous === 0x200d ? 0 : referenceCells(codePoint);
    previous = codePoint;
    return width;
  });
}

const referenceWidth = (text: string): number => referenceWidths(text).reduce((sum, width) => sum + width, 0);

function referenceHead(chars: readonly string[], room: number): string {
  const sizes = referenceWidths(chars);
  let used = 0;
  let out = "";
  for (const [index, char] of chars.entries()) {
    used += sizes[index] ?? 0;
    if (used > room) break;
    out += char;
  }
  return out;
}

function referenceWrap(text: string, width: number): string[] {
  const room = Math.max(1, width);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (word === "") continue;
    if (line !== "" && referenceWidth(line) + 1 + referenceWidth(word) <= room) {
      line = `${line} ${word}`;
      continue;
    }
    if (line !== "") lines.push(line);
    let rest = word;
    while (rest !== "" && referenceWidth(rest) > room) {
      const piece = referenceHead([...rest], room) || String.fromCodePoint(rest.codePointAt(0) ?? 0);
      lines.push(piece);
      rest = rest.slice(piece.length);
    }
    line = rest;
  }
  if (line !== "" || lines.length === 0) lines.push(line);
  return lines;
}

const WIDTH_SAMPLES = [
  "",
  "plain ascii line with spaces",
  "caf\u00e9 na\u00efve \u00fc\u00df \u00a9\u00ae \u00bd",
  "e\u0301 a\u0300\u0301 combining \u0345",
  "\u200b\u200c\u200d\u200e\u200f zero widths",
  "日本語 中文 한국어 ｆｕｌｌ",
  "✅❌⭐⏰ ✓✗●○◐⊘◆·✢✳✶✻✽",
  "\u{f05d}\u{f057}\u{f06a}\u{f085} \u{e0b0}\u{f101}",
  "👍🏽 👨‍👩‍👧 👩‍💻 ❤️ 🏳️‍🌈 🇯🇵",
  "a\u200d b\u200d\u200d c ‍x",
  "lone \ud800 and \udc00 surrogates \ud83d",
  "tab\tand\u0000nul\u0007bell",
];

describe("fast paths match the width rules as first written", () => {
  test("cells agrees with the reference on every code point up to U+3FFFF", () => {
    for (let codePoint = 0; codePoint <= 0x3ffff; codePoint += 1) {
      if (cells(codePoint) !== referenceCells(codePoint)) throw new Error(`cells(U+${codePoint.toString(16)}) differs`);
    }
  });

  test.each(WIDTH_SAMPLES.map((text) => [JSON.stringify(text), text] as const))("displayWidth of %s", (_name, text) => {
    expect(displayWidth(text)).toBe(referenceWidth(text));
  });

  test("displayWidth and fitEnd agree on every prefix of the mixed samples", () => {
    for (const text of WIDTH_SAMPLES) {
      const chars = [...text];
      for (let end = 0; end <= chars.length; end += 1) {
        const prefix = chars.slice(0, end).join("");
        expect(displayWidth(prefix)).toBe(referenceWidth(prefix));
      }
    }
  });

  test("fitEnd and fitMiddle cut mixed text where the reference does", () => {
    const text = WIDTH_SAMPLES.join(" ");
    for (let width = 1; width < 40; width += 1) {
      const room = width - displayWidth(E);
      expect(fitEnd(text, width, E)).toBe(room <= 0 ? referenceHead([...E], width) : `${referenceHead([...text], room).trimEnd()}${E}`);
      const front = Math.ceil(room / 2);
      const tailOf = [...referenceHead([...text].reverse(), room - front)].reverse().join("");
      if (room > 0) expect(fitMiddle(text, width, E)).toBe(`${referenceHead([...text], front)}${E}${tailOf}`);
    }
  });
});

describe("fitEnd", () => {
  test.each([
    ["hello world", 0, ""],
    ["hello world", -3, ""],
    ["hello world", 1, "…"],
    ["hello world", 2, "h…"],
    ["hello world", 5, "hell…"],
    ["hello world", 7, "hello…"],
    ["hello world", 10, "hello wor…"],
    ["hello world", 11, "hello world"],
    ["hello world", 12, "hello world"],
    ["", 0, ""],
    ["", 4, ""],
  ])("fitEnd(%p, %p) is %p", (text, width, expected) => {
    expect(fitEnd(text, width, E)).toBe(expected);
  });

  test.each([
    [1, "."],
    [2, ".."],
    [3, "..."],
    [4, "h..."],
    [8, "hello..."],
    [11, "hello world"],
  ])("with the ASCII ellipsis at width %p it is %p", (width, expected) => {
    expect(fitEnd("hello world", width, "...")).toBe(expected);
  });

  test("counts wide characters as two cells and never splits a surrogate pair", () => {
    expect(fitEnd("日本語", 6, E)).toBe("日本語");
    expect(fitEnd("日本語", 5, E)).toBe("日本…");
    expect(fitEnd("日本語", 4, E)).toBe("日…");
    expect(fitEnd("a😀b", 3, E)).toBe("a…");
    expect(fitEnd("a😀b", 4, E)).toBe("a😀b");
  });
});

describe("fitMiddle", () => {
  test.each([
    ["/home/u/.claude/plans/a-very-long-plan-name.md", 0, ""],
    ["/home/u/.claude/plans/a-very-long-plan-name.md", 1, "…"],
    ["/home/u/.claude/plans/a-very-long-plan-name.md", 2, "/…"],
    ["/home/u/.claude/plans/a-very-long-plan-name.md", 3, "/…d"],
    ["/home/u/.claude/plans/a-very-long-plan-name.md", 20, "/home/u/.c…n-name.md"],
    ["/home/u/.claude/plans/a-very-long-plan-name.md", 45, "/home/u/.claude/plans/…very-long-plan-name.md"],
    ["/home/u/.claude/plans/a-very-long-plan-name.md", 46, "/home/u/.claude/plans/a-very-long-plan-name.md"],
    ["short", 5, "short"],
    ["short", 4, "sh…t"],
  ])("fitMiddle(%p, %p) is %p", (text, width, expected) => {
    expect(fitMiddle(text, width, E)).toBe(expected);
  });

  test("keeps both ends with the ASCII ellipsis", () => {
    expect(fitMiddle("/a/b/c/d/e/f.md", 9, "...")).toBe("/a/....md");
    expect(fitMiddle("/a/b/c/d/e/f.md", 2, "...")).toBe("..");
  });

  test("every fitted result stays within its width", () => {
    const text = "~/.claude/plans/omca-v3-typescript-mods-rewrite.md";
    for (let width = 0; width <= text.length + 2; width += 1) {
      expect(displayWidth(fitMiddle(text, width, E))).toBeLessThanOrEqual(width);
      expect(displayWidth(fitEnd(text, width, E))).toBeLessThanOrEqual(width);
    }
  });
});

describe("glyphs", () => {
  test.each<[string | undefined, GlyphTier]>([
    [undefined, "nerd"],
    ["", "nerd"],
    ["nerd", "nerd"],
    [" Unicode ", "unicode"],
    ["ASCII", "ascii"],
    ["1", "nerd"],
    ["0", "nerd"],
  ])("OMCA_GLYPHS=%p selects %p", (value, expected) => {
    expect(glyphTier(value)).toBe(expected);
  });

  test("the ASCII set replaces every non-ASCII glyph and keeps each status glyph one cell wide", () => {
    const unicode = glyphs("unicode");
    const ascii = glyphs("ascii");
    expect(Object.keys(ascii).toSorted()).toEqual(Object.keys(unicode).toSorted());
    for (const [name, glyph] of Object.entries(ascii)) {
      expect({ name, ascii: /^[\x20-\x7e]+$/.test(glyph) }).toEqual({ name, ascii: true });
    }
    for (const name of ["pointer", "check", "cross", "warn", "info", "running", "pending", "up", "down", "dot", "rule", "vrule", "progress", "blocked", "agent"] as const) {
      expect({ name, unicode: displayWidth(unicode[name]), ascii: ascii[name].length }).toEqual({ name, unicode: 1, ascii: 1 });
    }
    expect(fitEnd("hello world", 6, ascii.ellipsis)).toBe("hel...");
  });

  test("the Nerd set overrides the status and agent glyphs with one-cell Nerd Font icons and keeps the rest", () => {
    const nerd = glyphs("nerd");
    const unicode = glyphs("unicode");
    const icons = ["check", "cross", "warn", "info", "pending", "running", "progress", "blocked", "agent"] as const;
    expect(icons.map((name) => nerd[name].codePointAt(0)?.toString(16))).toEqual(["f05d", "f057", "f06a", "f05a", "f10c", "f111", "f192", "f05e", "f007"]);
    for (const name of icons) expect(displayWidth(nerd[name])).toBe(1);
    for (const name of ["pointer", "up", "down", "dot", "rule", "vrule", "ellipsis", "mask"] as const) expect(nerd[name]).toBe(unicode[name]);
    expect([nerd.tier, unicode.tier, glyphs("ascii").tier]).toEqual(["nerd", "unicode", "ascii"]);
  });

  test("an agent draws its own icon in the Nerd set, the default icon when unknown, and the shared glyph otherwise", () => {
    const nerd = glyphs("nerd");
    expect(agentGlyph("oh-my-claudeagent:architect", nerd)).toBe("\u{f0eb}");
    expect(agentGlyph("oh-my-claudeagent:build-fixer", nerd)).toBe("\u{f0ad}");
    expect(agentGlyph("other-plugin:planner", nerd)).toBe("\u{f007}");
    expect(agentGlyph("executor", nerd)).toBe("\u{f085}");
    expect(agentGlyph("general-purpose", nerd)).toBe("\u{f007}");
    expect(agentGlyph("oh-my-claudeagent:architect", glyphs("unicode"))).toBe("◆");
    expect(agentGlyph("oh-my-claudeagent:architect", glyphs("ascii"))).toBe("@");
    for (const icon of Object.values(AGENT_ICONS)) expect(displayWidth(icon)).toBe(1);
  });
});

describe("keys and layout", () => {
  test("a key hint joins each key and label with the shared separator", () => {
    const pairs = [["n", "next"], ["p", "prev"], ["esc", "back"]] as const;
    expect(keyHint(pairs, glyphs("unicode"))).toBe("n next · p prev · esc back");
    expect(keyHint(pairs, glyphs("ascii"))).toBe("n next - p prev - esc back");
  });

  test("the right gutter keeps three columns free", () => {
    expect([80, 3, 2, 0].map(usableColumns)).toEqual([77, 0, 0, 0]);
  });
});

describe("padding", () => {
  test("pads to display width, wide characters counting two cells, and never cuts", () => {
    expect(padEnd("ab", 5)).toBe("ab   ");
    expect(padStart("ab", 5)).toBe("   ab");
    expect(padEnd("日本", 6)).toBe("日本  ");
    expect(padStart("12.3k", 3)).toBe("12.3k");
  });
});

describe("formatDuration", () => {
  test.each([
    [-5, "0s"],
    [999, "0s"],
    [59_999, "59s"],
    [60_000, "1m00s"],
    [66_000, "1m06s"],
    [3_599_999, "59m59s"],
    [3_600_000, "1h00m"],
    [5_430_000, "1h30m"],
  ])("%p ms is %p", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("formatTokens", () => {
  test.each([
    [0, "0"],
    [999, "999"],
    [1000, "1.0k"],
    [13_500, "13.5k"],
    [99_949, "99.9k"],
    [99_950, "100k"],
    [100_000, "100k"],
    [129_000, "129k"],
    [999_499, "999k"],
    [999_500, "1.0M"],
    [1_000_000, "1.0M"],
    [1_041_500, "1.0M"],
    [12_340_000, "12.3M"],
  ])("%p tokens is %p", (tokens, text) => {
    expect(formatTokens(tokens)).toBe(text);
  });
});

test("a time reads month-day hour:minute in the local zone, from milliseconds or an ISO string", () => {
  const at = new Date(2026, 9, 2, 9, 5);
  expect(formatWhen(at.getTime())).toBe("10-02 09:05");
  expect(formatWhen(at.toISOString())).toBe("10-02 09:05");
});

test("an agent type loses its plugin prefix", () => {
  expect(shortType("oh-my-claudeagent:executor")).toBe("executor");
  expect(shortType("explorer")).toBe("explorer");
});

describe("wrapText", () => {
  test("breaks between words, never past the width", () => {
    expect(wrapText("one two three four", 9)).toEqual(["one two", "three", "four"]);
    expect(wrapText("one two three four", 18)).toEqual(["one two three four"]);
  });

  test("a word longer than the width is cut at the width", () => {
    expect(wrapText("a /very/long/path b", 6)).toEqual(["a", "/very/", "long/p", "ath b"]);
  });

  test("counts cells, so wide characters take two", () => {
    expect(wrapText("日本語 日本語", 6)).toEqual(["日本語", "日本語"]);
    expect(wrapText("日本語", 1)).toEqual(["日", "本", "語"]);
  });

  test("empty text is one empty line, and a width under 1 acts as 1", () => {
    expect(wrapText("", 10)).toEqual([""]);
    expect(wrapText("ab", 0)).toEqual(["a", "b"]);
  });

  const PROMPT =
    "Implement the retry logic for the evidence ledger so a busy lock backs off, then fails open without blocking the stop gate. " +
    "Keep 日本語 and ✅ marks intact, plus 👨‍👩‍👧 family glyphs and \u{f05d} icons, and a /very/long/path/that/never/breaks/anywhere/at/all/ok too.";

  test.each([6, 10, 24, 40, 72, 120])("matches the reference on a long prompt at %i columns", (columns) => {
    expect(wrapText(PROMPT, columns)).toEqual(referenceWrap(PROMPT, columns));
  });

  test("matches the reference on an over-width word between short ones", () => {
    const text = `a ${"x".repeat(50)} b 日本語日本語日本語日本語 c`;
    for (const columns of [1, 2, 7, 20, 51, 80]) expect(wrapText(text, columns)).toEqual(referenceWrap(text, columns));
  });

  test("matches the reference when a line ends in a zero-width joiner", () => {
    const text = "👨\u200d 👩 b\u200d c d\u200d\u200d e";
    for (let columns = 1; columns < 14; columns += 1) expect(wrapText(text, columns)).toEqual(referenceWrap(text, columns));
  });

  test("matches the reference on every mixed sample", () => {
    for (const text of WIDTH_SAMPLES) {
      for (const columns of [1, 3, 8, 21]) expect(wrapText(text, columns)).toEqual(referenceWrap(text, columns));
    }
  });
});

describe("share", () => {
  test.each<[number[], number, number[]]>([
    [[10, 20], 100, [10, 20]],
    [[10, 20], 30, [10, 20]],
    [[10, 20], 20, [10, 10]],
    [[30, 4], 20, [16, 4]],
    [[30, 40], 21, [10, 11]],
    [[5, 5, 50], 30, [5, 5, 20]],
    [[10, 20], 0, [0, 0]],
    [[10, 20], -5, [0, 0]],
    [[], 10, []],
  ])("share(%p, %p) is %p", (wants, room, expected) => {
    expect(share(wants, room)).toEqual(expected);
  });
});

describe("arrange", () => {
  const seg = (name: string, priority: number, min: number) => ({ name, priority, min });
  const names = (kept: readonly { name: string }[]) => kept.map((one) => one.name);

  test("keeps every segment that fits, in order", () => {
    expect(names(arrange([seg("a", 1, 5), seg("b", 3, 5), seg("c", 2, 5)], 21, 3))).toEqual(["a", "b", "c"]);
  });

  test("drops the largest priority number first, then the next, keeping the order of the rest", () => {
    const segments = [seg("a", 1, 5), seg("b", 3, 5), seg("c", 2, 5)];
    expect(names(arrange(segments, 20, 3))).toEqual(["a", "c"]);
    expect(names(arrange(segments, 12, 3))).toEqual(["a"]);
  });

  test("on a tie the later segment goes, and the last one stands whatever its size", () => {
    expect(names(arrange([seg("a", 2, 5), seg("b", 2, 5)], 9, 1))).toEqual(["a"]);
    expect(names(arrange([seg("a", 1, 50)], 10, 3))).toEqual(["a"]);
    expect(arrange([], 10, 3)).toEqual([]);
  });
});

test("oneLine folds whitespace and control characters into single spaces", () => {
  expect(oneLine("  a\n\tb\u0007c  ")).toBe("a b c");
});
