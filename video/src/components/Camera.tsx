import { Video } from "@remotion/media";
import { createContext, type ReactNode, useContext } from "react";
import { Freeze, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { Rect } from "../footage.ts";
import { ease, SAFE, VIDEO } from "../theme.ts";
import { Window } from "./Window.tsx";

export type CameraKeyframe = { frame: number; x: number; y: number; zoom: number };
export type View = Omit<CameraKeyframe, "frame">;
export type Size = { width: number; height: number };
export type ToScreen = (rect: Rect) => Rect;

// Above 1.0 footage pixels per composition pixel the footage is upscaled; 1.5 is the softest allowed.
export const MAX_SCALE = 1.5;

/** The largest window inside the safe area with the footage's aspect ratio, centered in it. */
export const baseScale = (footage: Size, area: Size): number => Math.min(area.width / footage.width, area.height / footage.height);

export const fitWindow = (footage: Size): Rect => {
  const room = { width: VIDEO.width - 2 * SAFE.x, height: VIDEO.height - SAFE.top - SAFE.bottom };
  const scale = Math.min(room.width / footage.width, room.height / footage.height);
  const width = Math.round(footage.width * scale);
  const height = Math.round(footage.height * scale);
  return { x: Math.round((VIDEO.width - width) / 2), y: Math.round(SAFE.top + (room.height - height) / 2), width, height };
};

// Zoom eases in log space so each doubling takes the same time; x and y are the footage pixel
// placed at the window's center.
export const viewAt = (keyframes: readonly CameraKeyframe[], frame: number): View => {
  const [first] = keyframes;
  if (first === undefined) throw new Error("Camera needs at least one keyframe");
  if (keyframes.length === 1) return first;
  const frames = keyframes.map((k) => k.frame);
  const along = (values: number[]) =>
    interpolate(frame, frames, values, { easing: ease.camera, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return {
    x: along(keyframes.map((k) => k.x)),
    y: along(keyframes.map((k) => k.y)),
    zoom: Math.exp(along(keyframes.map((k) => Math.log(k.zoom)))),
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

export const projector = (view: View, footage: Size, area: Rect): ToScreen => {
  const t = viewTransform(view, footage, area);
  return (rect) => ({
    x: area.x + t.x + rect.x * t.scale,
    y: area.y + t.y + rect.y * t.scale,
    width: rect.width * t.scale,
    height: rect.height * t.scale,
  });
};

type CameraSpace = { toScreen: ToScreen; area: Rect };

const CameraContext = createContext<CameraSpace | null>(null);

const useCameraSpace = (): CameraSpace => {
  const space = useContext(CameraContext);
  if (space === null) throw new Error("camera overlays need an enclosing <Camera> or <CameraOverlay>");
  return space;
};

/** Maps a rect in footage pixels to composition pixels at the enclosing Camera's current frame. */
export const useCameraTransform = (): ToScreen => useCameraSpace().toScreen;

/** The footage window in composition pixels. */
export const useCameraArea = (): Rect => useCameraSpace().area;

export type CameraOverlayProps = { footage: Size; keyframes: readonly CameraKeyframe[]; box?: Rect; children?: ReactNode };

// Gives overlays the camera's transform without drawing footage, so one set of overlays can span
// several Camera segments that share keyframes.
export const CameraOverlay = ({ footage, keyframes, box, children }: CameraOverlayProps) => {
  const frame = useCurrentFrame();
  const area = box ?? fitWindow(footage);
  return <CameraContext.Provider value={{ toScreen: projector(viewAt(keyframes, frame), footage, area), area }}>{children}</CameraContext.Provider>;
};

export type CameraProps = {
  src: string;
  footage: Size;
  keyframes: readonly CameraKeyframe[];
  durationInFrames: number;
  trimBefore?: number;
  playbackRate?: number;
  box?: Rect;
  border?: string;
  freeze?: { frame: number; active: boolean | ((frame: number) => boolean) };
  children?: ReactNode;
};

// durationInFrames is composition frames; <Video> reads its own durationInFrames as media frames
// (trimAfter = trimBefore + durationInFrames, then divided by playbackRate), so a sped-up camera
// passes it scaled or the footage goes blank partway through.
// children render in composition space above the window, so an overlay keeps its stroke width at
// any zoom and is not clipped by the window. freeze holds only the footage, so overlays keep
// animating while it is held.
export const Camera = ({ src, footage, keyframes, durationInFrames, trimBefore = 0, playbackRate = 1, box, border, freeze, children }: CameraProps) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const area = box ?? fitWindow(footage);
  const limit = MAX_SCALE / baseScale(footage, area);
  const over = keyframes.find((k) => k.zoom > limit);
  if (over !== undefined) throw new Error(`zoom ${over.zoom} at frame ${over.frame} exceeds ${MAX_SCALE}x footage pixels (zoom ${limit.toFixed(2)})`);
  const view = viewAt(keyframes, frame);
  const t = viewTransform(view, footage, area);
  return (
    <CameraContext.Provider value={{ toScreen: projector(view, footage, area), area }}>
      <Window box={area} {...(border === undefined ? {} : { border })}>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: footage.width,
            height: footage.height,
            transformOrigin: "0 0",
            translate: `${t.x}px ${t.y}px`,
            scale: `${t.scale}`,
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
      </Window>
      {children}
    </CameraContext.Provider>
  );
};
