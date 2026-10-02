import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { coveredCodepoints } from "../cmap.ts";
import { SOURCES, textOf, verified } from "./subset.ts";

const TOTAL_BUDGET_BYTES = 100_000;

describe("textOf", () => {
  test("lists every codepoint of every range in order", () => {
    expect(textOf([[0x41, 0x43], [0x2514, 0x2514]])).toBe("ABC└");
  });
});

describe("verified", () => {
  const source = { file: "x.ttf", url: "https://example.invalid/x.ttf", sha256: createHash("sha256").update("font").digest("hex"), ranges: [] };

  test("returns the bytes when the hash matches", () => {
    expect(verified(new TextEncoder().encode("font"), source).toString()).toBe("font");
  });

  test("names the url and both hashes when it does not", () => {
    expect(() => verified(new TextEncoder().encode("other"), source)).toThrow(/example\.invalid\/x\.ttf has sha256 [0-9a-f]{64}, expected [0-9a-f]{64}/);
  });
});

describe("the committed subsets", () => {
  const covered = (file: string) => coveredCodepoints(readFileSync(join(import.meta.dir, file)));

  test("keep the footprint small", () => {
    const total = SOURCES.reduce((sum, { file }) => sum + statSync(join(import.meta.dir, file)).size, 0);
    expect(total).toBeLessThan(TOTAL_BUDGET_BYTES);
  });

  test("cover the ranges they were cut to", () => {
    const regular = covered("JetBrainsMono-Regular.ttf");
    for (const code of [0x20, 0x7e, 0xe9, 0x2192, 0x2502, 0x2588, 0x25cf]) expect(regular.has(code)).toBe(true);
    const symbols = covered("NotoSansSymbols2-Regular.ttf");
    for (const code of [0x23f8, 0x25d0, 0x2610, 0x273b]) expect(symbols.has(code)).toBe(true);
  });

  test("carry no codepoint outside their ranges", () => {
    const regular = covered("JetBrainsMono-Regular.ttf");
    expect(regular.has(0x65e5)).toBe(false);
    expect(regular.has(0x2800)).toBe(false);
  });
});
