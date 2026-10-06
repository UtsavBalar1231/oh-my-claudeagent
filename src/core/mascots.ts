import { omcaAgentName } from "./agent-type.ts";

// Mascot colors are fixed RGB, the one exception to theme keys.

export const SIZE = 16;
export type Rgb = number;
export type Frame = readonly (readonly (Rgb | null)[])[];
export type MascotState = "working" | "done" | "failed" | "idle";
type Run = readonly [y: number, x: number, pixels: string];
type Layer = readonly Run[];

interface Spec {
  readonly body: Rgb;
  readonly props: Layer;
  readonly poseA: Layer;
  readonly poseB: Layer;
}

const SHARED: Readonly<Record<string, Rgb>> = {
  e: 0x2b2840,
  m: 0x2b2840,
  w: 0xffffff,
  p: 0xff9aae,
  K: 0x34324a,
  G: 0x8e93a6,
  S: 0xd9dde6,
  Y: 0xffd447,
  O: 0xff9f43,
  R: 0xe5484d,
  B: 0x9a6a3f,
  T: 0xd8b76e,
  U: 0x3e7bea,
  C: 0xa8e6ff,
  N: 0xfff7e0,
  V: 0x34c26b,
  W: 0xffffff,
  Z: 0xb9b3ff,
};

const BODY: Layer = [
  [6, 5, "oooooo"],
  [7, 4, "obbbbbbo"],
  [8, 3, "obllbbbbbo"],
  [9, 3, "oblbbbbbbo"],
  [10, 3, "obewbbewbo"],
  [11, 3, "obeebbeebo"],
  [12, 3, "opbbmmbbpo"],
  [13, 3, "obbbbbbbbo"],
  [14, 4, "obbbbbbo"],
  [15, 5, "oo..oo"],
];

const BLINK: Layer = [[10, 5, "bb..bb"]];
const HAPPY: Layer = [[10, 5, "eb..be"], [11, 4, "ebe..ebe"], [12, 6, "mbbm"], [13, 7, "mm"]];
const SAD: Layer = [[10, 5, "bb..bb"], [13, 6, "m..m"], [7, 13, "C"], [8, 13, "C"]];
const SPARKLE_A: Layer = [[2, 13, "Y"], [3, 12, "YWY"], [4, 13, "Y"], [5, 1, "Y"]];
const SPARKLE_B: Layer = [[1, 2, "Y"], [2, 1, "YWY"], [3, 2, "Y"], [4, 14, "Y"]];
const SNORE_A: Layer = [[2, 0, "ZZZZ"], [3, 2, "Z"], [4, 1, "Z"], [5, 0, "ZZZZ"]];
const SNORE_B: Layer = [[0, 0, "ZZZZ"], [1, 2, "Z"], [2, 1, "Z"], [3, 0, "ZZZZ"]];

