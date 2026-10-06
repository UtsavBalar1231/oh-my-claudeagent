import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";
import { displayWidth, glyphs } from "./ui-kit.ts";
import {
  AGENT_KEYS,
  agentKey,
  bar,
  CHIP_TONES,
  chip,
  DRAWN_PAIRS,
  fitPieces,
  isValidDiff,
  levelMark,
  notice,
  type Piece,
  redact,
  ROSTER,
  rule,
  spark,
  stack,
  THEME_KEYS,
  type ThemeKey,
  themeKey,
  TONE_KEYS,
  widthTier,
} from "./visual.ts";

const AGENTS = join(import.meta.dir, "..", "..", "agents");
const U = glyphs("unicode");
const A = glyphs("ascii");
const cellsOf = (pieces: readonly Piece[]) => pieces.reduce((sum, piece) => sum + displayWidth(piece.text), 0);

describe("palette", () => {
  test("holds only keys that draw for a mod, once each", () => {
    expect(new Set(THEME_KEYS).size).toBe(THEME_KEYS.length);
    for (const silent of ["link", "thinking", "messageActionsBackground"]) expect(THEME_KEYS).not.toContain(silent);
    for (const key of [...Object.values(TONE_KEYS), ...Object.values(AGENT_KEYS)]) expect(THEME_KEYS).toContain(key);
  });

  test("a tone resolves to its key and a key passes through", () => {
    expect(TONE_KEYS).toEqual({
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
      track: "subtle",
    });
    expect(themeKey("fail")).toBe("error");
    expect(themeKey("error")).toBe("error");
    expect(themeKey("diffAdded")).toBe("diffAdded");
  });

  test("the roster colors match each agent's frontmatter", () => {
    const colors: Record<string, unknown> = Object.fromEntries(
      readdirSync(AGENTS)
        .filter((file) => file.endsWith(".md"))
        .map((file) => [file.slice(0, -".md".length), parseFrontmatter(readFileSync(join(AGENTS, file), "utf8"))?.["color"]]),
    );
    expect(colors).toEqual({ ...ROSTER });
  });

  test("an agent draws in its roster color, an unknown one muted", () => {
    expect(agentKey("oh-my-claudeagent:executor")).toBe("green_FOR_SUBAGENTS_ONLY");
    expect(agentKey("reviewer")).toBe("red_FOR_SUBAGENTS_ONLY");
    expect(agentKey("general-purpose")).toBe("inactive");
    expect(agentKey("constructor")).toBe("inactive");
  });

  test("level marks pair one glyph with one theme key", () => {
    expect(levelMark("ok", A)).toEqual({ glyph: "+", color: "success" });
    expect(levelMark("warn", A)).toEqual({ glyph: "!", color: "warning" });
    expect(levelMark("fail", A)).toEqual({ glyph: "x", color: "error" });
    expect(levelMark("info", A)).toEqual({ glyph: "i", color: "inactive" });
  });

  test("each non-populated state draws one fitted line in its own key", () => {
    const words = { loading: "Reading the plan", empty: "No plan is bound to this session." };
    expect(notice({ kind: "loading" }, words, U, 40)).toEqual({ text: "Reading the plan…", color: "inactive", isDim: true });
    expect(notice({ kind: "empty" }, words, U, 20)).toEqual({ text: "No plan is bound to…", color: "inactive", isDim: true });
    expect(notice({ kind: "error", reason: "ENOENT: plan.md" }, words, U, 12)).toEqual({
      text: "✗ ENOENT: p…",
      color: "error",
      isDim: false,
    });
    expect(notice({ kind: "error", reason: "ENOENT" }, words, A, 40).text).toBe("x ENOENT");
  });
});

