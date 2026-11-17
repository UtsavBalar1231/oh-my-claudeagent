import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

export const color = {
  stage: "#c8c1b5",
  caption: "#4b4741",
  title: "#1f1d1a",
} as const;

export const mono = loadMono("normal", { weights: ["400", "600"], subsets: ["latin"] }).fontFamily;

export const VIDEO = { width: 1920, height: 1080, fps: 60 } as const;

// Bottom keeps 80 px clear of the frame edge for player controls.
export const SAFE = { x: 96, top: 54, bottom: 80 } as const;

export const ease = {
  entrance: Easing.bezier(0.05, 0.7, 0.1, 1),
  exit: Easing.bezier(0.3, 0, 0.8, 0.15),
  camera: Easing.bezier(0.65, 0, 0.35, 1),
} as const;

// Seconds, so a 30 fps render keeps the timing of the 60 fps master.
export const time = {
  entrance: 0.45,
  exit: 0.22,
  camera: 0.7,
  stagger: 0.05,
  word: 0.067,
  dim: 0.33,
  draw: 0.33,
  char: 1 / 30,
  keyHold: 0.7,
} as const;

export const springs = {
  snappy: { damping: 20, stiffness: 200 },
  calm: { damping: 26, stiffness: 170 },
} as const;

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

export const toFrames = (seconds: number, fps: number): number => Math.round(seconds * fps);

/** Frame, timing and the entrance and exit curves of the enclosing Sequence, with delays and lengths in seconds. */
export const useMotion = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const f = (seconds: number) => toFrames(seconds, fps);
  return {
    frame,
    fps,
    width,
    height,
    durationInFrames,
    f,
    enter: (delay = 0, length: number = time.entrance) =>
      interpolate(frame, [f(delay), f(delay) + f(length)], [0, 1], { ...clamp, easing: ease.entrance }),
    leave: (length: number = time.exit) =>
      interpolate(frame, [durationInFrames - f(length), durationInFrames], [0, 1], { ...clamp, easing: ease.exit }),
  };
};

const CAPTION_WORDS = 7;

export const assertWords = (text: string): void => {
  const count = text.trim().split(/\s+/).length;
  if (count > CAPTION_WORDS) throw new Error(`"${text}" has ${count} words; a caption holds at most ${CAPTION_WORDS}`);
};
