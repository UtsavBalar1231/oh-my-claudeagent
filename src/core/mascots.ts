import { omcaAgentName } from "./agent-type.ts";

// Mascot colors are fixed RGB, the one exception to theme keys.

export const SIZE = 16;
export type MascotSize = "full" | "mini";
/** Each size's pixel grid. The lane-sized mascot is 15 by 8 pixels, 15 columns by 4 rows of half blocks. */
export const GRID: Readonly<Record<MascotSize, { readonly width: number; readonly height: number }>> = {
  full: { width: SIZE, height: SIZE },
  mini: { width: 15, height: 8 },
};
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
  G: 0x7a8099,
  S: 0xc4c8d6,
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
const SAD: Layer = [[10, 5, "bb..bb"], [13, 6, "m..m"]];
// The props crowd the right side, so the sweat beads on the left temple.
const SWEAT: Layer = [[7, 2, "C"], [8, 2, "U"]];
const SPARKLE: Layer = [[0, 13, "Y"], [1, 12, "YWY"], [2, 13, "Y"], [5, 1, "Y"]];
const SNORE: Layer = [[1, 0, "ZZZZ"], [2, 2, "Z"], [3, 1, "Z"], [4, 0, "ZZZZ"]];

/** The shared layers, for the art invariants. The floating ones (sweat, sparkle, snore) must stay clear of every prop. */
export const LAYERS = { body: BODY, blink: BLINK, happy: HAPPY, sad: SAD, sweat: SWEAT, sparkle: SPARKLE, snore: SNORE } as const;

export const MASCOTS = {
  orchestrator: {
    body: 0x7f7ff5,
    props: [[4, 8, "o"], [5, 7, "o"]],
    poseA: [[11, 13, "b"], [10, 14, "G"], [9, 15, "S"], [8, 15, "S"], [3, 14, "Y"], [4, 14, "Y"], [5, 13, "YY"]],
    poseB: [[12, 13, "bGS"], [13, 15, "S"], [1, 15, "Y"], [2, 15, "Y"], [3, 14, "YY"], [4, 1, "Y"], [5, 1, "Y"], [6, 0, "YY"]],
  },
  planner: {
    body: 0x4ccbdd,
    props: [[9, 1, "G"], [10, 0, "GNN"], [11, 0, "KKN"], [12, 0, "GNN"], [13, 0, "KKN"], [14, 0, "GNN"]],
    poseA: [[11, 2, "V"], [11, 13, "b"], [10, 14, "Y"], [9, 15, "Y"]],
    poseB: [[11, 2, "V"], [13, 2, "V"], [12, 13, "b"], [11, 14, "Y"], [10, 15, "Y"]],
  },
  analyzer: {
    body: 0xf7d660,
    props: [[11, 2, "V"], [12, 1, "YV"], [13, 0, "RYV"]],
    poseA: [[8, 14, "G"], [9, 13, "GCG"], [10, 14, "G"], [11, 14, "B"], [12, 14, "B"]],
    poseB: [[9, 10, "G"], [10, 9, "GCG"], [11, 10, "G"], [12, 12, "B"], [13, 13, "B"]],
  },
  reviewer: {
    body: 0xf2716b,
    props: [[14, 12, "GNNN"], [15, 12, "GNNN"]],
    poseA: [[8, 14, "B"], [9, 14, "B"], [10, 13, "GGG"], [11, 13, "KKK"], [14, 13, "RR"]],
    poseB: [[11, 14, "B"], [12, 14, "B"], [13, 13, "GGG"], [14, 13, "KKK"]],
  },
  executor: {
    body: 0x5ccb80,
    props: [[4, 6, "YOOY"], [5, 5, "YYYYYY"], [6, 4, "YYYYYYYY"]],
    poseA: [[12, 13, "bb"], [11, 14, "B"], [10, 14, "B"], [9, 13, "GGG"]],
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
    // The bulb stays lit so it reads as one at rest; its rays glow only while the architect works.
    poseA: [],
    poseB: [[1, 5, "Y"], [1, 10, "Y"], [3, 4, "Y"], [3, 11, "Y"]],
  },
  "build-fixer": {
    body: 0xc9a24a,
    props: [[8, 4, "KCCKKCCK"]],
    poseA: [[8, 13, "S.S"], [9, 13, "SSS"], [10, 14, "G"], [11, 14, "G"], [12, 13, "bG"]],
    poseB: [[10, 14, "GS"], [11, 13, "GG"], [12, 14, "GS"], [8, 15, "Y"]],
  },
  viewer: {
    body: 0xf784c2,
    props: [[9, 13, "G"], [10, 12, "KGGG"], [11, 12, "KSCG"], [12, 12, "KGGG"]],
    poseA: [],
    poseB: [[8, 14, "W"], [7, 13, "Y.Y"], [9, 15, "Y"]],
  },
} as const satisfies Record<string, Spec>;

