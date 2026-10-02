import { describe, expect, test } from "bun:test";
import { FOOTER_WIDTH, footerLine } from "./footer.ts";
import { displayWidth, glyphs } from "./ui-kit.ts";

const U = glyphs(false);
const A = glyphs(true);
const FULL = { durationMs: 4_200, tokens: { input: 12_345, output: 845 }, costUsd: 0.0312, unlogged: "just test" };

describe("footerLine", () => {
  test("joins duration, tokens and the engine's cost with the shared dot", () => {
    expect(footerLine({ ...FULL, unlogged: null }, U)).toBe("4s · 12.3k in 845 out · $0.0312 engine cost");
  });

  test("an unlogged verification takes the cost's place", () => {
    expect(footerLine(FULL, U)).toBe("4s · 12.3k in 845 out · ! no evidence: just test");
  });

  test("leaves out each part it has no figure for", () => {
    expect(footerLine({ ...FULL, costUsd: null, unlogged: null }, U)).toBe("4s · 12.3k in 845 out");
    expect(footerLine({ durationMs: 66_000, tokens: null, costUsd: null, unlogged: null }, U)).toBe("1m06s");
  });

  test("a dollar or more keeps cents", () => {
    expect(footerLine({ ...FULL, costUsd: 1.234, unlogged: null }, U)).toBe("4s · 12.3k in 845 out · $1.23 engine cost");
  });

  test("draws the ASCII set when asked", () => {
    expect(footerLine(FULL, A)).toBe("4s - 12.3k in 845 out - ! no evidence: just test");
  });

  test("a long or multi-line command is folded to one line and cut from the end to the footer width", () => {
    const command = `bun test src servers statusline scripts opencode \\\n  --timeout 60000 --bail`;
    expect(FOOTER_WIDTH).toBe(51);
    const line = footerLine({ ...FULL, unlogged: command }, U);
    expect(line).toBe("4s · 12.3k in 845 out · ! no evidence: bun test sr…");
    expect(displayWidth(line)).toBe(FOOTER_WIDTH);
    expect(footerLine({ ...FULL, unlogged: command }, A)).toBe("4s - 12.3k in 845 out - ! no evidence: bun test...");
  });
});
