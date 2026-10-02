import { createHash } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Fonts, loadFonts, renderDirectory, renderSvg } from "./render-svg.ts";

const E = "\x1b[";
let fonts: Fonts;

beforeAll(() => {
  fonts = loadFonts();
});

const render = (ans: string) => renderSvg(ans, fonts);
const texts = (svg: string): string[] => [...svg.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((match) => match[1] ?? "");
const rects = (svg: string): string[] => [...svg.matchAll(/<rect (?!width="100%")[^>]*\/>/g)].map((match) => match[0]).filter((rect) => rect.includes('y="'));
const textTag = (svg: string, content: string): string => svg.match(new RegExp(`<text [^>]*>${content}</text>`))?.[0] ?? "";

describe("SGR attributes", () => {
  test("bold uses the bold face", async () => {
    const svg = await render(`${E}1mbold${E}0m plain`);
    expect(textTag(svg, "bold")).toContain('font-weight="700"');
    expect(textTag(svg, "plain")).not.toContain("font-weight");
    expect(svg.match(/font-weight:700/g)).toHaveLength(1);
  });

  test("dim lowers the opacity", async () => {
    expect(textTag(await render(`${E}2mdim`), "dim")).toContain('opacity="0.6"');
  });

  test("italic sets the style", async () => {
    expect(textTag(await render(`${E}3mslant`), "slant")).toContain('font-style="italic"');
  });

  test("underline and strikethrough decorate the text, alone or together", async () => {
    const svg = await render(`${E}4mu${E}0m ${E}9ms${E}0m ${E}4;9mus`);
    expect(textTag(svg, "u")).toContain('text-decoration="underline"');
    expect(textTag(svg, "s")).toContain('text-decoration="line-through"');
    expect(textTag(svg, "us")).toContain('text-decoration="underline line-through"');
  });

  test("reverse swaps the colors: a rect in the foreground color and text in the background color", async () => {
    const svg = await render(`${E}7;31;44mrv`);
    expect(rects(svg)).toEqual(['<rect x="16" y="16" width="18" height="20" fill="#ff7b72"/>']);
    expect(textTag(svg, "rv")).toContain('fill="#58a6ff"');
  });

  test("reverse with default colors uses the theme pair", async () => {
    const svg = await render(`${E}7mx`);
    expect(rects(svg)[0]).toContain('fill="#c9d1d9"');
    expect(textTag(svg, "x")).toContain('fill="#0d1117"');
  });

  test.each([
    [`${E}31mx`, "#ff7b72"],
    [`${E}92mx`, "#56d364"],
    [`${E}38;5;196mx`, "#ff0000"],
    [`${E}38;5;244mx`, "#808080"],
    [`${E}38;2;18;52;86mx`, "#123456"],
  ])("maps the foreground in %j to %s", async (ans, color) => {
    expect(textTag(await render(ans), "x")).toContain(`fill="${color}"`);
  });

  test("a background becomes a rect and a reset removes it", async () => {
    const svg = await render(`${E}42;48;5;21mab${E}49mcd`);
    expect(rects(svg)).toEqual(['<rect x="16" y="16" width="18" height="20" fill="#0000ff"/>']);
  });

  test("a foreground reset returns to the theme color, which needs no attribute", async () => {
    const svg = await render(`${E}31ma${E}39m b`);
    expect(textTag(svg, "a")).toContain("fill=");
    expect(texts(svg)).toEqual(["a", "b"]);
    expect(textTag(svg, "b")).not.toContain("fill=");
  });
});

describe("layout", () => {
  test("a wide emoji takes two cells and moves the next glyph two cells over", async () => {
    const svg = await render("a⌚b");
    expect(textTag(svg, "⌚")).toContain('x="25"');
    expect(textTag(svg, "⌚")).toContain('textLength="18"');
    expect(textTag(svg, "b")).toContain('x="43"');
  });

  test("box drawing characters are plain cells in their row's run", async () => {
    const svg = await render("┌──┐\n│  │\n└──┘");
    expect(texts(svg)).toEqual(["┌──┐", "│  │", "└──┘"]);
    expect(svg).toContain('height="92"');
  });

  test("a same-style run is one text element pinned to the grid", async () => {
    const tag = textTag(await render("hello world"), "hello world");
    expect(tag).toContain('x="16"');
    expect(tag).toContain('textLength="99"');
    expect(tag).toContain('lengthAdjust="spacing"');
    expect(tag).toContain('xml:space="preserve"');
  });

  test("adjacent cells with the same background merge into one rect", async () => {
    expect(rects(await render(`${E}41m     ${E}0m`))).toEqual(['<rect x="16" y="16" width="45" height="20" fill="#ff7b72"/>']);
  });

  test("trailing blanks with a background are drawn as part of the row's rect", async () => {
    const svg = await render(`${E}48;5;235mab    ${E}0m\nlonger line`);
    expect(rects(svg)).toEqual(['<rect x="16" y="16" width="54" height="20" fill="#262626"/>']);
  });

  test("trailing blank rows are cropped and blank rows in the middle are kept", async () => {
    const svg = await render("a\n\nb\n   \n\n");
    expect(svg).toContain('height="92"');
    expect(texts(svg)).toEqual(["a", "b"]);
  });

  test("sizes the image from the widest row and rounds the corners", async () => {
    const svg = await render("abcd\nab");
    expect(svg).toContain('width="68" height="72"');
    expect(svg).toContain('rx="8"');
  });
});

describe("fonts", () => {
  test("embeds the bold face and the symbol face only when a glyph needs them", async () => {
    const plain = await render("abc");
    const full = await render(`${E}1mabc${E}0m x ⏸`);
    expect(plain.match(/@font-face/g)).toHaveLength(1);
    expect(full.match(/@font-face/g)).toHaveLength(3);
  });

  test("keeps only the glyphs the image uses", async () => {
    const small = (await render("a")).length;
    const large = (await render("abcdefghijklmnopqrstuvwxyz")).length;
    expect(large).toBeGreaterThan(small);
    expect(small).toBeLessThan(6_000);
  });

  test("replaces ⎿ with └ because no embedded font has it", async () => {
    const svg = await render("⎿  Backgrounded");
    expect(svg).toContain("└");
    expect(svg).not.toContain("⎿");
  });

  test("treats a no-break space as a space", async () => {
    expect(texts(await render("a b"))).toEqual(["a b"]);
  });

  test("fails and names the codepoint no embedded font covers", async () => {
    await expect(render("ok \u{1f980}")).rejects.toThrow("U+1F980");
    await expect(render("日本語")).rejects.toThrow(/U\+65E5.*U\+672C.*U\+8A9E/);
  });
});

describe("determinism", () => {
  const ans = `${E}1;38;5;174mhead${E}0m ⏸ ${E}7mrev${E}0m\n${E}48;2;1;2;3m  ${E}0m ⎿ end\n`;

  test("the same input gives the same bytes", async () => {
    const [a, b] = [await render(ans), await render(ans)];
    expect(createHash("sha256").update(a).digest("hex")).toBe(createHash("sha256").update(b).digest("hex"));
  });
});

describe("renderDirectory", () => {
  test("renders every .ans file, reports a failure by file, and writes nothing for it", async () => {
    const root = mkdtempSync(join(tmpdir(), "omca-render-spec-"));
    try {
      const source = join(root, "src");
      const output = join(root, "out");
      mkdirSync(source);
      writeFileSync(join(source, "good.ans"), "ok\n");
      writeFileSync(join(source, "bad.ans"), "\u{1f980}\n");
      writeFileSync(join(source, "notes.txt"), "ignored");

      const { written, failures } = await renderDirectory(source, output);

      expect(written).toEqual([join(output, "good.svg")]);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("bad.ans");
      expect(failures[0]).toContain("U+1F980");
      expect(readFileSync(join(output, "good.svg"), "utf8")).toStartWith("<svg ");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
