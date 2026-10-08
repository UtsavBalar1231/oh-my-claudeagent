import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { Fragment, type FC } from "react";
import { useVideoConfig } from "remotion";
import { Agents, agentsPlan } from "./scenes/Agents.tsx";
import { Board, boardPlan } from "./scenes/Board.tsx";
import { Capabilities, capabilitiesPlan } from "./scenes/Capabilities.tsx";
import { Everywhere, everywherePlan } from "./scenes/Everywhere.tsx";
import { Guard, guardPlan } from "./scenes/Guard.tsx";
import { Install, installPlan } from "./scenes/Install.tsx";
import { Plan, planPlan } from "./scenes/Plan.tsx";
import { PlainReset, plainResetPlan } from "./scenes/PlainReset.tsx";
import { PlainStop, plainStopPlan } from "./scenes/PlainStop.tsx";
import { Progress, progressPlan } from "./scenes/Progress.tsx";
import { PunchLine, punchLinePlan } from "./scenes/PunchLine.tsx";
import { Refusal, refusalPlan } from "./scenes/Refusal.tsx";
import { Sizzle, sizzlePlan } from "./scenes/Sizzle.tsx";
import { Ledger, Notepad, Stats } from "./scenes/Tour.tsx";
import { Verify, verifyPlan } from "./scenes/Verify.tsx";
import { crossfadeFrames } from "./scenes/shot.tsx";

// `cut` joins a beat to the one before it without a crossfade.
const BEATS: readonly { id: string; Scene: FC; duration: (fps: number) => number; cut?: boolean }[] = [
  { id: "sizzle", Scene: Sizzle, duration: (fps) => sizzlePlan(fps).duration },
  { id: "punch-line", Scene: PunchLine, duration: (fps) => punchLinePlan(fps).duration, cut: true },
  { id: "plain-stop", Scene: PlainStop, duration: (fps) => plainStopPlan(fps).duration },
  { id: "omca-stop", Scene: Refusal, duration: (fps) => refusalPlan(fps).duration },
  { id: "plain-reset", Scene: PlainReset, duration: (fps) => plainResetPlan(fps).duration },
  { id: "guard", Scene: Guard, duration: (fps) => guardPlan(fps).duration },
  { id: "plan", Scene: Plan, duration: (fps) => planPlan(fps).duration },
  { id: "agents", Scene: Agents, duration: (fps) => agentsPlan(fps).duration },
  { id: "progress", Scene: Progress, duration: (fps) => progressPlan(fps).duration },
  { id: "board", Scene: Board, duration: (fps) => boardPlan(fps).duration },
  { id: "verify", Scene: Verify, duration: (fps) => verifyPlan(fps).duration },
  { id: "ledger", Scene: Ledger.Scene, duration: (fps) => Ledger.plan(fps).duration },
  { id: "notepad", Scene: Notepad.Scene, duration: (fps) => Notepad.plan(fps).duration },
  { id: "stats", Scene: Stats.Scene, duration: (fps) => Stats.plan(fps).duration },
  { id: "roster", Scene: Capabilities, duration: (fps) => capabilitiesPlan(fps).duration },
  { id: "everywhere", Scene: Everywhere, duration: (fps) => everywherePlan(fps).duration },
  { id: "end", Scene: Install, duration: (fps) => installPlan(fps).duration },
];

/** Each beat's start and length in composition frames, after the crossfades that overlap them. */
export const demoTimeline = (fps: number) => {
  const overlap = crossfadeFrames(fps);
  let end = 0;
  const beats = BEATS.map(({ id, Scene, duration, cut = false }, i) => {
    const start = i === 0 || cut ? end : end - overlap;
    const beat = { id, Scene, cut, start, duration: duration(fps) };
    end = start + beat.duration;
    return beat;
  });
  return { beats, overlap, durationInFrames: end };
};

export const Demo = () => {
  const { fps } = useVideoConfig();
  const { beats, overlap } = demoTimeline(fps);
  return (
    <TransitionSeries>
      {beats.map(({ id, Scene, duration, cut }, i) => (
        <Fragment key={id}>
          {i === 0 || cut ? null : <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: overlap })} />}
          <TransitionSeries.Sequence durationInFrames={duration} premountFor={fps}>
            <Scene />
          </TransitionSeries.Sequence>
        </Fragment>
      ))}
    </TransitionSeries>
  );
};