describe("chip", () => {
  test("is bold inverse text on a solid tone, padded in Unicode and bracketed in ASCII", () => {
    expect(chip("PROVEN", "ok", false)).toEqual({ text: " PROVEN ", color: "inverseText", backgroundColor: "success", bold: true });
    expect(chip("exit 1", "fail", true)).toEqual({ text: "[exit 1]", color: "inverseText", backgroundColor: "error", bold: true });
    expect(chip("A VERY LONG LABEL", "warn", false).text).toBe(" A VERY LONG… ");
    expect(chip("A VERY LONG LABEL", "warn", true).text).toBe("[A VERY LO...]");
  });
});

describe("bar", () => {
  test("seams segments with eighth blocks, the left color over the right", () => {
    expect(bar({ done: 59, active: 2, failed: 1, todo: 6 }, 10, false)).toEqual([
      { text: "████████", color: "success" },
      { text: "▊", color: "success", backgroundColor: "claude" },
      { text: "▏", color: "error", backgroundColor: "subtle" },
    ]);
    expect(bar({ done: 3, todo: 4 }, 8, false)).toEqual([
      { text: "███", color: "success" },
      { text: "▍", color: "success", backgroundColor: "subtle" },
      { text: "████", color: "subtle" },
    ]);
  });

  test("draws an empty plan as all track and a zero width as nothing", () => {
    expect(bar({ done: 0, todo: 0 }, 4, false)).toEqual([{ text: "████", color: "subtle" }]);
    expect(bar({ done: 3, todo: 1 }, 0, false)).toEqual([]);
  });

  test("ASCII is bracketed, one character per segment, and a non-zero segment keeps a cell", () => {
    expect(bar({ done: 59, active: 2, failed: 1, todo: 6 }, 12, true)).toEqual([
      { text: "[" },
      { text: "#######", color: "success" },
      { text: "=", color: "claude" },
      { text: "x", color: "error" },
      { text: ".", color: "subtle" },
      { text: "]" },
    ]);
    expect(bar({ done: 4, todo: 4 }, 2, true)).toEqual([
      { text: "#", color: "success" },
      { text: ".", color: "subtle" },
    ]);
  });

  test("is exactly its width for every split", () => {
    for (const ascii of [false, true]) {
      for (let width = 0; width <= 30; width += 1) {
        for (const parts of [{ done: 0, todo: 0 }, { done: 1, active: 1, failed: 1, todo: 100 }, { done: 68, todo: 0 }, { done: 7, active: 3, todo: 2 }]) {
          expect({ ascii, width, parts, cells: cellsOf(bar(parts, width, ascii)) }).toEqual({ ascii, width, parts, cells: width });
        }
      }
    }
  });
});

describe("fitPieces", () => {
  const a: Piece = { text: "abc", color: "success" };
  const b: Piece = { text: "def", color: "error" };

  test("keeps pieces that fit and cuts the one crossing the edge with an ellipsis", () => {
    expect(fitPieces([a, b], 6, "…")).toEqual([a, b]);
    expect(fitPieces([a, b], 5, "…")).toEqual([a, { text: "d…", color: "error" }]);
    expect(fitPieces([a, b], 3, "…")).toEqual([{ text: "ab…", color: "success" }]);
    expect(fitPieces([a, b], 4, "...")).toEqual([a, { text: ".", color: "error" }]);
    expect(fitPieces([a, b], 0, "…")).toEqual([]);
  });

  test("never exceeds its width", () => {
    for (let width = 0; width <= 8; width += 1) expect(cellsOf(fitPieces([a, chip("WARN", "warn", false), b], width, "…"))).toBeLessThanOrEqual(width);
  });
});

