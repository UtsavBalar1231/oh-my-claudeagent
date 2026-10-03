import { loadFont as loadSerif } from "@remotion/google-fonts/InstrumentSerif";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

export const color = {
  canvas: "#09090b",
  accent: "#d77757",
  text: "#f4f4f5",
  muted: "#a1a1aa",
  quiet: "rgba(255, 255, 255, 0.6)",
  green: "#4ade80",
  red: "#f87171",
  amber: "#fbbf24",
  frameBorder: "rgba(255, 255, 255, 0.08)",
  plainBorder: "rgba(255, 255, 255, 0.12)",
  omcaBorder: "rgba(215, 119, 87, 0.4)",
  panel: "rgba(9, 9, 11, 0.86)",
  keyFace: "#18181b",
  keyEdge: "#3f3f46",
} as const;

export const serif = loadSerif("normal", { weights: ["400"], subsets: ["latin"] }).fontFamily;
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

export const assertWords = (text: string, max: number): void => {
  const count = text.trim().split(/\s+/).length;
  if (count > max) throw new Error(`"${text}" has ${count} words; the limit here is ${max}`);
};
