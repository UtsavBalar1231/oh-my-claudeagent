#!/usr/bin/env bun
// Renders the ANSI captures in .github/assets/src/ to deterministic SVG images in .github/assets/.
//
// Usage: bun scripts/docs/render-svg.ts [--src <dir>] [--out <dir>]
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import subsetFont from "subset-font";
import { type Cell, colorPalette, type Color, PLAIN, parseAnsi, type Row, rowWidth, type Style } from "./ansi.ts";
import { coveredCodepoints } from "./cmap.ts";

const FONT_DIR = join(import.meta.dir, "fonts");
const ROOT = join(import.meta.dir, "..", "..");
const SOURCE_DIR = join(ROOT, ".github", "assets", "src");
const OUTPUT_DIR = join(ROOT, ".github", "assets");

const CELL_WIDTH = 9;
const LINE_HEIGHT = 20;
const FONT_SIZE = 15;
const BASELINE = 15;
const PADDING = 16;
const CORNER_RADIUS = 8;
const DIM_OPACITY = 0.6;

const THEME = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  ansi: [
    "#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4",
    "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f6fc",
  ],
} as const;

export const SUBSTITUTIONS: ReadonlyMap<string, string> = new Map([
  ["⎿", "└"],
  [" ", " "],
]);

export type Fonts = { regular: Buffer; bold: Buffer; symbols: Buffer };

export function loadFonts(dir: string = FONT_DIR): Fonts {
  return {
    regular: readFileSync(join(dir, "JetBrainsMono-Regular.ttf")),
    bold: readFileSync(join(dir, "JetBrainsMono-Bold.ttf")),
    symbols: readFileSync(join(dir, "NotoSansSymbols2-Regular.ttf")),
  };
}

const CUBE = [0, 95, 135, 175, 215, 255] as const;
const hex = (value: number): string => value.toString(16).padStart(2, "0");

function css(color: Color): string {
  const index = colorPalette(color);
  if (index === null) return color;
  if (index < 16) return THEME.ansi[index] ?? THEME.foreground;
  if (index >= 232) {
    const level = hex(8 + (index - 232) * 10);
    return `#${level}${level}${level}`;
  }
  const offset = index - 16;
  const [r, g, b] = [Math.floor(offset / 36), Math.floor(offset / 6) % 6, offset % 6].map((step) => hex(CUBE[step] ?? 0));
  return `#${r}${g}${b}`;
}

const escapeText = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const foreground = (style: Style): string => css(style.reverse ? (style.bg ?? THEME.background) : (style.fg ?? THEME.foreground));
const background = (style: Style): string | null => {
  const color = style.reverse ? (style.fg ?? THEME.foreground) : style.bg;
  return color === null ? null : css(color);
};

const substitute = (row: Row): Row => row.map((cell) => ({ ...cell, text: SUBSTITUTIONS.get(cell.text) ?? cell.text }));

const isBlank = (cell: Cell): boolean => cell.text === " " && background(cell.style) === null && !cell.style.underline && !cell.style.strike;

export function cropBlankRows(rows: readonly Row[]): Row[] {
  let end = rows.length;
  while (end > 1 && (rows[end - 1] ?? []).every(isBlank)) end -= 1;
  return rows.slice(0, end);
}

type Faces = { regular: Set<number>; symbols: Set<number> };

function missingCodepoints(rows: readonly Row[], faces: Faces): number[] {
  const missing = new Set<number>();
  for (const row of rows) {
    for (const cell of row) {
      for (const char of cell.text) {
        const code = char.codePointAt(0) ?? 0;
        if (code !== 0x20 && !faces.regular.has(code) && !faces.symbols.has(code)) missing.add(code);
      }
    }
  }
  return [...missing].sort((a, b) => a - b);
}

const label = (code: number): string => `U+${code.toString(16).toUpperCase().padStart(4, "0")} (${String.fromCodePoint(code)})`;

type Run = { column: number; cells: number; text: string; style: Style };

const sameText = (a: Style, b: Style): boolean =>
  foreground(a) === foreground(b) && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike;

function finish(run: Run): Run | null {
  const decorated = run.style.underline || run.style.strike;
  const lead = decorated ? 0 : run.text.length - run.text.trimStart().length;
  const trail = decorated ? 0 : run.text.length - run.text.trimEnd().length;
  const text = run.text.slice(lead, run.text.length - trail);
  if (text.trim() === "" && !decorated) return null;
  return { column: run.column + lead, cells: run.cells - lead - trail, text, style: run.style };
}

function textRuns(row: Row, faces: Faces): Run[] {
  const runs: Run[] = [];
  const push = (run: Run | null): void => {
    const done = run === null ? null : finish(run);
    if (done !== null) runs.push(done);
  };
  let column = 0;
  let open: Run | null = null;
  for (const cell of row) {
    const isMerged = cell.width === 1 && [...cell.text].every((char) => char === " " || faces.regular.has(char.codePointAt(0) ?? 0));
    if (isMerged && open !== null && sameText(open.style, cell.style)) {
      open.text += cell.text;
      open.cells += 1;
    } else {
      push(open);
      open = null;
      if (isMerged) open = { column, cells: 1, text: cell.text, style: cell.style };
      else if (cell.text !== " ") runs.push({ column, cells: cell.width, text: cell.text, style: cell.style });
    }
    column += cell.width;
  }
  push(open);
  return runs;
}

