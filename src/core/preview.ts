import { field, inputText, isRecord, text } from "./tool-input.ts";
import { fitEnd, type Glyphs, oneLine } from "./ui-kit.ts";
import { type Piece, TONE_KEYS } from "./visual.ts";
import type { GroupCall } from "./receipt.ts";

/** A PNG the model read, as its Read call's output carries it; `base64` is empty when its bytes are not a PNG the terminal can draw. */
export type ImagePreview = { path: string; base64: string; width: number; height: number };

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = "IHDR";
// The signature, the first chunk's length and the IHDR type: 16 bytes, so 24 base64 characters.
const HEAD_CHARS = 24;

/** Whether the bytes open as a PNG does: its signature, then the IHDR chunk the engine checks for before it draws one. */
export function isPngHead(base64: string): boolean {
  let head: string;
  try {
    head = atob(base64.slice(0, HEAD_CHARS));
  } catch {
    return false;
  }
  return SIGNATURE.every((byte, index) => head.charCodeAt(index) === byte) && head.slice(12, 16) === IHDR;
}

const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * The PNG a finished Read call returned, or null: a call that read text, a picture in another format
 * (the terminal draws PNG and raw pixels only), or one whose output names no size.
 */
export function imagePreview(call: GroupCall): ImagePreview | null {
  if (call.tool !== "Read" || call.isRunning || call.isErrored || !isRecord(call.output) || call.output["type"] !== "image") return null;
  const file = field(call.output, "file");
  if (text(field(file, "type")) !== "image/png") return null;
  const base64 = text(field(file, "base64"));
  const dimensions = field(file, "dimensions");
  const width = number(field(dimensions, "displayWidth")) || number(field(dimensions, "originalWidth"));
  const height = number(field(dimensions, "displayHeight")) || number(field(dimensions, "originalHeight"));
  if (base64 === "" || width === 0 || height === 0) return null;
  return { path: inputText(call.input, "file_path"), base64: isPngHead(base64) ? base64 : "", width, height };
}

// A terminal cell is about twice as tall as it is wide.
const CELL_ASPECT = 2;
const MAX_COLUMNS = 72;
const MAX_ROWS = 20;
const MIN_SIDE = 2;

/** The box of cells that shows the picture at its own aspect within `columns`, no more than 72 wide and 20 tall. */
export function previewBox({ width, height }: Pick<ImagePreview, "width" | "height">, columns: number): { columns: number; rows: number } {
  const wide = Math.max(MIN_SIDE, Math.min(MAX_COLUMNS, columns));
  const rows = Math.round((wide * height) / width / CELL_ASPECT);
  if (rows <= MAX_ROWS) return { columns: wide, rows: Math.max(MIN_SIDE, rows) };
  return { columns: Math.max(MIN_SIDE, Math.round((MAX_ROWS * CELL_ASPECT * width) / height)), rows: MAX_ROWS };
}

const INDENT = "  ⎿  ";
const ASCII_INDENT = "  |  ";

/** The row that names a preview under its group: the file's name and its size in pixels. */
export function previewCaption({ path, width, height }: ImagePreview, g: Glyphs, columns: number): Piece[] {
  const indent = g.tier === "ascii" ? ASCII_INDENT : INDENT;
  const name = oneLine(path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1));
  const size = ` ${g.dot} ${width}${g.tier === "ascii" ? "x" : "×"}${height}`;
  const room = Math.max(0, columns - indent.length - size.length);
  return [
    { text: indent, color: TONE_KEYS.muted },
    { text: fitEnd(name, room, g.ellipsis) },
    { text: size, color: TONE_KEYS.muted },
  ];
}
