import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framesOf, MASCOTS, PLAIN_FRAME, SIZE, type Frame, type Rgb } from "../../src/core/mascots.ts";
import {
  buildIdent,
  buildMark,
  HOLD,
  IDENT_CELL,
  IDENT_FRAMES,
  IDENT_STAGGER,
  MARK_CELL,
  MARK_ORIGIN,
  type Group,
  type Keyframe,
  type Layer,
  type Rect,
  type Value,
} from "./lottie.ts";

const AGENTS = join(import.meta.dir, "..", "..", "agents");

const cellKey = (x: number, y: number) => `${x},${y}`;

function frameGroups(layer: Layer): Group[] {
  return layer.shapes.filter((shape): shape is Group => shape.ty === "gr");
}

function holdKeyframes(value: Value): Keyframe[] {
  if (value.a !== 1) throw new Error("expected an animated value");
  return value.k;
}

function restAt(layer: Layer): [x: number, y: number] {
  const [x = 0, y = 0] = holdKeyframes(layer.ks.p)[1]?.s ?? [];
  return [x, y];
}

function opacityOf(group: Group): Value {
  const transform = group.it.find((item) => item.ty === "tr");
  if (transform?.ty !== "tr") throw new Error(`${group.nm} has no transform`);
  return transform.o;
}

/** The cells a frame group paints, per colour, read back from its rects. The silhouette is returned apart. */
function paintedCells(group: Group, cell: number): { byColour: Map<Rgb, Set<string>>; silhouette: Set<string> } {
  const byColour = new Map<Rgb, Set<string>>();
  const silhouette = new Set<string>();
  for (const sub of group.it) {
    if (sub.ty !== "gr") continue;
    const fill = sub.it.find((item) => item.ty === "fl");
    if (fill?.ty !== "fl" || fill.c.a !== 0 || typeof fill.c.k === "number") throw new Error(`${sub.nm} has no fill`);
    const [r = 0, g = 0, b = 0] = fill.c.k.map((c) => Math.round(c * 255));
    const color = (r << 16) | (g << 8) | b;
    const cells = sub.nm === "silhouette" ? silhouette : (byColour.get(color) ?? new Set<string>());
    if (sub.nm !== "silhouette") byColour.set(color, cells);
    for (const rect of sub.it.filter((item): item is Rect => item.ty === "rc")) {
      if (rect.p.a !== 0 || rect.s.a !== 0 || typeof rect.p.k === "number" || typeof rect.s.k === "number") throw new Error("expected still rects");
      const [cx = 0, cy = 0] = rect.p.k;
      const [w = 0, h = 0] = rect.s.k;
      const x0 = (cx - w / 2) / cell;
      const y0 = (cy - h / 2) / cell;
      for (const v of [x0, y0, w / cell, h / cell]) expect(Number.isInteger(v)).toBe(true);
      for (let y = y0; y < y0 + h / cell; y++) for (let x = x0; x < x0 + w / cell; x++) cells.add(cellKey(x, y));
    }
  }
  return { byColour, silhouette };
}

function cellsOfFrame(frame: Frame, inCrop: (x: number, y: number) => boolean = () => true): Map<Rgb, Set<string>> {
  const byColour = new Map<Rgb, Set<string>>();
  frame.forEach((row, y) =>
    row.forEach((color, x) => {
      if (color === null || !inCrop(x, y)) return;
      byColour.set(color, (byColour.get(color) ?? new Set()).add(cellKey(x, y)));
    }),
  );
  return byColour;
}

describe("mark", () => {
  const mark = buildMark();
  const layer = mark.layers[0] as Layer;

  test("is a 512 square of 240 frames at 60 fps", () => {
    expect(mark).toMatchObject({ w: 512, h: 512, fr: 60, ip: 0, op: 240 });
    expect(mark.layers).toHaveLength(1);
  });

  test("places the crop of columns 3 to 12 and rows 5 to 15 at 56, 36", () => {
    expect(layer.ks.p).toEqual({ a: 0, k: [56 - 3 * MARK_CELL, 36 - 5 * MARK_CELL] });
    expect(MARK_ORIGIN).toMatchObject({ column: 3, row: 5, x: 56, y: 36 });
  });

  test("its rest frame covers, per colour, the cells PLAIN_FRAME paints in the crop", () => {
    const groups = frameGroups(layer);
    const rest = groups.find((group) => holdKeyframes(opacityOf(group))[0]?.s[0] === 100);
    if (rest === undefined) throw new Error("no group shows at frame 0");
    const { byColour, silhouette } = paintedCells(rest, MARK_CELL);
    const expected = cellsOfFrame(PLAIN_FRAME, (x, y) => x >= 3 && x <= 12 && y >= 5 && y <= 15);
    expect(byColour).toEqual(expected);
    const all = new Set([...expected.values()].flatMap((cells) => [...cells]));
    expect(silhouette).toEqual(all);
  });

  test("holds each state at its frame and loops back to rest", () => {
    const shown = (group: Group) => holdKeyframes(opacityOf(group)).filter((k) => k.s[0] === 100).map((k) => k.t);
    const [rest, blink, hop] = frameGroups(layer).map(shown);
    expect(blink).toEqual([90]);
    expect(rest).toEqual([0, 100, 170, 190]);
    expect(hop).toEqual([160, 180]);
    expect(holdKeyframes(opacityOf(frameGroups(layer)[0] as Group)).every((k) => k.h === 1)).toBe(true);
  });
});