describe("stack", () => {
  const green = { color: "green_FOR_SUBAGENTS_ONLY", ascii: "#" } as const;
  const blue = { color: "blue_FOR_SUBAGENTS_ONLY", ascii: "=" } as const;
  const track = { color: "subtle", ascii: "." } as const;

  test("shares whole cells by value, each segment one run in its own key", () => {
    expect(stack([{ ...green, value: 3 }, { ...blue, value: 1 }], 8, false)).toEqual([
      { text: "██████", color: "green_FOR_SUBAGENTS_ONLY" },
      { text: "██", color: "blue_FOR_SUBAGENTS_ONLY" },
    ]);
    expect(stack([{ ...green, value: 1 }, { ...track, value: 99 }], 10, false)).toEqual([
      { text: "█", color: "green_FOR_SUBAGENTS_ONLY" },
      { text: "█████████", color: "subtle" },
    ]);
  });

  test("ASCII is bracketed in each segment's own character, and a zero width is nothing", () => {
    expect(stack([{ ...green, value: 2 }, { ...blue, value: 0 }, { ...track, value: 2 }], 6, true)).toEqual([
      { text: "[" },
      { text: "##", color: "green_FOR_SUBAGENTS_ONLY" },
      { text: "..", color: "subtle" },
      { text: "]" },
    ]);
    expect(stack([{ ...green, value: 2 }], 0, false)).toEqual([]);
  });

  test("is exactly its width for every split", () => {
    for (const ascii of [false, true]) {
      for (let width = 0; width <= 20; width += 1) {
        for (const values of [[0, 0], [5, 0, 1], [1, 1, 1, 100]]) {
          const pieces = stack(values.map((value) => ({ ...green, value })), width, ascii);
          expect({ ascii, width, values, cells: cellsOf(pieces) }).toEqual({ ascii, width, values, cells: width });
        }
      }
    }
  });
});

describe("spark", () => {
  test("a spark scales from zero to the largest value", () => {
    expect(spark([0, 1, 2, 4, 8], false)).toBe("▁▂▃▅█");
    expect(spark([0, 1, 2, 4, 8], true)).toBe(".:-+@");
    expect(spark([0, 0], false)).toBe("▁▁");
    expect(spark([], false)).toBe("");
  });
});

describe("rule", () => {
  const line = (text: string): Piece => ({ text, color: "subtle" });
  const label = (text: string): Piece => ({ text, color: "text", bold: true });

  test("carries a label, a mini bar and its tally when they fit", () => {
    expect(rule(40, U, false, "Milestone 5b", { done: 6, total: 7 })).toEqual([
      line("──"),
      { text: " " },
      label("Milestone 5b"),
      { text: " " },
      line("──"),
      { text: " " },
      { text: "██████", color: "success" },
      { text: "▉", color: "success", backgroundColor: "subtle" },
      { text: "█", color: "subtle" },
      { text: " 6/7 " },
      line("────────"),
    ]);
  });

  test("drops the mini bar, then the tally, then shortens the label as the width shrinks", () => {
    expect(rule(24, U, false, "Milestone 5b", { done: 6, total: 7 })).toEqual([
      line("──"),
      { text: " " },
      label("Milestone 5b"),
      { text: " " },
      line("──"),
      { text: " 6/7 " },
      line("─"),
    ]);
    expect(rule(16, U, false, "Milestone 5b", { done: 6, total: 7 })).toEqual([line("──"), { text: " " }, label("Milestone 5b"), { text: " " }]);
    expect(rule(10, U, false, "Milestone 5b")).toEqual([line("──"), { text: " " }, label("Miles…"), { text: " " }]);
    expect(rule(3, U, false, "Plan", { done: 1, total: 2 })).toEqual([line("───")]);
  });

  test("without a label it is a plain line, or the tally alone", () => {
    expect(rule(10, U, false)).toEqual([line("──────────")]);
    expect(rule(12, A, true, "", { done: 3, total: 4 })).toEqual([line("--"), { text: " 3/4 " }, line("-----")]);
  });

  test("is exactly its width", () => {
    for (let width = 0; width <= 50; width += 1) {
      for (const [name, tally] of [["", undefined], ["Milestone 5b", { done: 6, total: 7 }], ["日本語のマイルストーン", { done: 0, total: 3 }]] as const) {
        expect({ width, name, cells: cellsOf(rule(width, U, false, name, tally)) }).toEqual({ width, name, cells: width });
      }
    }
  });
});

test("width tiers: pages below 56 body columns, inline expansion from 56, master and detail from 90", () => {
  expect([0, 55, 56, 89, 90, 200].map(widthTier)).toEqual(["page", "page", "inline", "inline", "split", "split"]);
});

