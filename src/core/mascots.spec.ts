import { expect, test } from "bun:test";
import {
  FRAME_MS,
  framesOf,
  LAYERS,
  MASCOTS,
  type MascotName,
  type MascotState,
  mascotOf,
  MINI,
  MINI_LAYERS,
  MINIS,
  paletteOf,
  rasterCells,
  SIZE,
  svgOf,
  TERMINAL_DEFAULT,
  WORKING_FRAMES,
} from "./mascots.ts";

const NAMES = Object.keys(MASCOTS) as MascotName[];
const STATES: MascotState[] = ["working", "done", "failed", "idle"];

type Run = readonly [y: number, x: number, pixels: string];
const cellsOf = (layer: readonly Run[]): string[] =>
  layer.flatMap(([y, x, pixels]) => [...pixels].flatMap((key, i) => (key === "." ? [] : [`${y},${x + i}`])));

test("every run stays on the 16 by 16 grid and paints only palette keys", () => {
  for (const name of NAMES) {
    const spec = MASCOTS[name];
    const keys = new Set([...Object.keys(paletteOf(spec)), "."]);
    for (const layer of [...Object.values(LAYERS), spec.props, spec.poseA, spec.poseB]) {
      for (const [y, x, pixels] of layer as readonly Run[]) {
        expect([name, y >= 0 && y < SIZE && x >= 0 && x + pixels.length <= SIZE]).toEqual([name, true]);
        for (const key of pixels) expect([name, pixels, keys.has(key)]).toEqual([name, pixels, true]);
      }
    }
  }
});

test("no working pixel sits on the top row, so the hop never clips a hat or a prop", () => {
  for (const name of NAMES) {
    framesOf(name, "working").forEach((frame, i) => {
      if (i % 2 === 0) expect([name, i, frame[0]?.every((cell) => cell === null)]).toEqual([name, i, true]);
    });
  }
});

// The sweat, the sparkle and the snore float beside the pebble: none of their pixels may land on
// or orthogonally touch a prop or the resting pose, or the overlay merges into the tool.
test("the floating overlays never touch a prop, the resting pose or the body", () => {
  const floating = [LAYERS.sweat, LAYERS.sparkle, LAYERS.snore];
  const body = new Set(cellsOf(LAYERS.body));
  for (const name of NAMES) {
    const held = new Set(cellsOf([...MASCOTS[name].props, ...MASCOTS[name].poseA]));
    for (const layer of floating) {
      for (const cell of cellsOf(layer)) {
        const [y = 0, x = 0] = cell.split(",").map(Number);
        const near = [cell, `${y - 1},${x}`, `${y + 1},${x}`, `${y},${x - 1}`, `${y},${x + 1}`].filter((at) => held.has(at));
        expect([name, cell, near, body.has(cell)]).toEqual([name, cell, [], false]);
      }
    }
  }
});

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

test("a still svg of the working loop is its first frame alone, built once", () => {
  const frames = framesOf("executor", "working");
  const still = svgOf(frames, FRAME_MS, true);
  expect(still).toBe(svgOf(framesOf("executor", "working").slice(0, 1)));
  expect(svgOf(frames, FRAME_MS, true)).toBe(still);
  expect(svgOf(frames)).toContain("<animate");
});

test("done, failed and idle are one frame each: only a working mascot moves", () => {
  for (const name of NAMES) for (const state of ["done", "failed", "idle"] as const) expect([name, state, framesOf(name, state).length]).toEqual([name, state, 1]);
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
  expect(cell(4, 8)).toEqual([0x20, TERMINAL_DEFAULT, MASCOTS.executor.body]);
  expect(cell(0, 0)).toEqual([0x20, TERMINAL_DEFAULT, TERMINAL_DEFAULT]);
  expect(TERMINAL_DEFAULT).toBe(0x01000000);
});

test("every mini run stays on the 8 by 8 grid and paints only palette keys", () => {
  for (const name of NAMES) {
    const keys = new Set([...Object.keys(paletteOf(MASCOTS[name])), "."]);
    for (const layer of [...Object.values(MINI_LAYERS), MINIS[name].props, MINIS[name].poseA, MINIS[name].poseB]) {
      for (const [y, x, pixels] of layer as readonly Run[]) {
        expect([name, y >= 0 && y < MINI && x >= 0 && x + pixels.length <= MINI]).toEqual([name, true]);
        for (const key of pixels) expect([name, pixels, keys.has(key)]).toEqual([name, pixels, true]);
      }
    }
  }
});

test("a mini's sweat, sparkle and snore never touch its head piece, its resting pose or its body", () => {
  const body = new Set(cellsOf(MINI_LAYERS.body));
  for (const name of NAMES) {
    const held = new Set(cellsOf([...MINIS[name].props, ...MINIS[name].poseA]));
    for (const cell of cellsOf([...MINI_LAYERS.sweat, ...MINI_LAYERS.sparkle, ...MINI_LAYERS.snore])) {
      const [y = 0, x = 0] = cell.split(",").map(Number);
      const near = [cell, `${y - 1},${x}`, `${y + 1},${x}`, `${y},${x - 1}`, `${y},${x + 1}`].filter((at) => held.has(at));
      expect([name, cell, near, body.has(cell)]).toEqual([name, cell, [], false]);
    }
  }
});

test("a mini works in 12 frames that never hop, and rests in one frame each when done, failed or idle", () => {
  for (const name of NAMES) {
    const frames = framesOf(name, "working", "mini");
    expect(frames).toHaveLength(WORKING_FRAMES);
    for (const frame of frames) {
      expect(frame).toHaveLength(MINI);
      expect(JSON.stringify(frame[7])).toBe(JSON.stringify(frames[0]?.[7]));
    }
    for (const state of ["done", "failed", "idle"] as const) expect([name, state, framesOf(name, state, "mini").length]).toEqual([name, state, 1]);
  }
});

test("a mini's raster is 8 columns by 4 rows and its svg an 8 by 8 view box", () => {
  const frame = framesOf("executor", "working", "mini")[0];
  if (frame === undefined) throw new Error("no frame");
  expect(Uint8Array.from(atob(rasterCells(frame)), (c) => c.charCodeAt(0)).length).toBe(MINI * (MINI / 2) * 12);
  expect(svgOf(framesOf("executor", "working", "mini"))).toContain('viewBox="0 0 8 8"');
  expect(framesOf("executor", "working", "mini")).not.toBe(framesOf("executor", "working"));
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