export type MascotName = keyof typeof MASCOTS;

type Pose = Omit<Spec, "body">;

// A mini is the full pebble without its second highlight row and its lower belly row, its tool in the
// three columns at its right and its sweat or sparkle in the free column at its left.
const MINI_BODY: Layer = [
  [0, 4, "oooooo"],
  [1, 3, "obbbbbbo"],
  [2, 2, "obllbbbbbo"],
  [3, 2, "obewbbewbo"],
  [4, 2, "obeebbeebo"],
  [5, 2, "opbbmmbbpo"],
  [6, 3, "obbbbbbo"],
  [7, 4, "oo..oo"],
];
const MINI_BLINK: Layer = [[3, 4, "bb..bb"]];
const MINI_HAPPY: Layer = [[3, 4, "ebbbbe"], [4, 3, "ebebbebe"]];
const MINI_SAD: Layer = [[6, 5, "m..m"]];
const MINI_SWEAT: Layer = [[2, 0, "C"], [3, 0, "U"]];
const MINI_SPARKLE: Layer = [[2, 0, "Y"], [3, 0, "W"], [4, 0, "Y"]];

/** The mini's shared layers, for the art invariants. */
export const MINI_LAYERS = { body: MINI_BODY, blink: MINI_BLINK, happy: MINI_HAPPY, sad: MINI_SAD, sweat: MINI_SWEAT, sparkle: MINI_SPARKLE } as const;

export const MINIS = {
  orchestrator: { props: [], poseA: [[4, 12, "b"], [3, 13, "S"], [2, 14, "W"]], poseB: [[4, 12, "b"], [5, 13, "S"], [6, 14, "W"]] },
  planner: { props: [[3, 12, "BGB"], [4, 12, "BNN"], [5, 12, "BKK"], [6, 12, "BNN"], [7, 12, "BKK"]], poseA: [[5, 13, "V"]], poseB: [[5, 13, "V"], [7, 13, "V"]] },
  analyzer: { props: [], poseA: [[4, 12, "b"], [2, 13, "G"], [3, 12, "GCG"], [4, 13, "G"], [5, 14, "B"]], poseB: [[3, 12, "b"], [1, 13, "G"], [2, 12, "GCG"], [3, 13, "G"], [4, 14, "B"]] },
  reviewer: { props: [[6, 12, "NNN"], [7, 12, "NNN"]], poseA: [[1, 12, "BBB"], [2, 13, "B"], [3, 12, "GGG"], [6, 13, "R"]], poseB: [[3, 12, "BBB"], [4, 13, "B"], [5, 12, "GGG"]] },
  executor: { props: [[0, 5, "YOOY"], [1, 3, "YYYYYYYY"]], poseA: [[4, 12, "b"], [3, 13, "B"], [2, 13, "B"], [1, 12, "GGG"]], poseB: [[4, 12, "bB"], [3, 14, "G"], [4, 14, "G"], [5, 14, "G"]] },
  explorer: { props: [[0, 4, "TTTTTT"], [1, 2, "TTBBBBBBTT"]], poseA: [[3, 11, "SSGC"], [2, 14, "G"], [4, 14, "G"]], poseB: [[4, 11, "SSGC"], [3, 14, "G"], [5, 14, "G"]] },
  researcher: {
    props: [[3, 3, "S"], [4, 3, "S"], [3, 6, "SS"], [3, 10, "S"], [4, 10, "S"], [5, 12, "VVN"], [6, 12, "UUN"], [7, 12, "RRN"]],
    poseA: [[4, 12, "b"]],
    poseB: [[4, 12, "NNN"]],
  },
  architect: { props: [[0, 12, "WYY"], [1, 12, "YYY"], [2, 13, "Y"], [3, 13, "G"]], poseA: [], poseB: [[1, 13, "W"]] },
  "build-fixer": {
    props: [[1, 3, "KCCKKCCK"]],
    poseA: [[2, 12, "S.S"], [3, 12, "SSS"], [4, 13, "G"], [5, 13, "G"], [5, 12, "b"]],
    poseB: [[3, 12, "S.S"], [4, 12, "SSS"], [5, 13, "G"], [6, 13, "G"], [6, 12, "b"], [1, 13, "Y"]],
  },
  viewer: { props: [[2, 12, "G"], [3, 12, "GGG"], [4, 12, "GCG"], [5, 12, "GGG"]], poseA: [], poseB: [[1, 14, "W"], [0, 13, "Y"], [2, 14, "Y"]] },
} as const satisfies Record<MascotName, Pose>;

