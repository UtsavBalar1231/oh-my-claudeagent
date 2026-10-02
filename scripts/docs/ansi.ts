export type Color = `p${number}` | `#${string}`;

export type Style = {
  readonly fg: Color | null;
  readonly bg: Color | null;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  readonly reverse: boolean;
};

export type Cell = { readonly text: string; readonly width: 1 | 2; readonly style: Style };
export type Row = readonly Cell[];

export const PLAIN: Style = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strike: false,
  reverse: false,
};

const SGR = /\x1b\[([0-9;:]*)m/y;
const OTHER_ESCAPE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-9;:?<=>]*[ -/]*[@-~]|[@-Z\\-_])/y;
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;
const segmenter = new Intl.Segmenter();

const hex = (value: number): string => value.toString(16).padStart(2, "0");

function rgb(parts: readonly number[]): Color {
  const [r, g, b] = parts;
  if (r === undefined || g === undefined || b === undefined || [r, g, b].some((v) => !(v >= 0 && v <= 255))) {
    throw new Error(`invalid truecolor parameters: ${parts.join(";")}`);
  }
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function palette(index: number | undefined): Color {
  if (index === undefined || !Number.isInteger(index) || index < 0 || index > 255) {
    throw new Error(`invalid 256-color index: ${index}`);
  }
  return `p${index}`;
}

function extended(code: number, params: readonly (readonly number[])[], at: number): { color: Color; consumed: number } {
  const group = params[at] ?? [];
  if (group.length > 1) {
    const [, mode, ...rest] = group;
    if (mode === 5) return { color: palette(rest[0]), consumed: 0 };
    if (mode === 2) return { color: rgb(rest.slice(-3)), consumed: 0 };
    throw new Error(`unsupported color mode in SGR ${code}: ${mode}`);
  }
  const mode = params[at + 1]?.[0];
  if (mode === 5) return { color: palette(params[at + 2]?.[0]), consumed: 2 };
  if (mode === 2) return { color: rgb([2, 3, 4].map((offset) => params[at + offset]?.[0] ?? Number.NaN)), consumed: 4 };
  throw new Error(`unsupported color mode in SGR ${code}: ${mode}`);
}

function applySgr(style: Style, parameters: string): Style {
  const params = (parameters === "" ? "0" : parameters).split(";").map((group) => group.split(":").map((n) => (n === "" ? 0 : Number(n))));
  let next = { ...style };
  for (let at = 0; at < params.length; at += 1) {
    const code = params[at]?.[0];
    if (code === undefined || Number.isNaN(code)) throw new Error(`invalid SGR parameters: ${parameters}`);
    if (code === 0) next = { ...PLAIN };
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = params[at]?.[1] !== 0;
    else if (code === 7) next.reverse = true;
    else if (code === 9) next.strike = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.reverse = false;
    else if (code === 29) next.strike = false;
    else if (code >= 30 && code <= 37) next.fg = palette(code - 30);
    else if (code >= 90 && code <= 97) next.fg = palette(code - 82);
    else if (code === 39) next.fg = null;
    else if (code >= 40 && code <= 47) next.bg = palette(code - 40);
    else if (code >= 100 && code <= 107) next.bg = palette(code - 92);
    else if (code === 49) next.bg = null;
    else if (code === 38 || code === 48 || code === 58) {
      const { color, consumed } = extended(code, params, at);
      if (code === 38) next.fg = color;
      else if (code === 48) next.bg = color;
      at += consumed;
    } else if (code === 59) continue;
    else throw new Error(`unsupported SGR code ${code}`);
  }
  return next;
}

function cellsOf(text: string, style: Style, row: number): Cell[] {
  const found = CONTROL.exec(text);
  if (found) throw new Error(`row ${row}: unsupported control character U+${found[0].codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`);
  return [...segmenter.segment(text)].map(({ segment }) => ({ text: segment, width: Bun.stringWidth(segment) >= 2 ? 2 : 1, style }));
}

export function parseAnsi(text: string): Row[] {
  const lines = text.replace(/\n$/, "").split("\n");
  let style = PLAIN;
  return lines.map((line, row) => {
    const cells: Cell[] = [];
    let literal = "";
    const flush = (): void => {
      cells.push(...cellsOf(literal, style, row));
      literal = "";
    };
    for (let at = 0; at < line.length; ) {
      if (line[at] === "\x1b") {
        SGR.lastIndex = at;
        const sgr = SGR.exec(line);
        if (sgr) {
          flush();
          style = applySgr(style, sgr[1] ?? "");
          at = SGR.lastIndex;
          continue;
        }
        OTHER_ESCAPE.lastIndex = at;
        const other = OTHER_ESCAPE.exec(line);
        if (!other) throw new Error(`row ${row}: unsupported escape sequence at column ${at}`);
        at = OTHER_ESCAPE.lastIndex;
        continue;
      }
      const codePoint = line.codePointAt(at) ?? 0;
      literal += String.fromCodePoint(codePoint);
      at += codePoint > 0xffff ? 2 : 1;
    }
    flush();
    return cells;
  });
}

export const rowWidth = (row: Row): number => row.reduce((sum, cell) => sum + cell.width, 0);

export function padRow(row: Row, cols: number): Row {
  const missing = cols - rowWidth(row);
  if (missing < 0) throw new Error(`a row is ${rowWidth(row)} columns wide, past the ${cols}-column session`);
  return [...row, ...Array.from({ length: missing }, () => ({ text: " ", width: 1 as const, style: PLAIN }))];
}

export const colorPalette = (color: Color): number | null => (color.startsWith("p") ? Number(color.slice(1)) : null);

export const sameStyle = (a: Style, b: Style): boolean =>
  a.fg === b.fg &&
  a.bg === b.bg &&
  a.bold === b.bold &&
  a.dim === b.dim &&
  a.italic === b.italic &&
  a.underline === b.underline &&
  a.strike === b.strike &&
  a.reverse === b.reverse;

function colorCodes(color: Color, foreground: boolean): string {
  const index = colorPalette(color);
  if (index === null) {
    const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(color.slice(at, at + 2), 16));
    return `${foreground ? 38 : 48};2;${r};${g};${b}`;
  }
  if (index < 8) return String((foreground ? 30 : 40) + index);
  if (index < 16) return String((foreground ? 90 : 100) + index - 8);
  return `${foreground ? 38 : 48};5;${index}`;
}

function styleSequence(style: Style): string {
  const codes = ["0"];
  if (style.bold) codes.push("1");
  if (style.dim) codes.push("2");
  if (style.italic) codes.push("3");
  if (style.underline) codes.push("4");
  if (style.reverse) codes.push("7");
  if (style.strike) codes.push("9");
  if (style.fg !== null) codes.push(colorCodes(style.fg, true));
  if (style.bg !== null) codes.push(colorCodes(style.bg, false));
  return `\x1b[${codes.join(";")}m`;
}

export function formatAnsi(rows: readonly Row[]): string {
  return rows
    .map((row) => {
      let out = "";
      let current = PLAIN;
      for (const cell of row) {
        if (!sameStyle(cell.style, current)) {
          out += styleSequence(cell.style);
          current = cell.style;
        }
        out += cell.text;
      }
      return sameStyle(current, PLAIN) ? out : `${out}\x1b[0m`;
    })
    .map((line) => `${line}\n`)
    .join("");
}
