import { AbsoluteFill, Freeze, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { EndCard, TYPED_AT } from "../components/EndCard.tsx";
import { toFrames } from "../theme.ts";
import { PUNCH_LINE } from "./PunchLine.tsx";
import { Sizzle } from "./Sizzle.tsx";
import { Canvas, Timed } from "./shot.tsx";

const LENGTH = 10;
const DISSOLVE = 0.5;

export const installPlan = (fps: number) => {
  const duration = toFrames(LENGTH, fps);
  if (TYPED_AT + 1 > LENGTH - DISSOLVE) throw new Error("the install commands need a hold before the dissolve");
  const dissolve = toFrames(DISSOLVE, fps);
  return { duration, dissolve: { from: duration - dissolve, duration: dissolve } };
};

// The last half second dissolves into the sizzle's frame 0, so the master loops without a seam.
const IntoOpening = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  return (
    <AbsoluteFill style={{ opacity: interpolate(frame, [0, durationInFrames - 1], [0, 1]) }}>
      <Freeze frame={0}>
        <Sizzle />
      </Freeze>
    </AbsoluteFill>
  );
};

export const Install = () => {
  const { fps } = useVideoConfig();
  const plan = installPlan(fps);
  return (
    <Canvas>
      <EndCard line={PUNCH_LINE} />
      <Timed {...plan.dissolve}>
        <IntoOpening />
      </Timed>
    </Canvas>
  );
};
