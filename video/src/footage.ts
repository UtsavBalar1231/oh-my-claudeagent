// Mirrors scripts/docs/clip-manifest.ts, which writes <scene>.json beside each clip; the JSON is the
// contract, so the two projects share no import.
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

export type Rect = { x: number; y: number; width: number; height: number };

export const targetRect = (manifest: Pick<ClipManifest, "cell" | "origin">, target: Pick<ClipTarget, "row" | "col" | "len" | "rows">): Rect => ({
  x: manifest.origin.x + target.col * manifest.cell.width,
  y: manifest.origin.y + target.row * manifest.cell.height,
  width: target.len * manifest.cell.width,
  height: target.rows * manifest.cell.height,
});

export const target = (manifest: ClipManifest, name: string): ClipTarget => {
  const found = manifest.targets[name];
  if (found === undefined) throw new Error(`${manifest.scene} has no target "${name}"`);
  return found;
};

/** A mark's footage frame converted to the composition's frame rate, at 1x playback. */
export const markFrame = (manifest: ClipManifest, name: string, fps: number): number => {
  const at = manifest.marks[name];
  if (at === undefined) throw new Error(`${manifest.scene} has no mark "${name}"`);
  return Math.round((at * fps) / manifest.fps);
};
