import { AbsoluteFill, Composition, Img, Still, staticFile } from "remotion";
import { Poster } from "./Poster.tsx";
import { Reel, type ReelProps, REEL_SECONDS } from "./Reel.tsx";
import { color, VIDEO } from "./theme.ts";

const LOOP = { width: 800, height: 450, fps: 15, seconds: 13 } as const;

const LoopPlaceholder = () => (
  <AbsoluteFill style={{ background: color.canvas }}>
    <Img src={staticFile("placeholder/plan.png")} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
  </AbsoluteFill>
);

const reelDefaults: ReelProps = { fps: VIDEO.fps };

export const Root = () => (
  <>
    <Composition id="Demo" component={Poster} durationInFrames={4380} {...VIDEO} />
    <Composition
      id="Components"
      component={Reel}
      defaultProps={reelDefaults}
      calculateMetadata={({ props }) => ({ fps: props.fps, durationInFrames: Math.round(REEL_SECONDS * props.fps) })}
      durationInFrames={Math.round(REEL_SECONDS * VIDEO.fps)}
      {...VIDEO}
    />
    <Composition id="Loop" component={LoopPlaceholder} width={LOOP.width} height={LOOP.height} fps={LOOP.fps} durationInFrames={LOOP.seconds * LOOP.fps} />
    <Still id="Poster" component={Poster} width={VIDEO.width} height={VIDEO.height} />
  </>
);