function backgroundRects(rows: readonly Row[]): string {
  let out = "";
  rows.forEach((row, y) => {
    let column = 0;
    for (let at = 0; at < row.length; ) {
      const color = background(row[at]?.style ?? PLAIN);
      let width = 0;
      let end = at;
      while (end < row.length && background(row[end]?.style ?? PLAIN) === color) {
        width += row[end]?.width ?? 1;
        end += 1;
      }
      if (color !== null) out += `<rect x="${PADDING + column * CELL_WIDTH}" y="${PADDING + y * LINE_HEIGHT}" width="${width * CELL_WIDTH}" height="${LINE_HEIGHT}" fill="${color}"/>`;
      column += width;
      at = end;
    }
  });
  return out;
}

function textElement(run: Run, y: number, isSymbol: boolean): string {
  const { style } = run;
  const attributes = [`x="${PADDING + run.column * CELL_WIDTH}"`, `y="${PADDING + y * LINE_HEIGHT + BASELINE}"`];
  const fill = foreground(style);
  if (fill !== THEME.foreground) attributes.push(`fill="${fill}"`);
  if (style.bold && !isSymbol) attributes.push('font-weight="700"');
  if (style.italic) attributes.push('font-style="italic"');
  if (style.dim) attributes.push(`opacity="${DIM_OPACITY}"`);
  const decorations = [style.underline ? "underline" : "", style.strike ? "line-through" : ""].filter((value) => value !== "");
  if (decorations.length > 0) attributes.push(`text-decoration="${decorations.join(" ")}"`);
  if (run.cells > 1) attributes.push(`textLength="${run.cells * CELL_WIDTH}"`, 'lengthAdjust="spacing"');
  attributes.push('xml:space="preserve"');
  return `<text ${attributes.join(" ")}>${escapeText(run.text)}</text>`;
}

const sorted = (chars: Iterable<string>): string => [...new Set(chars)].sort().join("");

async function face(family: string, weight: number, font: Buffer, chars: string): Promise<string> {
  if (chars === "") return "";
  const subset = await subsetFont(font, chars, { targetFormat: "woff2", keepFeatures: [], noHinting: true, noLayoutClosure: true });
  return `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${subset.toString("base64")}) format('woff2')}`;
}

export async function renderSvg(ans: string, fonts: Fonts = loadFonts()): Promise<string> {
  const rows = cropBlankRows(parseAnsi(ans).map(substitute));
  const faces: Faces = { regular: coveredCodepoints(fonts.regular), symbols: coveredCodepoints(fonts.symbols) };
  const missing = missingCodepoints(rows, faces);
  if (missing.length > 0) throw new Error(`no embedded font covers ${missing.map(label).join(", ")}`);

  const columns = Math.max(...rows.map(rowWidth));
  const width = columns * CELL_WIDTH + PADDING * 2;
  const height = rows.length * LINE_HEIGHT + PADDING * 2;

  const regularChars: string[] = [];
  const boldChars: string[] = [];
  const symbolChars: string[] = [];
  let body = "";
  rows.forEach((row, y) => {
    for (const run of textRuns(row, faces)) {
      const isSymbol = [...run.text].some((char) => !faces.regular.has(char.codePointAt(0) ?? 0) && char !== " ");
      const chars = isSymbol ? symbolChars : run.style.bold ? boldChars : regularChars;
      chars.push(...run.text);
      body += textElement(run, y, isSymbol);
    }
  });

  const styles = [
    await face("JetBrains Mono", 400, fonts.regular, sorted(regularChars)),
    await face("JetBrains Mono", 700, fonts.bold, sorted(boldChars)),
    await face("Noto Sans Symbols 2", 400, fonts.symbols, sorted(symbolChars)),
    `text{font-family:'JetBrains Mono','Noto Sans Symbols 2',monospace;font-size:${FONT_SIZE}px;white-space:pre;font-variant-ligatures:none}`,
  ].join("");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="${THEME.foreground}" xml:space="preserve" role="img">` +
    `<style>${styles}</style>` +
    `<rect width="${width}" height="${height}" rx="${CORNER_RADIUS}" fill="${THEME.background}"/>` +
    `${backgroundRects(rows)}${body}</svg>\n`
  );
}

export async function renderDirectory(source: string, output: string): Promise<{ written: string[]; failures: string[] }> {
  const fonts = loadFonts();
  const written: string[] = [];
  const failures: string[] = [];
  mkdirSync(output, { recursive: true });
  for (const file of readdirSync(source).filter((name) => name.endsWith(".ans")).sort()) {
    const target = join(output, `${basename(file, ".ans")}.svg`);
    try {
      writeFileSync(target, await renderSvg(readFileSync(join(source, file), "utf8"), fonts));
      written.push(target);
    } catch (error) {
      failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { written, failures };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { src: { type: "string", default: SOURCE_DIR }, out: { type: "string", default: OUTPUT_DIR } },
  });
  const { written, failures } = await renderDirectory(values.src, values.out);
  for (const path of written) console.log(path);
  for (const failure of failures) console.error(failure);
  process.exitCode = failures.length > 0 || written.length === 0 ? 1 : 0;
}