describe("ident", () => {
  const ident = buildIdent();
  const names = Object.keys(MASCOTS);

  test("is 1920x540 of 210 frames at 60 fps", () => {
    expect(ident).toMatchObject({ w: 1920, h: 540, fr: 60, ip: 0, op: 210 });
  });

  test("starts mascot i at frame 6i", () => {
    ident.layers.forEach((layer, i) => {
      expect(layer.ip).toBe(IDENT_STAGGER * i);
      expect(layer.op).toBe(IDENT_FRAMES);
    });
  });

  test("rises over 24 frames from 40 px below and fades in over 12", () => {
    ident.layers.forEach((layer, i) => {
      const start = IDENT_STAGGER * i;
      const rise = holdKeyframes(layer.ks.p);
      expect(rise.map((k) => k.t)).toEqual([start, start + 24]);
      expect((rise[0]?.s[1] ?? 0) - (rise[1]?.s[1] ?? 0)).toBe(40);
      expect(rise[0]?.s[0]).toBe(rise[1]?.s[0]);
      const fade = holdKeyframes(layer.ks.o);
      expect(fade.map((k) => [k.t, k.s[0]])).toEqual([[start, 0], [start + 12, 100]]);
      // lottie-web reads a segment's easing from its first keyframe and draws nothing when it is missing there.
      for (const [from, to] of [rise, fade]) expect([from?.o !== undefined, from?.i !== undefined, to?.o ?? to?.i]).toEqual([true, true, undefined]);
    });
  });

  test("each mascot's hold keyframes fall at 6i + 10n and show the working frame", () => {
    ident.layers.forEach((layer, i) => {
      const name = names[i] as keyof typeof MASCOTS;
      const start = IDENT_STAGGER * i;
      const times: number[] = [];
      for (let n = 0; start + HOLD * n < IDENT_FRAMES; n++) times.push(start + HOLD * n);
      const working = framesOf(name, "working");
      const groups = frameGroups(layer);
      expect(groups).toHaveLength(working.length);
      groups.forEach((group, f) => {
        const keys = holdKeyframes(opacityOf(group));
        expect(keys.map((k) => k.t)).toEqual(times);
        expect(keys.every((k) => k.h === 1)).toBe(true);
        keys.forEach((k, n) => expect(k.s[0]).toBe(n % working.length === f ? 100 : 0));
        const { byColour, silhouette } = paintedCells(group, IDENT_CELL);
        const expected = cellsOfFrame(working[f] as Frame);
        expect(byColour).toEqual(expected);
        expect(silhouette).toEqual(new Set([...expected.values()].flatMap((cells) => [...cells])));
      });
    });
  });

  test("lays the row 192 px apart, centred", () => {
    const rests = ident.layers.map(restAt);
    rests.slice(1).forEach(([x], i) => expect(x - (rests[i]?.[0] ?? 0)).toBe(192));
    const sprite = SIZE * IDENT_CELL;
    const [x, y] = rests[0] ?? [0, 0];
    expect(x * 2 + 9 * 192 + sprite).toBe(1920);
    expect(y * 2 + sprite).toBe(540);
  });

  test("draws the agents of agents/*.md", () => {
    const agents = readdirSync(AGENTS)
      .filter((file) => file.endsWith(".md"))
      .map((file) => /^name:\s*(\S+)\s*$/m.exec(readFileSync(join(AGENTS, file), "utf8"))?.[1])
      .filter((name): name is string => name !== undefined);
    expect(ident.layers.map((layer) => layer.nm).sort()).toEqual(agents.sort());
  });
});