const shade = (rgb: Rgb, f: number): Rgb =>
  (Math.round(((rgb >> 16) & 255) * f) << 16) | (Math.round(((rgb >> 8) & 255) * f) << 8) | Math.round((rgb & 255) * f);
const tint = (rgb: Rgb, f: number): Rgb => {
  const up = (c: number) => Math.round(c + (255 - c) * f);
  return (up((rgb >> 16) & 255) << 16) | (up((rgb >> 8) & 255) << 8) | up(rgb & 255);
};

export function paletteOf(spec: Spec): Readonly<Record<string, Rgb>> {
  return { ...SHARED, b: spec.body, o: shade(spec.body, 0.55), l: tint(spec.body, 0.5) };
}

function paint(grid: (Rgb | null)[][], layer: Layer, palette: Readonly<Record<string, Rgb>>): void {
  const width = grid[0]?.length ?? 0;
  for (const [y, x0, pixels] of layer) {
    for (let i = 0; i < pixels.length; i++) {
      const key = pixels[i];
      if (key === undefined || key === ".") continue;
      const color = palette[key];
      const row = grid[y];
      if (color === undefined || row === undefined || x0 + i >= width) continue;
      row[x0 + i] = color;
    }
  }
}

function compose(spec: Spec, layers: readonly Layer[], lift: number, size: MascotSize = "full"): Frame {
  const { width, height } = GRID[size];
  const palette = paletteOf(spec);
  const grid: (Rgb | null)[][] = Array.from({ length: height }, () => Array<Rgb | null>(width).fill(null));
  for (const layer of layers) paint(grid, layer, palette);
  return lift === 0 ? grid : [...grid.slice(lift), ...Array.from({ length: lift }, () => Array<Rgb | null>(width).fill(null))];
}

export const WORKING_FRAMES = 12;
export const FRAME_MS = 170;

const framesCache = new Map<string, Frame[]>();

export function framesOf(name: MascotName, state: MascotState, size: MascotSize = "full"): Frame[] {
  const key = `${name}:${state}:${size}`;
  let frames = framesCache.get(key);
  if (frames === undefined) {
    frames = size === "full" ? buildFrames(name, state) : buildMiniFrames(name, state);
    framesCache.set(key, frames);
  }
  return frames;
}

