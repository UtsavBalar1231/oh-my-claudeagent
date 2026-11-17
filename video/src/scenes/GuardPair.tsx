import { useVideoConfig } from "remotion";
import type { CameraKeyframe } from "../components/Camera.tsx";
import { Caption } from "../components/Caption.tsx";
import { mark, shownTarget } from "../footage.ts";
import { toFrames } from "../theme.ts";
import { F5, P2 } from "./clips.ts";
import { aim, Canvas, establish, fitWidth, marginCol, Shot, Timed, timeline } from "./shot.tsx";

// clip-plain-reset and clip-guard share the prompt, the 96x34 grid and the font, so both holds use
// one box and one view, and the match cut keeps the two outcomes in the same place on screen.
const FIT = fitWidth(P2);
const RAN = mark(P2, "reset-ran");
const REFUSED = mark(F5, "refused");
const LOST_FILES = "lost-files";
const REFUSAL_ROW = "refusal-row";
const REFUSAL = shownTarget(F5, REFUSAL_ROW, REFUSED);
shownTarget(P2, "reset-call", RAN);
shownTarget(P2, LOST_FILES, RAN);
// From the prompt, five rows above the refusal row, to the spinner under it.
const VIEW = aim(F5, FIT.box, { scale: FIT.scale, top: REFUSAL.row - 5, left: marginCol(F5) });
const ROTATE_Y = -7;
const ESTABLISH_SECONDS = 1.6;
const PUSH_SECONDS = 1;
const PLAIN_HOLD_SECONDS = 1.8;
const OMCA_LIVE_SECONDS = 2;

export const guardPairPlan = (fps: number, seconds = 7) => {
  const f = (s: number) => toFrames(s, fps);
  const push = { from: f(ESTABLISH_SECONDS), to: f(ESTABLISH_SECONDS) + f(PUSH_SECONDS) };
  const cut = push.to + f(PLAIN_HOLD_SECONDS);
  const end = f(seconds);

  const plain = timeline(P2, fps);
  // The submitted prompt reaches the transcript a second after the command is typed. Nothing on
  // screen changes after the reset, so its frame holds through the push and the hold.
  plain.play(mark(P2, "cmd-typed") + plain.seconds(1), RAN, 3);
  plain.fill(RAN, cut / fps);

  const omca = timeline(F5, fps);
  const live = REFUSED + omca.seconds(OMCA_LIVE_SECONDS);
  shownTarget(F5, REFUSAL_ROW, live);
  omca.play(REFUSED, live);
  omca.fill(live, (end - cut) / fps);

  const plainKeyframes: CameraKeyframe[] = [
    ...establish(VIEW, ROTATE_Y, -Math.round(push.from / 2), push.from),
    { ...VIEW, frame: push.to, target: LOST_FILES },
    { ...VIEW, frame: cut, target: LOST_FILES },
  ];
  return {
    plain: { segments: plain.segments, keyframes: plainKeyframes },
    omca: {
      segments: omca.segments.map((segment) => ({ ...segment, start: segment.start + cut })),
      keyframes: [{ ...VIEW, frame: cut, target: REFUSAL_ROW }],
    },
    captions: {
      plain: { from: push.to, duration: cut - push.to },
      omca: { from: cut, duration: end - cut },
    },
    duration: end,
  };
};

/** Plain Claude Code runs the reset and the camera pushes in on it; a match cut to OMCA refusing it in the same framing. */
export const GuardPair = () => {
  const { fps } = useVideoConfig();
  const plan = guardPairPlan(fps);
  return (
    <Canvas>
      <Shot clip={P2} box={FIT.box} {...plan.plain} />
      <Shot clip={F5} box={FIT.box} {...plan.omca} />
      <Timed {...plan.captions.plain}>
        <Caption text="Three files of work, gone." />
      </Timed>
      <Timed {...plan.captions.omca}>
        <Caption text="OMCA refuses it, even in bypass." />
      </Timed>
    </Canvas>
  );
};
