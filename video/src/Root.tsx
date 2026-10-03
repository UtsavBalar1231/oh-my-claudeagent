import { Composition, Freeze } from "remotion";
import { Demo, demoTimeline } from "./Demo.tsx";
import { LOOP, Loop, loopPlan } from "./Loop.tsx";
import { Reel, type ReelProps, REEL_SECONDS } from "./Reel.tsx";
import { PUNCH_LINE_SETTLED, PunchLine, punchLinePlan } from "./scenes/PunchLine.tsx";
import { toFrames, VIDEO } from "./theme.ts";

const reelDefaults: ReelProps = { fps: VIDEO.fps };

const PosterCard = () => (
  <Freeze frame={toFrames(PUNCH_LINE_SETTLED, VIDEO.fps)}>
    <PunchLine />
  </Freeze>
);

export const Root = () => (
  <>
    <Composition
      id="Demo"
      component={Demo}
      calculateMetadata={() => ({ durationInFrames: demoTimeline(VIDEO.fps).durationInFrames })}
      durationInFrames={1}
      {...VIDEO}
    />
    <Composition
      id="Components"
      component={Reel}
      defaultProps={reelDefaults}
      calculateMetadata={({ props }) => ({ fps: props.fps, durationInFrames: Math.round(REEL_SECONDS * props.fps) })}
      durationInFrames={Math.round(REEL_SECONDS * VIDEO.fps)}
      {...VIDEO}
    />
    <Composition
      id="Loop"
      component={Loop}
      calculateMetadata={() => ({ durationInFrames: loopPlan(LOOP.fps).duration })}
      durationInFrames={1}
      {...LOOP}
    />
    {/* The poster is the punch-line card once its words have settled, rendered as frame 0 of a
        composition at the Demo's rate and the card's length, because a <Still> runs at 1 fps. */}
    <Composition
      id="Poster"
      component={PosterCard}
      calculateMetadata={() => ({ durationInFrames: punchLinePlan(VIDEO.fps).duration })}
      durationInFrames={1}
      {...VIDEO}
    />
  </>
);
