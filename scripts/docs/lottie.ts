import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compose, framesOf, LAYERS, MASCOTS, paletteOf, PLAIN_FRAME, type Frame, type MascotName, type Rgb } from "../../src/core/mascots.ts";

const ROOT = join(import.meta.dir, "..", "..");
const OUT = join(ROOT, "video", "public", "lottie");

const FPS = 60;
/** Frames one mascot frame stays up, so a 12-frame working cycle is 120 frames. */
export const HOLD = 10;
export const IDENT_STAGGER = 6;
export const IDENT_FRAMES = 210;
const MARK_FRAMES = 240;
const RISE_FRAMES = 24;
const RISE_PX = 40;
const FADE_FRAMES = 12;

type Handle = { x: number[]; y: number[] };
export type Keyframe = { t: number; s: number[]; h?: 1; o?: Handle; i?: Handle };
export type Value = { a: 0; k: number | number[] } | { a: 1; k: Keyframe[] };
export type Rect = { ty: "rc"; nm: string; p: Value; s: Value; r: Value };
type Fill = { ty: "fl"; c: Value; o: Value };
type Transform = { ty: "tr"; p: Value; a: Value; s: Value; r: Value; o: Value; sk: Value; sa: Value };
export type Group = { ty: "gr"; nm: string; it: Shape[] };
type Shape = Rect | Fill | Transform | Group;
export type Layer = {
  ty: 4;
  nm: string;
  ip: number;
  op: number;
  st: 0;
  ks: { o: Value; r: Value; a: Value; s: Value; p: Value };
  shapes: Shape[];
};
type Lottie = {
  v: string;
  fr: number;
  ip: 0;
  op: number;
  w: number;
  h: number;
  nm: string;
  ddd: 0;
  assets: [];
  layers: Layer[];
};

const outlineOf = (name: MascotName): Rgb => {
  const outline = paletteOf(MASCOTS[name]).o;
  if (outline === undefined) throw new Error(`${name} has no outline colour`);
  return outline;
};

type Box = { x: number; y: number; w: number; h: number };

const still = (k: number | number[]): Value => ({ a: 0, k });
const rgbOf = (rgb: Rgb): number[] => [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255].map((c) => c / 255).concat(1);

function runsOf<T>(row: readonly T[]): [x0: number, x1: number, key: T][] {
  const runs: [number, number, T][] = [];
  let x = 0;
  while (x < row.length) {
    const key = row[x] as T;
    let end = x + 1;
    while (end < row.length && row[end] === key) end++;
    runs.push([x, end, key]);
    x = end;
  }
  return runs;
}

/** One box per run of a colour, a run repeated on the next row folded into a taller box. */
function colourBoxes(frame: Frame): Map<Rgb, Box[]> {
  const byColour = new Map<Rgb, Box[]>();
  let open = new Map<string, Box>();
  frame.forEach((row, y) => {
    const next = new Map<string, Box>();
    for (const [x0, x1, color] of runsOf(row)) {
      if (color === null) continue;
      const id = `${color}:${x0}:${x1}`;
      let box = open.get(id);
      if (box === undefined) {
        box = { x: x0, y, w: x1 - x0, h: 0 };
        byColour.set(color, [...(byColour.get(color) ?? []), box]);
      }
      box.h++;
      next.set(id, box);
    }
    open = next;
  });
  return byColour;
}

/** Row runs of the opaque cells, each overlapped two rows deep where the row below is opaque too, so no seam shows between rows. */
function silhouetteBoxes(frame: Frame): Box[] {
  const rows = frame.map((row) => runsOf(row.map((c) => c !== null)).filter(([, , opaque]) => opaque));
  const boxes: Box[] = [];
  rows.forEach((runs, y) => {
    for (const [x0, x1] of runs) {
      boxes.push({ x: x0, y, w: x1 - x0, h: 1 });
      for (const [b0, b1] of rows[y + 1] ?? []) {
        const a = Math.max(x0, b0);
        const b = Math.min(x1, b1);
        if (a < b) boxes.push({ x: a, y, w: b - a, h: 2 });
      }
    }
  });
  return boxes;
}

const identity = (opacity: Value): Transform => ({
  ty: "tr",
  p: still([0, 0]),
  a: still([0, 0]),
  s: still([100, 100]),
  r: still(0),
  o: opacity,
  sk: still(0),
  sa: still(0),
});

function paintGroup(nm: string, boxes: readonly Box[], color: Rgb, cell: number): Group {
  const rects = boxes.map(
    (b): Rect => ({
      ty: "rc",
      nm: "cells",
      p: still([(b.x + b.w / 2) * cell, (b.y + b.h / 2) * cell]),
      s: still([b.w * cell, b.h * cell]),
      r: still(0),
    }),
  );
  return { ty: "gr", nm, it: [...rects, { ty: "fl", c: still(rgbOf(color)), o: still(100) }, identity(still(100))] };
}