export const MASCOTS = {
  orchestrator: {
    body: 0x9d8cff,
    props: [[4, 8, "o"], [5, 7, "o"]],
    poseA: [[11, 13, "b"], [10, 14, "K"], [9, 15, "S"], [8, 15, "S"], [3, 14, "Y"], [4, 14, "Y"], [5, 13, "YY"]],
    poseB: [[12, 13, "bKS"], [13, 15, "S"], [1, 15, "Y"], [2, 15, "Y"], [3, 14, "YY"], [4, 1, "Y"], [5, 1, "Y"], [6, 0, "YY"]],
  },
  planner: {
    body: 0x4ccbdd,
    props: [[8, 1, "G"], [9, 0, "NNN"], [10, 0, "KKN"], [11, 0, "NNN"], [12, 0, "KKN"], [13, 0, "NNN"]],
    poseA: [[10, 2, "V"], [11, 13, "b"], [10, 14, "Y"], [9, 15, "Y"]],
    poseB: [[10, 2, "V"], [12, 2, "V"], [12, 13, "b"], [11, 14, "Y"], [10, 15, "Y"]],
  },
  analyzer: {
    body: 0xf7d660,
    props: [[11, 2, "V"], [12, 1, "YV"], [13, 0, "RYV"]],
    poseA: [[8, 14, "S"], [9, 13, "SCS"], [10, 14, "S"], [11, 14, "B"], [12, 14, "B"]],
    poseB: [[9, 10, "S"], [10, 9, "SCS"], [11, 10, "S"], [12, 12, "B"], [13, 13, "B"]],
  },
  reviewer: {
    body: 0xf2716b,
    props: [[14, 12, "NNNN"], [15, 12, "NNNN"]],
    poseA: [[8, 14, "B"], [9, 14, "B"], [10, 13, "KKK"], [14, 13, "RR"]],
    poseB: [[11, 14, "B"], [12, 14, "B"], [13, 13, "KKK"]],
  },
  executor: {
    body: 0x5ccb80,
    props: [[4, 6, "YOOY"], [5, 5, "YYYYYY"], [6, 4, "YYYYYYYY"]],
    poseA: [[12, 13, "b"], [11, 14, "B"], [10, 14, "B"], [9, 13, "GGG"]],
    poseB: [[12, 13, "BB"], [11, 15, "G"], [12, 15, "G"], [13, 15, "G"], [14, 14, "Y"]],
  },
  explorer: {
    body: 0x58a0f5,
    props: [[3, 6, "TTTT"], [4, 5, "TTTTTT"], [5, 5, "BBBBBB"], [6, 3, "TTTTTTTTTT"]],
    poseA: [[10, 10, "KSSSGG"], [9, 15, "G"], [11, 15, "G"]],
    poseB: [[12, 13, "SSG"], [11, 15, "G"], [13, 15, "G"]],
  },
  researcher: {
    body: 0xff9c59,
    props: [[9, 5, "KK"], [9, 9, "KK"], [10, 4, "K"], [10, 7, "KK"], [10, 11, "K"], [12, 13, "VVN"], [13, 13, "UUN"], [14, 13, "RRN"], [15, 13, "RRN"]],
    poseA: [[12, 12, "b"]],
    poseB: [[10, 5, "w"], [10, 6, "e"], [10, 9, "w"], [10, 10, "e"], [11, 13, "VVN"], [12, 13, "NNN"]],
  },
  architect: {
    body: 0xc983e8,
    props: [[1, 7, "YY"], [2, 6, "YYYY"], [3, 7, "YY"], [4, 7, "GG"], [11, 0, "CUU"], [12, 0, "CUU"]],
    poseA: [[1, 5, "Y"], [1, 10, "Y"], [3, 4, "Y"], [3, 11, "Y"]],
    poseB: [[1, 7, "SS"], [2, 6, "SSSS"], [3, 7, "SS"]],
  },
  "build-fixer": {
    body: 0xe3ae45,
    props: [[8, 3, "KKCCKKCCKK"]],
    poseA: [[8, 13, "S.S"], [9, 13, "SSS"], [10, 14, "S"], [11, 14, "S"], [12, 13, "bS"]],
    poseB: [[10, 14, "SS"], [11, 13, "SS"], [12, 14, "SS"], [6, 15, "Y"]],
  },
  viewer: {
    body: 0xf784c2,
    props: [[9, 13, "K"], [10, 12, "KKKK"], [11, 12, "KSCK"], [12, 12, "KKKK"]],
    poseA: [],
    poseB: [[8, 14, "W"], [7, 13, "Y.Y"], [9, 15, "Y"]],
  },
} as const satisfies Record<string, Spec>;

export type MascotName = keyof typeof MASCOTS;

const shade = (rgb: Rgb, f: number): Rgb =>
  (Math.round(((rgb >> 16) & 255) * f) << 16) | (Math.round(((rgb >> 8) & 255) * f) << 8) | Math.round((rgb & 255) * f);
const tint = (rgb: Rgb, f: number): Rgb => {
  const up = (c: number) => Math.round(c + (255 - c) * f);
  return (up((rgb >> 16) & 255) << 16) | (up((rgb >> 8) & 255) << 8) | up(rgb & 255);
};

function paletteOf(spec: Spec): Readonly<Record<string, Rgb>> {
  return { ...SHARED, b: spec.body, o: shade(spec.body, 0.55), l: tint(spec.body, 0.5) };
}

function paint(grid: (Rgb | null)[][], layer: Layer, palette: Readonly<Record<string, Rgb>>): void {
  for (const [y, x0, pixels] of layer) {
    for (let i = 0; i < pixels.length; i++) {
      const key = pixels[i];
      if (key === undefined || key === ".") continue;
      const color = palette[key];
      const row = grid[y];
      if (color === undefined || row === undefined || x0 + i >= SIZE) continue;
      row[x0 + i] = color;
    }
  }
}

function compose(spec: Spec, layers: readonly Layer[], lift: number): Frame {
  const palette = paletteOf(spec);
  const grid: (Rgb | null)[][] = Array.from({ length: SIZE }, () => Array<Rgb | null>(SIZE).fill(null));
  for (const layer of layers) paint(grid, layer, palette);
  return lift === 0 ? grid : [...grid.slice(lift), ...Array.from({ length: lift }, () => Array<Rgb | null>(SIZE).fill(null))];
}

export const WORKING_FRAMES = 12;
export const FRAME_MS = 170;

const framesCache = new Map<string, Frame[]>();

