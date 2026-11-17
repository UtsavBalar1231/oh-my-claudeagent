import { Composition, Freeze, Series, useVideoConfig } from "remotion";
import { LottieClip } from "./components/LottieClip.tsx";
import { Demo, demoTimeline } from "./Demo.tsx";
import { LOOP, Loop, loopPlan } from "./Loop.tsx";
import { ColdOpen, coldOpenPlan, SAMPLE_COLD_OPEN } from "./scenes/ColdOpen.tsx";
import { GuardPair, guardPairPlan } from "./scenes/GuardPair.tsx";
import { PUNCH_LINE_SETTLED, PunchLine, punchLinePlan } from "./scenes/PunchLine.tsx";
import { Title, titlePlan } from "./scenes/Title.tsx";
import { toFrames, VIDEO } from "./theme.ts";

const MarkClip = () => <LottieClip file="lottie/omca-mark.json" />;
const IdentClip = () => <LottieClip file="lottie/omca-ident.json" />;

const PosterCard = () => (
  <Freeze frame={toFrames(PUNCH_LINE_SETTLED, VIDEO.fps)}>
    <PunchLine />
  </Freeze>
);

const SampleColdOpen = () => <ColdOpen shots={SAMPLE_COLD_OPEN} />;

const sampleBeats = (fps: number) => [
  { id: "cold-open", Scene: SampleColdOpen, duration: coldOpenPlan(SAMPLE_COLD_OPEN, fps).duration },
  { id: "title", Scene: Title, duration: titlePlan(fps).duration },
  { id: "guard-pair", Scene: GuardPair, duration: guardPairPlan(fps).duration },
];

const Sample = () => {
  const { fps } = useVideoConfig();
  return (
    <Series>
      {sampleBeats(fps).map(({ id, Scene, duration }) => (
        <Series.Sequence key={id} durationInFrames={duration} premountFor={fps}>
          <Scene />
        </Series.Sequence>
      ))}
    </Series>
  );
};

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
    <Composition
      id="Sample"
      component={Sample}
      calculateMetadata={() => ({ durationInFrames: sampleBeats(VIDEO.fps).reduce((sum, beat) => sum + beat.duration, 0) })}
      durationInFrames={1}
      {...VIDEO}
    />
    <Composition id="Mark" component={MarkClip} durationInFrames={240} fps={60} width={256} height={256} />
    <Composition id="Ident" component={IdentClip} durationInFrames={210} fps={60} width={1920} height={540} />
  </>
);
