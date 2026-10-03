// The manifest the capture harness writes beside each clip and the video reads. Frame 0 is the
// clip's first encoded frame; every pixel value is in footage pixels.

/** Where a piece of text sat on the terminal grid, and the frames during which it stayed there. */
export type ClipTarget = { row: number; col: number; len: number; rows: number; from: number; to: number };

export type ClipManifest = {
  scene: string;
  fps: number;
  width: number;
  height: number;
  frames: number;
  grid: { cols: number; rows: number };
  cell: { width: number; height: number };
  origin: { x: number; y: number };
  marks: Record<string, number>;
  targets: Record<string, ClipTarget>;
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function object(value: unknown, where: string): Json {
  if (!isObject(value)) throw new Error(`${where} must be an object`);
  return value;
}

function count(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${where} must be a whole number`);
  return value;
}

function numbers<K extends string>(value: unknown, keys: readonly K[], where: string): Record<K, number> {
  const raw = object(value, where);
  const entries = keys.map((key) => [key, count(raw[key], `${where}.${key}`)] as const);
  return Object.fromEntries(entries) as Record<K, number>;
}

function record<T>(value: unknown, where: string, item: (entry: unknown, at: string) => T): Record<string, T> {
  return Object.fromEntries(Object.entries(object(value, where)).map(([name, entry]) => [name, item(entry, `${where}.${name}`)]));
}

export function parseClipManifest(text: string): ClipManifest {
  const raw = object(JSON.parse(text), "the manifest");
  if (typeof raw["scene"] !== "string" || raw["scene"] === "") throw new Error("scene must be a non-empty string");
  const frames = count(raw["frames"], "frames");
  const inClip = (entry: unknown, at: string) => {
    const frame = count(entry, at);
    if (frame >= frames) throw new Error(`${at} is past the last frame`);
    return frame;
  };
  return {
    scene: raw["scene"],
    fps: count(raw["fps"], "fps"),
    width: count(raw["width"], "width"),
    height: count(raw["height"], "height"),
    frames,
    grid: numbers(raw["grid"], ["cols", "rows"], "grid"),
    cell: numbers(raw["cell"], ["width", "height"], "cell"),
    origin: numbers(raw["origin"], ["x", "y"], "origin"),
    marks: record(raw["marks"], "marks", inClip),
    targets: record(raw["targets"], "targets", (entry, at) => {
      const target = numbers(entry, ["row", "col", "len", "rows", "from", "to"], at);
      if (target.to < target.from) throw new Error(`${at} ends before it starts`);
      inClip(target.to, `${at}.to`);
      return target;
    }),
  };
}