export function framesOf(name: MascotName, state: MascotState): Frame[] {
  const key = `${name}:${state}`;
  let frames = framesCache.get(key);
  if (frames === undefined) {
    frames = buildFrames(name, state);
    framesCache.set(key, frames);
  }
  return frames;
}

function buildFrames(name: MascotName, state: MascotState): Frame[] {
  const spec: Spec = MASCOTS[name];
  const base = [BODY, spec.props];
  switch (state) {
    case "working":
      return Array.from({ length: WORKING_FRAMES }, (_, i) => {
        const pose = Math.floor(i / 2) % 2 === 0 ? spec.poseA : spec.poseB;
        const eyes = i === WORKING_FRAMES - 3 ? [BLINK] : [];
        return compose(spec, [BODY, ...eyes, spec.props, pose], i % 2);
      });
    case "done":
      return [compose(spec, [...base, HAPPY, spec.poseA, SPARKLE_A], 0), compose(spec, [...base, HAPPY, spec.poseA, SPARKLE_B], 0)];
    case "failed":
      return [compose(spec, [...base, SAD, spec.poseA], 0)];
    case "idle":
      return [compose(spec, [...base, BLINK, spec.poseA, SNORE_A], 0), compose(spec, [...base, BLINK, spec.poseA, SNORE_B], 0)];
  }
}

const hex = (rgb: Rgb) => `#${rgb.toString(16).padStart(6, "0")}`;

function rects(frame: Frame): string {
  let out = "";
  frame.forEach((row, y) => {
    let x = 0;
    while (x < SIZE) {
      const color = row[x] ?? null;
      let end = x + 1;
      while (end < SIZE && (row[end] ?? null) === color) end++;
      if (color !== null) out += `<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${hex(color)}"/>`;
      x = end;
    }
  });
  return out;
}

const svgCache = new WeakMap<readonly Frame[], Map<number, string>>();

export function svgOf(frames: readonly Frame[], frameMs = FRAME_MS): string {
  let byMs = svgCache.get(frames);
  if (byMs === undefined) svgCache.set(frames, (byMs = new Map()));
  let svg = byMs.get(frameMs);
  if (svg === undefined) byMs.set(frameMs, (svg = buildSvg(frames, frameMs)));
  return svg;
}

function buildSvg(frames: readonly Frame[], frameMs: number): string {
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" shape-rendering="crispEdges">`;
  if (frames.length === 1) return `${head}${rects(frames[0] ?? [])}</svg>`;
  const n = frames.length;
  const keyTimes = Array.from({ length: n }, (_, i) => (i / n).toFixed(4)).join(";");
  const groups = frames
    .map((frame, i) => {
      const values = Array.from({ length: n }, (_, j) => (j === i ? "1" : "0")).join(";");
      return `<g opacity="${i === 0 ? 1 : 0}"><animate attributeName="opacity" values="${values}" keyTimes="${keyTimes}" calcMode="discrete" dur="${n * frameMs}ms" repeatCount="indefinite"/>${rects(frame)}</g>`;
    })
    .join("");
  return `${head}${groups}</svg>`;
}

export const TERMINAL_DEFAULT = 0x01000000;
const UPPER_HALF = 0x2580;
const LOWER_HALF = 0x2584;

const rasterCache = new WeakMap<Frame, string>();

/** One frame as Raster cells: 16 columns by 8 rows of [codePoint, fg, bg] little-endian u32. */
export function rasterCells(frame: Frame): string {
  let cells = rasterCache.get(frame);
  if (cells === undefined) rasterCache.set(frame, (cells = buildRaster(frame)));
  return cells;
}

function buildRaster(frame: Frame): string {
  const rows = SIZE / 2;
  const bytes = new Uint8Array(SIZE * rows * 12);
  const view = new DataView(bytes.buffer);
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < SIZE; x++) {
      const top = frame[r * 2]?.[x] ?? null;
      const bottom = frame[r * 2 + 1]?.[x] ?? null;
      const [glyph, fg, bg] =
        top !== null
          ? [UPPER_HALF, top, bottom ?? TERMINAL_DEFAULT]
          : bottom !== null
            ? [LOWER_HALF, bottom, TERMINAL_DEFAULT]
            : [0x20, TERMINAL_DEFAULT, TERMINAL_DEFAULT];
      const at = (r * SIZE + x) * 12;
      view.setUint32(at, glyph, true);
      view.setUint32(at + 4, fg, true);
      view.setUint32(at + 8, bg, true);
    }
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function mascotOf(type: string): MascotName | undefined {
  const name = omcaAgentName(type);
  return name !== undefined && Object.hasOwn(MASCOTS, name) ? (name as MascotName) : undefined;
}
