import { Video } from "@remotion/media";
import { AbsoluteFill, Freeze, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { type ClipManifest, type Rect, target } from "../footage.ts";
import { ease, SAFE, VIDEO } from "../theme.ts";

/**
 * Where the camera points: the footage pixel (`x`, `y`) at the window's center, `zoom` relative to
 * fitting the footage in the window, and the plane's tilt in degrees. `target` names the manifest
 * target the camera holds on from this keyframe.
 */
export type View = { x: number; y: number; zoom: number; rotateX?: number; rotateY?: number; target?: string };
export type CameraKeyframe = View & { frame: number };
export type Size = { width: number; height: number };
type Pose = Required<Omit<View, "target">>;

// The plane's radius and shadow are drawn at 1080p and scale with the frame's height.
const PLANE_RADIUS = 14;
const PLANE_SHADOW = (k: number): string => `0 ${16 * k}px ${42 * k}px rgba(0, 0, 0, 0.26)`;
// The camera's distance from the plane in composition heights: about a 28 degree vertical field of view.
const PERSPECTIVE = 2;

// Composition pixels per footage pixel. Above 1.0 the footage is enlarged and its 4:2:0 colour turns
// coarser than the output's.
export const MAX_SCALE = 1;
// A held target's cells are at least 1/30 of the composition height: 36 px at 1080p.
const LEGIBLE_LINES = 30;
// Absorbs float rounding in scales derived from cell and window sizes.
const TOLERANCE = 1e-6;

export const baseScale = (footage: Size, area: Size): number => Math.min(area.width / footage.width, area.height / footage.height);

/** The largest window inside the safe area with the footage's aspect ratio, centered in it. SAFE is set at 1080p and scales with the frame's height. */
export const fitWindow = (footage: Size, frame: Size): Rect => {
  const k = frame.height / VIDEO.height;
  const room = { width: frame.width - 2 * SAFE.x * k, height: frame.height - (SAFE.top + SAFE.bottom) * k };
  const scale = baseScale(footage, room);
  const width = Math.round(footage.width * scale);
  const height = Math.round(footage.height * scale);
  return { x: Math.round((frame.width - width) / 2), y: Math.round(SAFE.top * k + (room.height - height) / 2), width, height };
};

// Zoom eases in log space so each doubling takes the same time.
export const viewAt = (keyframes: readonly CameraKeyframe[], frame: number): Pose => {
  const [first] = keyframes;
  if (first === undefined) throw new Error("Camera needs at least one keyframe");
  const frames = keyframes.map((k) => k.frame);
  const along = (value: (k: CameraKeyframe) => number) =>
    keyframes.length === 1
      ? value(first)
      : interpolate(frame, frames, keyframes.map(value), { easing: ease.camera, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return {
    x: along((k) => k.x),
    y: along((k) => k.y),
    zoom: Math.exp(along((k) => Math.log(k.zoom))),
    rotateX: along((k) => k.rotateX ?? 0),
    rotateY: along((k) => k.rotateY ?? 0),
  };
};

// Zoom 1 fits the whole footage in the window. A pan never shows past the footage's edge, and an
// axis narrower than the window is centered.
const viewTransform = (view: View, footage: Size, area: Size) => {
  const scale = baseScale(footage, area) * view.zoom;
  const pan = (span: number, length: number, focus: number) => {
    const room = span - scale * length;
    return room >= 0 ? room / 2 : Math.min(0, Math.max(room, span / 2 - scale * focus));
  };
  return { scale, x: pan(area.width, footage.width, view.x), y: pan(area.height, footage.height, view.y) };
};

// Checking keyframes covers every frame: ease.camera never overshoots, so each frame's zoom lies
// between two keyframes' zooms.
const assertScale = (footage: ClipManifest, keyframes: readonly CameraKeyframe[], area: Rect, frameHeight: number) => {
  const base = baseScale(footage, area);
  const floor = frameHeight / LEGIBLE_LINES;
  for (const k of keyframes) {
    const scale = base * k.zoom;
    if (scale > MAX_SCALE + TOLERANCE) throw new Error(`${footage.scene}: scale ${scale.toFixed(3)} at frame ${k.frame} enlarges the footage past ${MAX_SCALE}`);
    if (k.target === undefined) continue;
    target(footage, k.target);
    const cell = scale * footage.cell.height;
    if (scale < floor / footage.cell.height - TOLERANCE)
      throw new Error(
        `${footage.scene} target "${k.target}" is held at scale ${scale.toFixed(3)} from frame ${k.frame}: a cell shows ${cell.toFixed(1)} px, under the ${floor.toFixed(1)} px floor (1/${LEGIBLE_LINES} of ${frameHeight} px)`,
      );
  }
};

export type CameraProps = {
  src: string;
  footage: ClipManifest;
  keyframes: readonly CameraKeyframe[];
  durationInFrames: number;
  trimBefore?: number;
  playbackRate?: number;
  box?: Rect;
  freeze?: { frame: number; active: boolean | ((frame: number) => boolean) };
};

// durationInFrames is composition frames; <Video> reads its own durationInFrames as media frames
// (trimAfter = trimBefore + durationInFrames, then divided by playbackRate), so a sped-up camera
// passes it scaled or the footage goes blank partway through.
// The plane is the part of the footage inside the window, so footage smaller than the window shows
// its own rounded edges and shadow, and footage that overfills it is cut at the window's. It tilts
// about its center, which the perspective looks along.
export const Camera = ({ src, footage, keyframes, durationInFrames, trimBefore = 0, playbackRate = 1, box, freeze }: CameraProps) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const area = box ?? fitWindow(footage, { width, height });
  assertScale(footage, keyframes, area, height);
  const k = height / VIDEO.height;
  const view = viewAt(keyframes, frame);
  const t = viewTransform(view, footage, area);
  const left = Math.max(0, t.x);
  const top = Math.max(0, t.y);
  const plane = {
    x: area.x + left,
    y: area.y + top,
    width: Math.min(area.width, t.x + footage.width * t.scale) - left,
    height: Math.min(area.height, t.y + footage.height * t.scale) - top,
  };
  return (
    <AbsoluteFill style={{ perspective: PERSPECTIVE * height, perspectiveOrigin: `${plane.x + plane.width / 2}px ${plane.y + plane.height / 2}px` }}>
      <div
        style={{
          position: "absolute",
          left: plane.x,
          top: plane.y,
          width: plane.width,
          height: plane.height,
          borderRadius: PLANE_RADIUS * k,
          overflow: "hidden",
          boxShadow: PLANE_SHADOW(k),
          transform: `rotateX(${view.rotateX}deg) rotateY(${view.rotateY}deg)`,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: footage.width,
            height: footage.height,
            transformOrigin: "0 0",
            transform: `translate3d(${t.x - left}px, ${t.y - top}px, 0) scale(${t.scale})`,
          }}
        >
          <Freeze frame={freeze?.frame ?? 0} active={freeze?.active ?? false}>
            <Video
              src={staticFile(src)}
              muted
              trimBefore={trimBefore}
              durationInFrames={durationInFrames * playbackRate}
              playbackRate={playbackRate}
              premountFor={fps}
              objectFit="fill"
              style={{ width: footage.width, height: footage.height }}
            />
          </Freeze>
        </div>
      </div>
    </AbsoluteFill>
  );
};
