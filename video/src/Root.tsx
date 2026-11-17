import type { FC } from "react";
import { Composition, Freeze, Series, useVideoConfig } from "remotion";
import { LottieClip } from "./components/LottieClip.tsx";
import { Demo, demoTimeline } from "./Demo.tsx";
import { LOOP, Loop, LOOP_PROPS, loopPlan, type LoopProps } from "./Loop.tsx";
import { ColdOpen, coldOpenPlan, SAMPLE_COLD_OPEN } from "./scenes/ColdOpen.tsx";
import { BLOG_PAIR, GuardPair, guardPairPlan } from "./scenes/GuardPair.tsx";
import { Canvas } from "./scenes/shot.tsx";
import { TaskList, taskListPlan } from "./scenes/TaskList.tsx";
import { Title, titlePlan } from "./scenes/Title.tsx";
import { toFrames, VIDEO } from "./theme.ts";

const MarkClip = () => <LottieClip file="lottie/omca-mark.json" />;
const IdentClip = () => <LottieClip file="lottie/omca-ident.json" />;

// All ten mascots have risen by 1.3 s into the ident (the last starts at frame 54 and rises for 24).
const TITLE_SETTLED = 2;

const PosterCard = () => (
  <Freeze frame={toFrames(TITLE_SETTLED, VIDEO.fps)}>
    <Title />
  </Freeze>
);

const BLOG = { width: 1280, height: 720, fps: 30 } as const;
const MARK_SECONDS = 4;
// 512 px is the mark's own canvas, so its 40 px cells land on whole pixels, and it centers on whole pixels.
const BLOG_MARK_SIZE = 512;

/** The frame a poster is cut from, which the render script reads from the composition's props. */
export type HoldProps = { hold: number };

const BlogTaskList: FC<HoldProps> = () => <TaskList />;
const BlogResetGuard: FC<HoldProps> = () => <GuardPair timing={BLOG_PAIR} />;

// The mark is authored at 60 fps.
const MARK_FPS = 60;

const BlogMark = () => (
  <Canvas>
    <div style={{ position: "absolute", left: (BLOG.width - BLOG_MARK_SIZE) / 2, top: (BLOG.height - BLOG_MARK_SIZE) / 2, width: BLOG_MARK_SIZE, height: BLOG_MARK_SIZE }}>
      <LottieClip file="lottie/omca-mark.json" playbackRate={MARK_FPS / BLOG.fps} />
    </div>
  </Canvas>
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
      defaultProps={LOOP_PROPS}
      calculateMetadata={({ props }: { props: LoopProps }) => ({ fps: props.fps, durationInFrames: loopPlan(props.fps, props.proveHold).duration })}
      durationInFrames={1}
      width={LOOP.width}
      height={LOOP.height}
      fps={LOOP.fps}
    />
    <Composition
      id="BlogTaskList"
      component={BlogTaskList}
      defaultProps={{ hold: 0 }}
      calculateMetadata={({ props }: { props: HoldProps }) => {
        const plan = taskListPlan(BLOG.fps, BLOG.height);
        return { durationInFrames: plan.duration, props: { ...props, hold: plan.hold } };
      }}
      durationInFrames={1}
      {...BLOG}
    />
    <Composition
      id="BlogResetGuard"
      component={BlogResetGuard}
      defaultProps={{ hold: 0 }}
      calculateMetadata={({ props }: { props: HoldProps }) => {
        const plan = guardPairPlan(BLOG.fps, BLOG_PAIR, BLOG.height);
        return { durationInFrames: plan.duration, props: { ...props, hold: plan.push.to + toFrames(0.3, BLOG.fps) } };
      }}
      durationInFrames={1}
      {...BLOG}
    />
    <Composition id="BlogMark" component={BlogMark} durationInFrames={toFrames(MARK_SECONDS, BLOG.fps)} {...BLOG} />
    {/* The poster is the title card once the ident has settled, rendered as frame 0 of a
        composition at the Demo's rate and the card's length, because a <Still> runs at 1 fps. */}
    <Composition id="Poster" component={PosterCard} durationInFrames={titlePlan(VIDEO.fps).duration} {...VIDEO} />
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