describe("isValidDiff", () => {
  test.each([
    ["@@ -1,3 +1,4 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n const d = 5;", true],
    ["--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n", true],
    ["@@ -1,2 +1,2 @@\n a\n-b\n+c\n\\ No newline at end of file\n@@ -10,1 +10,0 @@\n-z", true],
    ["@@ -1,4 +1,5 @@\n a\n-b\n+c", false],
    ["@@ -1,1 +1,1 @@\n-a\n+b\n+c", false],
    ["just text", false],
    ["", false],
    ["@@ -1,1 +1,1 @@\n?a", false],
  ])("%p is %p", (source, expected) => {
    expect(isValidDiff(source)).toBe(expected);
  });
});

describe("redact", () => {
  const HOME = "/home/u";
  test.each([
    ["export ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx", "export ANTHROPIC_API_KEY=‹masked›", 1],
    ["run sk-proj-AbCdEfGhIjKlMnOpQrStUvWx now", "run ‹masked› now", 1],
    ["git push https://ghp_0123456789abcdefghijABCDEFGHIJklmnopqr@github.com/x", "git push https://‹masked›@github.com/x", 1],
    ["token github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz", "token ‹masked›", 1],
    ["SLACK=xoxb-1234567890-abcdefghij", "SLACK=‹masked›", 1],
    ["aws AKIAIOSFODNN7EXAMPLE id", "aws ‹masked› id", 1],
    ["key=AIzaSyA-1234567890abcdefghijklmnopqrstu", "key=‹masked›", 1],
    [
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "jwt ‹masked›",
      1,
    ],
    ["curl -H 'Authorization: Bearer abcdef0123456789xyz' https://api", "curl -H 'Authorization: Bearer ‹masked›' https://api", 1],
    [
      "PASSWORD=hunter2 db_password='p a s' api_key=\"zz top\" secret = s3 passwd=x",
      "PASSWORD=‹masked› db_password=‹masked› api_key=‹masked› secret = ‹masked› passwd=‹masked›",
      5,
    ],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\nafter", "‹masked›\nafter", 1],
    ["cut off: -----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk", "cut off: ‹masked›", 1],
    ["secret=-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----", "secret=‹masked›", 1],
    ["token=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx", "token=‹masked›", 1],
    ["export `PAYMENTS_TOKEN=tok_4f9a2c7e1b8d6035` first", "export `PAYMENTS_TOKEN=‹masked›` first", 1],
  ])("masks %p", (text, expected, masked) => {
    expect(redact(text, HOME)).toEqual({ text: expected, masked });
  });

  test.each([
    "commit 71cc408e3f6c1d2b9a8e7f6d5c4b3a2918070605",
    "session 00000000-0000-4000-8000-000000000001",
    "/usr/local/bin/bun test src",
    "max_tokens=4096 --token-file creds",
    "task-abcdefghijklmnopqrstuvwxyz desk-12345678901234567890123",
    "a Bearer of bad news",
    "AKIAIOSFODNN7EXAMPLEX is too long",
  ])("leaves %p alone", (text) => {
    expect(redact(text, HOME)).toEqual({ text, masked: 0 });
  });

  test("shortens the home directory to ~ only where it is the whole path segment", () => {
    expect(redact("/home/u/dev/x and /home/user2/y and /home/u", HOME)).toEqual({ text: "~/dev/x and /home/user2/y and ~", masked: 0 });
    expect(redact("C:\\Users\\u\\proj", "C:\\Users\\u\\")).toEqual({ text: "~\\proj", masked: 0 });
    expect(redact("/home/u/x", "")).toEqual({ text: "/home/u/x", masked: 0 });
  });

  test("takes the ASCII mask", () => {
    expect(redact("PASSWORD=hunter2", HOME, A.mask)).toEqual({ text: "PASSWORD=<masked>", masked: 1 });
  });
});

