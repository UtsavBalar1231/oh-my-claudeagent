import { Composition, Freeze } from "remotion";
import { LottieClip } from "./components/LottieClip.tsx";
import { Demo, demoTimeline } from "./Demo.tsx";
import { LOOP, Loop, loopPlan } from "./Loop.tsx";
import { PUNCH_LINE_SETTLED, PunchLine, punchLinePlan } from "./scenes/PunchLine.tsx";
import { toFrames, VIDEO } from "./theme.ts";

const MarkClip = () => <LottieClip file="lottie/omca-mark.json" />;
const IdentClip = () => <LottieClip file="lottie/omca-ident.json" />;

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
    <Composition id="Mark" component={MarkClip} durationInFrames={240} fps={60} width={256} height={256} />
    <Composition id="Ident" component={IdentClip} durationInFrames={210} fps={60} width={1920} height={540} />
  </>
);