// A mini does not hop: its head sits on the top row, so it swaps poses and blinks instead.
function buildMiniFrames(name: MascotName, state: MascotState): Frame[] {
  const spec: Spec = MASCOTS[name];
  const pose: Pose = MINIS[name];
  const mini = (layers: readonly Layer[]) => compose(spec, layers, 0, "mini");
  switch (state) {
    case "working":
      return Array.from({ length: WORKING_FRAMES }, (_, i) => {
        const eyes = i === WORKING_FRAMES - 3 ? [MINI_BLINK] : [];
        return mini([MINI_BODY, ...eyes, pose.props, Math.floor(i / 2) % 2 === 0 ? pose.poseA : pose.poseB]);
      });
    case "done":
      return [mini([MINI_BODY, MINI_HAPPY, pose.props, pose.poseA, MINI_SPARKLE])];
    case "failed":
      return [mini([MINI_BODY, MINI_SAD, pose.props, pose.poseA, MINI_SWEAT])];
    case "idle":
      return [mini([MINI_BODY, MINI_BLINK, pose.props, pose.poseA])];
  }
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
      return [compose(spec, [...base, HAPPY, spec.poseA, SPARKLE], 0)];
    case "failed":
      return [compose(spec, [...base, SAD, spec.poseA, SWEAT], 0)];
    case "idle":
      return [compose(spec, [...base, BLINK, spec.poseA, SNORE], 0)];
  }
}

const hex = (rgb: Rgb) => `#${rgb.toString(16).padStart(6, "0")}`;

function rects(frame: Frame): string {
  let out = "";
  frame.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const color = row[x] ?? null;
      let end = x + 1;
      while (end < row.length && (row[end] ?? null) === color) end++;
      if (color !== null) out += `<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${hex(color)}"/>`;
      x = end;
    }
  });
  return out;
}

const svgCache = new WeakMap<readonly Frame[], Map<number, string>>();
const STILL = 0;

/** The frames as one SVG, animated when there are several; `isStill` draws the first frame alone. */
export function svgOf(frames: readonly Frame[], frameMs = FRAME_MS, isStill = false): string {
  let byMs = svgCache.get(frames);
  if (byMs === undefined) svgCache.set(frames, (byMs = new Map()));
  const key = isStill ? STILL : frameMs;
  let svg = byMs.get(key);
  if (svg === undefined) byMs.set(key, (svg = buildSvg(isStill ? frames.slice(0, 1) : frames, frameMs)));
  return svg;
}

function buildSvg(frames: readonly Frame[], frameMs: number): string {
  const height = frames[0]?.length ?? SIZE;
  const width = frames[0]?.[0]?.length ?? SIZE;
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">`;
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
const SPACE = 0x20;

const rasterCache = new WeakMap<Frame, string>();

/** One frame as Raster cells: a column per pixel and a row per two pixels, each [codePoint, fg, bg] as little-endian u32. */
export function rasterCells(frame: Frame): string {
  let cells = rasterCache.get(frame);
  if (cells === undefined) rasterCache.set(frame, (cells = buildRaster(frame)));
  return cells;
}

function buildRaster(frame: Frame): string {
  const columns = frame[0]?.length ?? SIZE;
  const rows = frame.length / 2;
  const bytes = new Uint8Array(columns * rows * 12);
  const view = new DataView(bytes.buffer);
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < columns; x++) {
      const top = frame[r * 2]?.[x] ?? null;
      const bottom = frame[r * 2 + 1]?.[x] ?? null;
      // A solid cell is a space on its background: no glyph to misalign, and no foreground equal
      // to its background for a terminal's minimum-contrast setting to repaint.
      const [glyph, fg, bg] =
        top !== null && top === bottom
          ? [SPACE, TERMINAL_DEFAULT, top]
          : top !== null
            ? [UPPER_HALF, top, bottom ?? TERMINAL_DEFAULT]
            : bottom !== null
              ? [LOWER_HALF, bottom, TERMINAL_DEFAULT]
              : [SPACE, TERMINAL_DEFAULT, TERMINAL_DEFAULT];
      const at = (r * columns + x) * 12;
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