describe("contrast", () => {
  // Drawn values measured on 2.1.288 under the maintainer's Wallpaper theme and the built-in light theme.
  const HEX: Record<"wallpaper" | "light", Partial<Record<ThemeKey, string>>> = {
    wallpaper: {
      text: "#dddbf1",
      inverseText: "#1d2021",
      success: "#b8bb26",
      error: "#fb4934",
      warning: "#fabd2f",
      claude: "#ebbcba",
      permission: "#ebbcba",
      planMode: "#8ec07c",
      inactive: "#848294",
      subtle: "#665c54",
      selectionBg: "#504945",
      userMessageBackground: "#1d2021",
      rate_limit_empty: "#3c3836",
    },
    light: {
      text: "#000000",
      inverseText: "#ffffff",
      success: "#2c7a39",
      error: "#ab2b3f",
      warning: "#966c1e",
      claude: "#d77757",
      permission: "#5769f7",
      planMode: "#006666",
      inactive: "#666666",
      subtle: "#afafaf",
      selectionBg: "#b4d5ff",
      userMessageBackground: "#f0f0f0",
      rate_limit_empty: "#272f6f",
    },
  };

  const luminance = (hex: string): number => {
    const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => {
      const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (fg: string, bg: string): number => {
    const [high, low] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
  };
  const round = (value: number) => Math.round(value * 10) / 10;

  test("the formula reproduces the lab's measured ratios", () => {
    const { wallpaper, light } = HEX;
    expect(round(ratio(wallpaper.inverseText ?? "", wallpaper.success ?? ""))).toBe(7.9);
    expect(round(ratio(light.inverseText ?? "", light.success ?? ""))).toBe(5.3);
    expect(round(ratio(light.inverseText ?? "", light.claude ?? ""))).toBe(3.2);
    expect(round(ratio(wallpaper.text ?? "", wallpaper.selectionBg ?? ""))).toBe(6.5);
    expect(round(ratio(light.text ?? "", light.selectionBg ?? ""))).toBe(13.9);
  });

  test("every key the components draw with is measured in both themes", () => {
    for (const key of [...Object.values(TONE_KEYS).filter((key) => key !== "claudeShimmer"), "text", "inverseText"] as const) {
      expect({ key, wallpaper: HEX.wallpaper[key] !== undefined, light: HEX.light[key] !== undefined }).toEqual({ key, wallpaper: true, light: true });
    }
  });

  test("every chip tone is a drawn pair, and a neutral chip is text on the raised surface", () => {
    for (const tone of [...CHIP_TONES, "neutral"] as const) {
      const { color, backgroundColor } = chip("X", tone, false);
      const isDrawn = DRAWN_PAIRS.some((pair) => pair.fg === color && pair.bg === backgroundColor);
      expect({ tone, isDrawn }).toEqual({ tone, isDrawn: true });
    }
    expect(chip("TEST", "neutral", false)).toEqual({ text: " TEST ", color: "text", backgroundColor: "userMessageBackground", bold: true });
  });

  test("a bar track is a quiet mark on the pane in both themes, never as loud as data", () => {
    const PANE = { wallpaper: "#262626", light: "#f5f5f5" } as const;
    for (const theme of ["wallpaper", "light"] as const) {
      const measured = round(ratio(HEX[theme][TONE_KEYS.track] ?? "", PANE[theme]));
      expect({ theme, isQuiet: measured >= 1.5 && measured <= 3 }).toEqual({ theme, isQuiet: true });
    }
  });

  test("every text-on-background pair the components draw reads in both themes", () => {
    for (const theme of ["wallpaper", "light"] as const) {
      for (const { fg, bg, isShortBold } of DRAWN_PAIRS) {
        const front = HEX[theme][fg];
        const back = HEX[theme][bg];
        const floor = isShortBold ? 3 : 4.5;
        const measured = front === undefined || back === undefined ? 0 : round(ratio(front, back));
        expect({ theme, fg, bg, passes: measured >= floor }).toEqual({ theme, fg, bg, passes: true });
      }
    }
  });
});
