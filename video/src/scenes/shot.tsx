import type { ReactNode } from "react";
import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import { baseScale, Camera, type CameraKeyframe, type View } from "../components/Camera.tsx";
import type { ClipManifest, Rect } from "../footage.ts";
import { color, toFrames } from "../theme.ts";

// The room for a footage window: the band under it holds captions, so they never sit on footage.
const STAGE: Rect = { x: 96, y: 106, width: 1728, height: 756 };

/** A window of whole cells at `scale`, centered in the stage, so its edges fall on cell boundaries. */
export const cellBox = (clip: ClipManifest, cols: number, rows: number, scale = 1): Rect => {
  const width = cols * clip.cell.width * scale;
  const height = rows * clip.cell.height * scale;
  if (width > STAGE.width || height > STAGE.height) throw new Error(`${cols}x${rows} cells at ${scale} do not fit the stage`);
  return { x: STAGE.x + Math.round((STAGE.width - width) / 2), y: STAGE.y + Math.round((STAGE.height - height) / 2), width, height };
};

// For the 214x50 captures: the transcript window shows the capture's left margin and 95 columns,
// the pane window starts where the OMCA pane's background does (column 118, measured at x = 2140
// in each pane clip). The pane window leaves out the grid's last column, which holds only the
// pane's close mark, and is 18 rows high.
const WINDOW_ROWS = 19;
export const TRANSCRIPT_COLS = 95;
export const PANE_COL = 118;
const PANE_ROWS = 18;
export const paneCols = (clip: ClipManifest): number => clip.grid.cols - 1 - PANE_COL;

/** The fractional column at the capture's left edge, so a view can start on its margin rather than cut into column 0. */
export const marginCol = (clip: ClipManifest): number => -clip.origin.x / clip.cell.width;

/** The transcript window: the capture's left margin plus whole columns, whole rows high. */
export const transcriptBox = (clip: ClipManifest): Rect => {
  const box = cellBox(clip, TRANSCRIPT_COLS, WINDOW_ROWS);
  const width = box.width + clip.origin.x;
  return { ...box, x: STAGE.x + Math.round((STAGE.width - width) / 2), width };
};

/** The pane window for the 214x50 captures at 1.0. */
export const paneBox = (clip: ClipManifest): Rect => cellBox(clip, paneCols(clip), PANE_ROWS);

/**
 * A window as wide as the whole terminal, for the 96x34 captures: they wrap every line inside the
 * terminal, so fitting its width crops no text. It is WINDOW_ROWS rows high at that scale.
 */
export const fitWidth = (clip: ClipManifest): { box: Rect; scale: number } => {
  const scale = STAGE.width / clip.width;
  const height = WINDOW_ROWS * clip.cell.height * scale;
  return { box: { x: STAGE.x, y: STAGE.y + (STAGE.height - height) / 2, width: STAGE.width, height }, scale };
};

// Beats overlap by this crossfade, so text that must not double up with the next or previous
// beat's text enters after it and leaves before it.
const CROSSFADE = 0.33;
export const crossfadeFrames = (fps: number): number => toFrames(CROSSFADE, fps);

/** A beat's length for a shot-list span: every beat but the last overlaps the next by the crossfade. */
export const beatLength = (span: number): number => span + CROSSFADE;

/** A beat-long caption, clear of the crossfades at both ends so two captions never overlap. */
export const captionSpan = (beatDuration: number, fps: number) => {
  const edge = crossfadeFrames(fps);
  const from = edge + toFrames(0.1, fps);
  return { from, duration: beatDuration - from - edge };
};

export type Segment = { start: number; duration: number; trimBefore: number; rate: number; hold: boolean };

/**
 * A beat's footage as consecutive segments. `from`, `to` and `at` are frames in the clip's own
 * rate, taken from its marks; the segments come out in composition frames, back to back.
 */
