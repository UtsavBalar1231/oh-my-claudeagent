import { useVideoConfig } from "remotion";
import { Caption } from "../components/Caption.tsx";
import { mark, shownTarget } from "../footage.ts";
import { toFrames, VIDEO } from "../theme.ts";
import { F5, P2 } from "./clips.ts";
import { aim, Canvas, fitWidth, marginCol, pushIn, Shot, stageFor, Timed, timeline } from "./shot.tsx";

// clip-plain-reset and clip-guard share the prompt, the 96x34 grid and the font, so both holds use
// one box and one view, and the match cut keeps the two outcomes in the same place on screen.
const CMD = mark(P2, "cmd-typed");
const RAN = mark(P2, "reset-ran");
const REFUSED = mark(F5, "refused");
const LOST_FILES = "lost-files";
const REFUSAL_ROW = "refusal-row";
const REFUSAL = shownTarget(F5, REFUSAL_ROW, REFUSED);
// From the prompt, five rows above the refusal row, to the spinner under it.
const layout = (height: number) => {
  const fit = fitWidth(P2, stageFor(height));
  return { box: fit.box, view: aim(F5, fit.box, { scale: fit.scale, top: REFUSAL.row - 5, left: marginCol(F5) }) };
};
const ROTATE_Y = -7;

/**
 * Seconds on screen for each part, and the footage each half plays: clip-plain-reset from `plain.from`
 * to `plain.to` (clip frames) at `plain.rate`, then held; clip-guard live for `omcaLive` seconds from
 * the refusal, then held. The last caption ends `captionTail` seconds before the beat does.
 */
export type PairTiming = {
  establish: number;
  push: number;
  plainHold: number;
  seconds: number;
  plain: { from: number; to: number; rate: number };
  omcaLive: number;
  captionTail: number;
};

const clipFrames = (seconds: number): number => Math.round(seconds * P2.fps);

/** The approved style sample: the reset runs at 3x under the establish and holds through the push. */
export const SAMPLE_PAIR: PairTiming = {
  establish: 1.6,
  push: 1,
  plainHold: 1.8,
  seconds: 7,
  plain: { from: CMD + clipFrames(1), to: RAN, rate: 3 },
  omcaLive: 2,
  captionTail: 0,
};

// The reset's output paints 1.6 s before reset-ran (clip frame 175), so the film's plain half plays
// in real time from the typed prompt and the output lands as the push arrives.
const FILM_ESTABLISH = 2;
const FILM_PUSH = 1.2;
/** The film: the typing, the reset and the refusal play in real time, and the beat ends in a scene push that carries no caption. */
export const FILM_PAIR: PairTiming = {
  establish: FILM_ESTABLISH,
  push: FILM_PUSH,
  plainHold: 3.8,
  seconds: 12,
  plain: { from: RAN - clipFrames(1.6 + FILM_ESTABLISH + FILM_PUSH), to: RAN + clipFrames(1), rate: 1 },
  omcaLive: 3.9,
  captionTail: 0.3,
};

/** The blog's reset-guard cut: the film's timing in 11 s. */
export const BLOG_PAIR: PairTiming = { ...FILM_PAIR, seconds: 11 };

export const guardPairPlan = (fps: number, timing: PairTiming = SAMPLE_PAIR, height: number = VIDEO.height) => {
  const { box, view } = layout(height);
  const f = (s: number) => toFrames(s, fps);
  const push = { from: f(timing.establish), to: f(timing.establish) + f(timing.push) };
  const cut = push.to + f(timing.plainHold);
  const end = f(timing.seconds);

  const plain = timeline(P2, fps);
  shownTarget(P2, "reset-call", timing.plain.to);
  shownTarget(P2, LOST_FILES, timing.plain.to);
  plain.play(timing.plain.from, timing.plain.to, timing.plain.rate);
  plain.fill(timing.plain.to, cut / fps);

  const omca = timeline(F5, fps);
  const live = REFUSED + omca.seconds(timing.omcaLive);
  shownTarget(F5, REFUSAL_ROW, live);
  omca.play(REFUSED, live);
  omca.fill(live, (end - cut) / fps);

  return {
    box,
    push,
    plain: { segments: plain.segments, keyframes: [...pushIn(view, ROTATE_Y, push, LOST_FILES), { ...view, frame: cut, target: LOST_FILES }] },
    omca: {
      segments: omca.segments.map((segment) => ({ ...segment, start: segment.start + cut })),
      keyframes: [{ ...view, frame: cut, target: REFUSAL_ROW }],
    },
    captions: {
      plain: { from: push.to, duration: cut - push.to },
      omca: { from: cut, duration: end - cut - f(timing.captionTail) },
    },
    duration: end,
  };
};

/** Plain Claude Code runs the reset and the camera pushes in on it; a match cut to OMCA refusing it in the same framing. */
export const GuardPair = ({ timing = SAMPLE_PAIR, captionSize }: { timing?: PairTiming; captionSize?: number | undefined }) => {
  const { fps, height } = useVideoConfig();
  const plan = guardPairPlan(fps, timing, height);
  return (
    <Canvas>
      <Shot clip={P2} box={plan.box} {...plan.plain} />
      <Shot clip={F5} box={plan.box} {...plan.omca} />
      <Timed {...plan.captions.plain}>
        <Caption text="Three files of work, gone." size={captionSize} />
      </Timed>
      <Timed {...plan.captions.omca}>
        <Caption text="OMCA refuses it, even in bypass." size={captionSize} />
      </Timed>
    </Canvas>
  );
};
