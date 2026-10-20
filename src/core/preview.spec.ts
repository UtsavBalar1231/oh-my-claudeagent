import { describe, expect, test } from "bun:test";
import { imagePreview, isPngHead, previewBox, previewCaption } from "./preview.ts";
import type { GroupCall } from "./receipt.ts";
import { glyphs } from "./ui-kit.ts";
import { piecesWidth, TONE_KEYS } from "./visual.ts";

const U = glyphs("unicode");
const read = (output: unknown, extra: Partial<GroupCall> = {}): GroupCall => ({
  tool: "Read",
  input: { file_path: "docs/shots/band.png" },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output,
  ...extra,
});
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const png = (dimensions: object, base64 = PNG) => ({ type: "image", file: { base64, type: "image/png", originalSize: 85_711, dimensions } });
const text = (pieces: readonly { text: string }[]) => pieces.map((piece) => piece.text).join("");

describe("imagePreview", () => {
  test("a PNG a Read call returned, at the size the model saw it", () => {
    const output = png({ originalWidth: 2706, originalHeight: 1566, displayWidth: 1353, displayHeight: 783 });
    expect(imagePreview(read(output))).toEqual({ path: "docs/shots/band.png", base64: PNG, width: 1353, height: 783 });
  });

  test("bytes that do not open as a PNG keep the size and drop the picture", () => {
    expect(imagePreview(read(png({ originalWidth: 4, originalHeight: 3 }, "iVBORw0KGgo=")))?.base64).toBe("");
    expect(imagePreview(read(png({ originalWidth: 4, originalHeight: 3 }, "not base64 at all!")))?.base64).toBe("");
  });

  test("falls back to the original size when no display size is given", () => {
    expect(imagePreview(read(png({ originalWidth: 640, originalHeight: 480 })))?.width).toBe(640);
  });

  test("no preview for text, another format, a running or failed call, another tool, or no size", () => {
    expect(imagePreview(read({ type: "text", file: { content: "hi" } }))).toBeNull();
    expect(imagePreview(read({ type: "image", file: { base64: "x", type: "image/jpeg", dimensions: { originalWidth: 1, originalHeight: 1 } } }))).toBeNull();
    expect(imagePreview(read(png({ originalWidth: 1, originalHeight: 1 }), { isRunning: true }))).toBeNull();
    expect(imagePreview(read("Error: no such file", { isErrored: true }))).toBeNull();
    expect(imagePreview({ ...read(png({ originalWidth: 1, originalHeight: 1 })), tool: "Edit" })).toBeNull();
    expect(imagePreview(read(png({})))).toBeNull();
  });
});

describe("isPngHead", () => {
  test("reads the signature and the IHDR chunk from the first bytes", () => {
    expect(isPngHead(PNG)).toBe(true);
    expect(isPngHead("iVBORw0KGgo=")).toBe(false);
    expect(isPngHead("/9j/4AAQSkZJRgABAQ")).toBe(false);
    expect(isPngHead("")).toBe(false);
  });
});

describe("previewBox", () => {
  test("keeps the picture's aspect, a cell being twice as tall as it is wide", () => {
    expect(previewBox({ width: 1600, height: 400 }, 80)).toEqual({ columns: 72, rows: 9 });
    expect(previewBox({ width: 1353, height: 783 }, 80)).toEqual({ columns: 69, rows: 20 });
  });

  test("a tall picture is held to 20 rows and narrowed to match", () => {
    expect(previewBox({ width: 1000, height: 1000 }, 120)).toEqual({ columns: 40, rows: 20 });
    expect(previewBox({ width: 400, height: 1600 }, 120)).toEqual({ columns: 10, rows: 20 });
  });

  test("a narrow transcript narrows the box", () => {
    expect(previewBox({ width: 1600, height: 400 }, 40)).toEqual({ columns: 40, rows: 5 });
  });
});

describe("previewCaption", () => {
  test("names the file and its size under the group", () => {
    const row = previewCaption({ path: "docs/shots/band.png", base64: "", width: 1353, height: 783 }, U, 80);
    expect(text(row)).toBe("  ⎿  band.png · 1353×783");
    expect(row.at(-1)?.color).toBe(TONE_KEYS.muted);
  });

  test("cuts a long name to fit and keeps the size", () => {
    const row = previewCaption({ path: "C:\\shots\\a-very-long-screenshot-name-from-the-qa-run.png", base64: "", width: 10, height: 10 }, U, 30);
    expect(text(row)).toBe("  ⎿  a-very-long-scre… · 10×10");
    expect(piecesWidth(row)).toBeLessThanOrEqual(30);
  });

  test("draws the ASCII set when asked", () => {
    expect(text(previewCaption({ path: "a.png", base64: "", width: 4, height: 3 }, glyphs("ascii"), 80))).toBe("  |  a.png - 4x3");
  });
});