/** One frame as a group: a colour group per colour over the silhouette, the group's opacity a hold keyframe at each change. */
function frameGroup(frame: Frame, index: number, outline: Rgb, cell: number, changes: readonly (readonly [t: number, frame: number])[]): Group {
  const colours = [...colourBoxes(frame)].map(([color, boxes]) => paintGroup(`#${color.toString(16).padStart(6, "0")}`, boxes, color, cell));
  const opacity: Value = { a: 1, k: changes.map(([t, shown]): Keyframe => ({ t, s: [shown === index ? 100 : 0], h: 1 })) };
  return { ty: "gr", nm: `frame ${index}`, it: [...colours, paintGroup("silhouette", silhouetteBoxes(frame), outline, cell), identity(opacity)] };
}

type Sprite = {
  nm: string;
  frames: readonly Frame[];
  outline: Rgb;
  cell: number;
  changes: readonly (readonly [t: number, frame: number])[];
  ip: number;
  op: number;
  position: Value;
  opacity: Value;
};

function spriteLayer(s: Sprite): Layer {
  return {
    ty: 4,
    nm: s.nm,
    ip: s.ip,
    op: s.op,
    st: 0,
    ks: { o: s.opacity, r: still(0), a: still([0, 0, 0]), s: still([100, 100, 100]), p: s.position },
    shapes: s.frames.map((frame, index) => frameGroup(frame, index, s.outline, s.cell, s.changes)),
  };
}

function document(nm: string, w: number, h: number, op: number, layers: Layer[]): Lottie {
  return { v: "5.7.0", fr: FPS, ip: 0, op, w, h, nm, ddd: 0, assets: [], layers };
}

export const MARK_CELL = 40;
export const MARK_ORIGIN = { column: 3, row: 5, x: 56, y: 36 } as const;
const MARK_SIZE = 512;
/** [frame, shown index] at each change: rest, blink, rest, two hops. Index 0 is rest, 1 blink, 2 hop. */
const MARK_CHANGES = [[0, 0], [90, 1], [100, 0], [160, 2], [170, 0], [180, 2], [190, 0]] as const;

export function buildMark(): Lottie {
  const spec = MASCOTS.orchestrator;
  const frames = [PLAIN_FRAME, compose(spec, [LAYERS.body, LAYERS.blink], 0), compose(spec, [LAYERS.body], 1)];
  const { column, row, x, y } = MARK_ORIGIN;
  const layer = spriteLayer({
    nm: "pebble",
    frames,
    outline: outlineOf("orchestrator"),
    cell: MARK_CELL,
    changes: MARK_CHANGES,
    ip: 0,
    op: MARK_FRAMES,
    position: still([x - column * MARK_CELL, y - row * MARK_CELL]),
    opacity: still(100),
  });
  return document("OMCA mark", MARK_SIZE, MARK_SIZE, MARK_FRAMES, [layer]);
}

export const IDENT_CELL = 10;
const IDENT_PITCH = 192;
const IDENT_SIZE = { w: 1920, h: 540 } as const;

export function buildIdent(): Lottie {
  const names = Object.keys(MASCOTS) as MascotName[];
  const sprite = IDENT_CELL * 16;
  const left = (IDENT_SIZE.w - ((names.length - 1) * IDENT_PITCH + sprite)) / 2;
  const top = (IDENT_SIZE.h - sprite) / 2;
  const layers = names.map((name, i) => {
    const start = IDENT_STAGGER * i;
    const x = left + IDENT_PITCH * i;
    const changes: [number, number][] = [];
    for (let n = 0; start + HOLD * n < IDENT_FRAMES; n++) changes.push([start + HOLD * n, n % 12]);
    return spriteLayer({
      nm: name,
      frames: framesOf(name, "working"),
      outline: outlineOf(name),
      cell: IDENT_CELL,
      changes,
      ip: start,
      op: IDENT_FRAMES,
      position: {
        a: 1,
        k: [
          { t: start, s: [x, top + RISE_PX], o: { x: [0.16], y: [1] } },
          { t: start + RISE_FRAMES, s: [x, top], i: { x: [0.3], y: [1] } },
        ],
      },
      opacity: {
        a: 1,
        k: [
          { t: start, s: [0], o: { x: [0], y: [0] } },
          { t: start + FADE_FRAMES, s: [100], i: { x: [1], y: [1] } },
        ],
      },
    });
  });
  return document("OMCA ident", IDENT_SIZE.w, IDENT_SIZE.h, IDENT_FRAMES, layers);
}

if (import.meta.main) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "omca-mark.json"), JSON.stringify(buildMark()));
  writeFileSync(join(OUT, "omca-ident.json"), JSON.stringify(buildIdent()));
}