export const timeline = (clip: ClipManifest, fps: number) => {
  const segments: Segment[] = [];
  let end = 0;
  const add = (at: number, duration: number, rate: number, hold: boolean): Segment => {
    if (at < 0 || at >= clip.frames) throw new Error(`${clip.scene} has no frame ${at}`);
    const segment = { start: end, duration, trimBefore: Math.round((at * fps) / clip.fps), rate, hold };
    segments.push(segment);
    end += duration;
    return segment;
  };
  return {
    segments,
    /** Clip frames per second of composition time, for offsets such as "two seconds after a mark". */
    seconds: (s: number) => Math.round(s * clip.fps),
    play: (from: number, to: number, rate = 1) => {
      if (to >= clip.frames) throw new Error(`${clip.scene} ends at frame ${clip.frames - 1}, before ${to}`);
      return add(from, Math.round(((to - from) * fps) / (clip.fps * rate)), rate, false);
    },
    hold: (at: number, seconds: number) => add(at, Math.round(seconds * fps), 1, true),
    /** Holds frame `at` until the beat is `seconds` long, so a re-recorded clip keeps the shot list's timing. */
    fill: (at: number, seconds: number) => {
      const left = Math.round(seconds * fps) - end;
      if (left < 1) throw new Error(`${clip.scene}: the beat already runs ${end} frames, past ${seconds} s`);
      return add(at, left, 1, true);
    },
    get duration() {
      return end;
    },
  };
};

export type Aim = { scale: number; top: number; left: number };

/**
 * The view that shows footage at `scale` composition pixels per footage pixel with grid row `top`
 * at the window's top edge and grid column `left` at its left edge.
 */
export const aim = (clip: ClipManifest, box: Rect, { scale, top, left }: Aim): View => ({
  x: clip.origin.x + left * clip.cell.width + box.width / (2 * scale),
  y: clip.origin.y + top * clip.cell.height + box.height / (2 * scale),
  zoom: scale / baseScale(clip, box),
});

export const wide = (clip: ClipManifest): View => ({ x: clip.width / 2, y: clip.height / 2, zoom: 1 });

/**
 * An establish move on `view`: the plane tilted by `rotateY` and 3 degrees back at 0.84 of fit,
 * drifting 2 degrees toward flat and 3 percent closer between frames `from` and `to`. Callers set
 * `from` before the shot's first frame so the plane is already moving when it cuts in.
 */
export const establish = (view: View, rotateY: number, from: number, to: number): CameraKeyframe[] => [
  { ...view, frame: from, zoom: 0.84, rotateY, rotateX: 3 },
  { ...view, frame: to, zoom: 0.865, rotateY: rotateY - Math.sign(rotateY) * 2, rotateX: 2 },
];

export type ShotProps = {
  clip: ClipManifest;
  keyframes: readonly CameraKeyframe[];
  segments: readonly Segment[];
  box?: Rect;
};

/** Plays a beat's segments through one camera path, so a cut or a speed change keeps the framing. */
export const Shot = ({ clip, keyframes, segments, box = STAGE }: ShotProps) => {
  const { fps } = useVideoConfig();
  return (
    <>
      {segments.map((segment) => (
        <Sequence key={segment.start} from={segment.start} durationInFrames={segment.duration} premountFor={fps}>
          <Camera
            src={`footage/${clip.scene}.mp4`}
            footage={clip}
            keyframes={keyframes.map((k) => ({ ...k, frame: k.frame - segment.start }))}
            durationInFrames={segment.duration}
            trimBefore={segment.trimBefore}
            playbackRate={segment.rate}
            box={box}
            {...(segment.hold ? { freeze: { frame: 0, active: true } } : {})}
          />
        </Sequence>
      ))}
    </>
  );
};

export type TimedProps = { from: number; duration: number; children: ReactNode };

export const Timed = ({ from, duration, children }: TimedProps) => {
  const { fps } = useVideoConfig();
  return (
    <Sequence from={from} durationInFrames={duration} premountFor={fps}>
      {children}
    </Sequence>
  );
};

export const Canvas = ({ children }: { children: ReactNode }) => <AbsoluteFill style={{ background: color.stage }}>{children}</AbsoluteFill>;
