#!/usr/bin/env bun
// Rebuilds the committed font subsets: downloads each upstream font from its pinned URL, checks
// the sha256, and keeps the Unicode ranges the README images can draw. When the renderer reports
// a codepoint no embedded font covers, widen the range here and run this again.
//
// Usage: bun scripts/docs/fonts/subset.ts
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import subsetFont from "subset-font";

type Range = readonly [first: number, last: number];

export type Source = { file: string; url: string; sha256: string; ranges: readonly Range[] };

const BASIC_LATIN: Range = [0x20, 0x7e];
const LATIN_1: Range = [0xa0, 0xff];
const GENERAL_PUNCTUATION: Range = [0x2000, 0x206f];
const ARROWS: Range = [0x2190, 0x21ff];
const MISC_TECHNICAL: Range = [0x2300, 0x23ff];
const BOX_DRAWING: Range = [0x2500, 0x257f];
const BLOCK_ELEMENTS: Range = [0x2580, 0x259f];
const GEOMETRIC_SHAPES: Range = [0x25a0, 0x25ff];
const MISC_SYMBOLS_HEAD: Range = [0x2600, 0x2617];
const CHECKS_AND_CROSSES: Range = [0x2713, 0x2718];
const STARS_AND_ASTERISKS: Range = [0x2730, 0x2747];
const ANGLE_BRACKETS: Range = [0x276e, 0x2771];

const JETBRAINS_MONO = "https://raw.githubusercontent.com/JetBrains/JetBrainsMono/v2.304/fonts/ttf";
const JETBRAINS_RANGES = [BASIC_LATIN, LATIN_1, GENERAL_PUNCTUATION, ARROWS, BOX_DRAWING, BLOCK_ELEMENTS, GEOMETRIC_SHAPES] as const;

export const SOURCES: readonly Source[] = [
  {
    file: "JetBrainsMono-Regular.ttf",
    url: `${JETBRAINS_MONO}/JetBrainsMono-Regular.ttf`,
    sha256: "a0bf60ef0f83c5ed4d7a75d45838548b1f6873372dfac88f71804491898d138f",
    ranges: JETBRAINS_RANGES,
  },
  {
    file: "JetBrainsMono-Bold.ttf",
    url: `${JETBRAINS_MONO}/JetBrainsMono-Bold.ttf`,
    sha256: "5590990c82e097397517f275f430af4546e1c45cff408bde4255dad142479dcb",
    ranges: JETBRAINS_RANGES,
  },
  {
    file: "NotoSansSymbols2-Regular.ttf",
    url: "https://raw.githubusercontent.com/notofonts/notofonts.github.io/e3ff34c3178cb4012124c9e6390b9a3535ff2c3f/fonts/NotoSansSymbols2/hinted/ttf/NotoSansSymbols2-Regular.ttf",
    sha256: "c4a0a80f0041ce4be81e2478faad22776d23edb98ae3f0d19bd37044820ecf9d",
    ranges: [MISC_TECHNICAL, GEOMETRIC_SHAPES, MISC_SYMBOLS_HEAD, CHECKS_AND_CROSSES, STARS_AND_ASTERISKS, ANGLE_BRACKETS],
  },
];

const COPYRIGHT_NAME_ID = 0;
const LICENSE_NAME_ID = 13;
const LICENSE_URL_NAME_ID = 14;

export function textOf(ranges: readonly Range[]): string {
  return ranges.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, offset) => String.fromCodePoint(first + offset))).join("");
}

export function verified(bytes: Uint8Array, source: Source): Buffer {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== source.sha256) throw new Error(`${source.url} has sha256 ${actual}, expected ${source.sha256}`);
  return Buffer.from(bytes);
}

export async function subsetOf(font: Buffer, ranges: readonly Range[]): Promise<Buffer> {
  return subsetFont(font, textOf(ranges), {
    targetFormat: "sfnt",
    keepFeatures: [],
    noHinting: true,
    noLayoutClosure: true,
    preserveNameIds: [COPYRIGHT_NAME_ID, LICENSE_NAME_ID, LICENSE_URL_NAME_ID],
  });
}

if (import.meta.main) {
  for (const source of SOURCES) {
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`${source.url}: HTTP ${response.status}`);
    const subset = await subsetOf(verified(new Uint8Array(await response.arrayBuffer()), source), source.ranges);
    writeFileSync(join(import.meta.dir, source.file), subset);
    console.log(`${source.file} ${subset.length} bytes`);
  }
}
