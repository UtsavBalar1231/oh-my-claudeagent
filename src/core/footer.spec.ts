import { describe, expect, test } from "bun:test";
import { FOOTER_WIDTH, footerLine } from "./footer.ts";
import { displayWidth, glyphs } from "./ui-kit.ts";

const U = glyphs("unicode");
const A = glyphs("ascii");
const B = "\u00a0";
const FULL = { durationMs: 4_200, tokens: { input: 12_345, output: 845 }, costUsd: 0.0312, unlogged: "just test" };

describe("footerLine", () => {
  test("joins duration, tokens and the engine's cost with the shared dot", () => {
    expect(footerLine({ ...FULL, unlogged: null }, U)).toBe(`4s · 12.3k${B}in${B}845${B}out · $0.0312${B}engine${B}cost`);
  });

  test("an unlogged verification takes the cost's place", () => {
    expect(footerLine(FULL, U)).toBe(`4s · 12.3k${B}in${B}845${B}out · !${B}no${B}evidence:${B}just${B}test`);
  });

  test("leaves out each part it has no figure for", () => {
    expect(footerLine({ ...FULL, costUsd: null, unlogged: null }, U)).toBe(`4s · 12.3k${B}in${B}845${B}out`);
    expect(footerLine({ durationMs: 66_000, tokens: null, costUsd: null, unlogged: null }, U)).toBe("1m06s");
  });

  test("a dollar or more keeps cents", () => {
    expect(footerLine({ ...FULL, costUsd: 1.234, unlogged: null }, U)).toBe(`4s · 12.3k${B}in${B}845${B}out · $1.23${B}engine${B}cost`);
  });

  test("breaks only between units: every space inside one is a no-break space", () => {
    const line = footerLine(FULL, U);
    expect(line.split(" ")).toEqual(["4s", "·", `12.3k${B}in${B}845${B}out`, "·", `!${B}no${B}evidence:${B}just${B}test`]);
    expect(footerLine({ ...FULL, unlogged: null }, U).split(" ")).toEqual(["4s", "·", `12.3k${B}in${B}845${B}out`, "·", `$0.0312${B}engine${B}cost`]);
  });

  test("draws the ASCII set when asked", () => {
    expect(footerLine(FULL, A)).toBe(`4s - 12.3k${B}in${B}845${B}out - !${B}no${B}evidence:${B}just${B}test`);
  });

  test("a long or multi-line command is folded to one line and cut from the end to the footer width", () => {
    const command = `bun test src servers statusline scripts opencode \\\n  --timeout 60000 --bail`;
    expect(FOOTER_WIDTH).toBe(51);
    const line = footerLine({ ...FULL, unlogged: command }, U);
    expect(line).toBe(`4s · 12.3k${B}in${B}845${B}out · !${B}no${B}evidence:${B}bun${B}test${B}sr…`);
    expect(displayWidth(line)).toBe(FOOTER_WIDTH);
    expect(footerLine({ ...FULL, unlogged: command }, A)).toBe(`4s - 12.3k${B}in${B}845${B}out - !${B}no${B}evidence:${B}bun${B}test...`);
  });
});
