import { describe, expect, test } from "bun:test";
import {
  displayWidth,
  fitEnd,
  fitMiddle,
  formatDuration,
  formatTokens,
  formatWhen,
  glyphs,
  isAsciiRequested,
  keyHint,
  levelMark,
  notice,
  padEnd,
  padStart,
  shortType,
  usableColumns,
} from "./ui-kit.ts";

const E = glyphs(false).ellipsis;

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
  test.each([
    [undefined, false],
    ["", false],
    ["0", false],
    ["false", false],
    ["1", true],
    ["true", true],
    [" YES ", true],
    ["on", true],
  ])("OMCA_ASCII=%p selects ASCII: %p", (value, expected) => {
    expect(isAsciiRequested(value)).toBe(expected);
  });

  test("the ASCII set replaces every non-ASCII glyph and keeps each status glyph one cell wide", () => {
    const unicode = glyphs(false);
    const ascii = glyphs(true);
    expect(Object.keys(ascii)).toEqual(Object.keys(unicode));
    for (const [name, glyph] of Object.entries(ascii)) {
      expect({ name, ascii: /^[\x20-\x7e]+$/.test(glyph) }).toEqual({ name, ascii: true });
    }
    for (const name of ["pointer", "check", "cross", "warn", "running", "pending", "up", "down", "dot", "rule"] as const) {
      expect({ name, unicode: displayWidth(unicode[name]), ascii: ascii[name].length }).toEqual({ name, unicode: 1, ascii: 1 });
    }
    expect(fitEnd("hello world", 6, ascii.ellipsis)).toBe("hel...");
  });

  test("level marks pair one glyph with one theme color", () => {
    const g = glyphs(true);
    expect(levelMark("ok", g)).toEqual({ glyph: "+", color: "success" });
    expect(levelMark("warn", g)).toEqual({ glyph: "!", color: "warning" });
    expect(levelMark("fail", g)).toEqual({ glyph: "x", color: "error" });
    expect(levelMark("info", g)).toEqual({ glyph: "-", color: "inactive" });
  });
});

describe("keys and layout", () => {
  test("a key hint joins each key and label with the shared separator", () => {
    const pairs = [["n", "next"], ["p", "prev"], ["esc", "back"]] as const;
    expect(keyHint(pairs, glyphs(false))).toBe("n next · p prev · esc back");
    expect(keyHint(pairs, glyphs(true))).toBe("n next - p prev - esc back");
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

describe("notices", () => {
  test("each non-populated state draws one fitted line in its own color", () => {
    const words = { loading: "Reading the plan", empty: "No plan is bound to this session." };
    const g = glyphs(false);
    expect(notice({ kind: "loading" }, words, g, 40)).toEqual({ text: "Reading the plan…", color: "inactive", isDim: true });
    expect(notice({ kind: "empty" }, words, g, 20)).toEqual({ text: "No plan is bound to…", color: "inactive", isDim: true });
    expect(notice({ kind: "error", reason: "ENOENT: plan.md" }, words, g, 12)).toEqual({
      text: "✗ ENOENT: p…",
      color: "error",
      isDim: false,
    });
    expect(notice({ kind: "error", reason: "ENOENT" }, words, glyphs(true), 40).text).toBe("x ENOENT");
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
    [129_000, "129k"],
    [999_499, "999k"],
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
  expect(shortType("explore")).toBe("explore");
});
