import { expect, test } from "bun:test";
import { FRAME_MS, framesOf, MASCOTS, type MascotName, type MascotState, mascotOf, rasterCells, SIZE, svgOf, TERMINAL_DEFAULT, WORKING_FRAMES } from "./mascots.ts";

const NAMES = Object.keys(MASCOTS) as MascotName[];
const STATES: MascotState[] = ["working", "done", "failed", "idle"];

test("every frame is 16 rows of 16 cells with at most 16 distinct colors", () => {
  for (const name of NAMES) {
    for (const state of STATES) {
      for (const frame of framesOf(name, state)) {
        expect(frame).toHaveLength(SIZE);
        for (const row of frame) expect(row).toHaveLength(SIZE);
        const colors = new Set(frame.flat().filter((cell) => cell !== null));
        expect(colors.size).toBeLessThanOrEqual(16);
      }
    }
  }
});

test("the working loop has 12 frames, hops on odd frames and blinks once", () => {
  expect(WORKING_FRAMES).toBe(12);
  for (const name of NAMES) {
    const frames = framesOf(name, "working");
    expect(frames).toHaveLength(12);
    const blinked: number[] = [];
    for (let i = 1; i < frames.length; i += 2) {
      const even = frames[i - 1] ?? [];
      const odd = frames[i] ?? [];
      const hopped = odd.every((row, y) => y === SIZE - 1 || JSON.stringify(row) === JSON.stringify(even[y + 1]));
      if (hopped) continue;
      blinked.push(i);
      const eyeRows = [9, 10];
      expect(odd.every((row, y) => y === SIZE - 1 || eyeRows.includes(y) || JSON.stringify(row) === JSON.stringify(even[y + 1]))).toBe(true);
    }
    expect(blinked).toHaveLength(1);
    expect(frames[1]?.[SIZE - 1]?.every((cell) => cell === null)).toBe(true);
  }
});

test("svgOf stays under 131072 characters for every mascot and state", () => {
  for (const name of NAMES) {
    for (const state of STATES) {
      const svg = svgOf(framesOf(name, state));
      expect(svg.length).toBeLessThan(131072);
      expect(svg.startsWith("<svg ")).toBe(true);
    }
  }
});

test("a single frame is a still svg and several frames animate", () => {
  expect(svgOf(framesOf("executor", "failed"))).not.toContain("<animate");
  expect(svgOf(framesOf("executor", "working"))).toContain(`dur="${WORKING_FRAMES * FRAME_MS}ms"`);
});

test("rasterCells decodes to 16 by 8 little-endian triplets", () => {
  const frame = framesOf("executor", "working")[0];
  if (frame === undefined) throw new Error("no frame");
  const bytes = Uint8Array.from(atob(rasterCells(frame)), (c) => c.charCodeAt(0));
  expect(bytes.length).toBe(16 * 8 * 12);
  const view = new DataView(bytes.buffer);
  const cell = (r: number, x: number) => {
    const at = (r * SIZE + x) * 12;
    return [view.getUint32(at, true), view.getUint32(at + 4, true), view.getUint32(at + 8, true)];
  };
  expect(cell(5, 6)).toEqual([0x2580, 0xffffff, 0x2b2840]);
  expect(cell(0, 0)).toEqual([0x20, TERMINAL_DEFAULT, TERMINAL_DEFAULT]);
  expect(TERMINAL_DEFAULT).toBe(0x01000000);
});

test("mascotOf resolves this plugin's agents only", () => {
  expect(mascotOf("oh-my-claudeagent:executor")).toBe("executor");
  expect(mascotOf("executor")).toBe("executor");
  expect(mascotOf("other:executor")).toBeUndefined();
  expect(mascotOf("unknown")).toBeUndefined();
  expect(mascotOf("toString")).toBeUndefined();
});

test("repeated calls return the identical value", () => {
  expect(framesOf("planner", "idle")).toBe(framesOf("planner", "idle"));
  const frames = framesOf("planner", "working");
  expect(svgOf(frames)).toBe(svgOf(frames));
  const frame = frames[0];
  if (frame === undefined) throw new Error("no frame");
  expect(rasterCells(frame)).toBe(rasterCells(frame));
});
