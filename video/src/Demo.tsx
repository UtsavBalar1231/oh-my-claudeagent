import { linearTiming, type TransitionPresentation, type TransitionPresentationComponentProps, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { Fragment, type FC } from "react";
import { AbsoluteFill, useVideoConfig } from "remotion";
import { ColdOpen, coldOpenPlan, FILM_COLD_OPEN } from "./scenes/ColdOpen.tsx";
import { EndCard, endCardPlan } from "./scenes/EndCard.tsx";
import { FILM_PAIR, GuardPair, guardPairPlan } from "./scenes/GuardPair.tsx";
import { Plan, planPlan } from "./scenes/Plan.tsx";
import { Prove, provePlan } from "./scenes/Prove.tsx";
import { SeeIt, seeItPlan } from "./scenes/SeeIt.tsx";
import { crossfadeFrames } from "./scenes/shot.tsx";
import { StopPair, stopPairPlan } from "./scenes/StopPair.tsx";
import { Title, titlePlan } from "./scenes/Title.tsx";
import { Work, workPlan } from "./scenes/Work.tsx";
import { ease, toFrames, VIDEO } from "./theme.ts";

// An act transition: the outgoing scene, whole, pushes past the lens and fades over the incoming one,
// which is already on its establish move. It scales the scene outside Camera, so the footage's 1.0
// ceiling does not bind it.
const ACT = 0.25;
const PAST_LENS = 2.4;
const actFrames = (fps: number): number => toFrames(ACT, fps);

type NoProps = Record<string, never>;

// Remotion stacks a transition's entering scene over its exiting one; this presentation lifts the
// exiting scene above it.
const PushThrough = ({ children, presentationDirection, presentationProgress }: TransitionPresentationComponentProps<NoProps>) =>
  presentationDirection === "entering" ? (
    <AbsoluteFill>{children}</AbsoluteFill>
  ) : (
    <AbsoluteFill style={{ zIndex: 1, opacity: 1 - presentationProgress, transform: `scale(${1 + (PAST_LENS - 1) * presentationProgress})` }}>{children}</AbsoluteFill>
  );

const pushThrough: TransitionPresentation<NoProps> = { component: PushThrough, props: {} };

/** How a beat joins the one before it: a hard cut, an act transition, or the crossfade into the end card. */
type Join = "cut" | "act" | "fade";

const FilmColdOpen = () => <ColdOpen shots={FILM_COLD_OPEN} />;
const FilmGuardPair = () => <GuardPair timing={FILM_PAIR} />;

const TITLE_SECONDS = 4;

const BEATS: readonly { id: string; Scene: FC; duration: (fps: number) => number; join: Join }[] = [
  { id: "cold-open", Scene: FilmColdOpen, duration: (fps) => coldOpenPlan(FILM_COLD_OPEN, fps).duration, join: "cut" },
  { id: "title", Scene: Title, duration: (fps) => titlePlan(fps, TITLE_SECONDS).duration, join: "cut" },
  { id: "stop", Scene: StopPair, duration: (fps) => stopPairPlan(fps).duration, join: "act" },
  { id: "guard", Scene: FilmGuardPair, duration: (fps) => guardPairPlan(fps, FILM_PAIR).duration, join: "cut" },
  { id: "plan", Scene: Plan, duration: (fps) => planPlan(fps).duration, join: "act" },
  { id: "work", Scene: Work, duration: (fps) => workPlan(fps).duration, join: "cut" },
  { id: "prove", Scene: Prove, duration: (fps) => provePlan(fps).duration, join: "act" },
  { id: "see-it", Scene: SeeIt, duration: (fps) => seeItPlan(fps).duration, join: "cut" },
  { id: "end", Scene: EndCard, duration: (fps) => endCardPlan(fps, VIDEO).duration, join: "fade" },
];

const overlap = (join: Join, fps: number): number => (join === "act" ? actFrames(fps) : join === "fade" ? crossfadeFrames(fps) : 0);

/** Each beat's start and length in composition frames, after the transitions that overlap them. */
export const demoTimeline = (fps: number) => {
  let end = 0;
  const beats = BEATS.map(({ id, Scene, duration, join }) => {
    const start = end - overlap(join, fps);
    const beat = { id, Scene, join, start, duration: duration(fps) };
    end = start + beat.duration;
    return beat;
  });
  return { beats, durationInFrames: end };
};

// TransitionSeries reads its children by element type, so a transition is an element here, not a component wrapping one.
const transition = (join: Join, fps: number) => {
  if (join === "act") return <TransitionSeries.Transition presentation={pushThrough} timing={linearTiming({ durationInFrames: actFrames(fps), easing: ease.exit })} />;
  if (join === "fade") return <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: crossfadeFrames(fps) })} />;
  return null;
};

export const Demo = () => {
  const { fps } = useVideoConfig();
  const { beats } = demoTimeline(fps);
  return (
    <TransitionSeries>
      {beats.map(({ id, Scene, duration, join }) => (
        <Fragment key={id}>
          {transition(join, fps)}
          <TransitionSeries.Sequence durationInFrames={duration} premountFor={fps}>
            <Scene />
          </TransitionSeries.Sequence>
        </Fragment>
      ))}
    </TransitionSeries>
  );
};
