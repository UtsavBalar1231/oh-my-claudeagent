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

/** A mark's frame in the clip's own frame rate. */
export const mark = (manifest: ClipManifest, name: string): number => {
  const at = manifest.marks[name];
  if (at === undefined) throw new Error(`${manifest.scene} has no mark "${name}"`);
  return at;
};

/** A target that must be on screen at footage frame `at`; a re-recorded clip that moves it out of that frame fails loudly. */
export const shownTarget = (manifest: ClipManifest, name: string, at: number): ClipTarget => {
  const found = target(manifest, name);
  if (at < found.from || at > found.to) throw new Error(`${manifest.scene} target "${name}" is shown in frames ${found.from} to ${found.to}, not at ${at}`);
  return found;
};

/** A mark's footage frame converted to the composition's frame rate, at 1x playback. */
export const markFrame = (manifest: ClipManifest, name: string, fps: number): number => Math.round((mark(manifest, name) * fps) / manifest.fps);
