import { useVideoConfig } from "remotion";
import { Caption } from "../components/Caption.tsx";
import { mark, shownTarget, target } from "../footage.ts";
import { toFrames } from "../theme.ts";
import { F1, P1 } from "./clips.ts";
import { aim, Canvas, fitWidth, marginCol, pushIn, SETTLE, Shot, Timed, timeline } from "./shot.tsx";

// clip-plain-stop and clip-refusal share the prompt, the 96x34 grid and the font, so both halves use
// one box and one view: from four rows above the claim, 19 rows down, which take in the plain run's
// open list and OMCA's Stop hook feedback.
const FIT = fitWidth(P1);
const CLAIM_LINE = "claim-line";
const OPEN_LIST = "open-list";
const STOP_LINE = "stop-line";
const VIEW = aim(F1, FIT.box, { scale: FIT.scale, top: target(F1, CLAIM_LINE).row - 4, left: marginCol(F1) });
const ROTATE_Y = 7;
const ESTABLISH = 2;
const PUSH = 1.2;
// The prompt reaches the transcript 1.2 s after it is typed (clip frame 126), as the push starts.
const SUBMIT = 1.2;
const CLAIM_READ = 1.5;
// The mock model's one-word reply to the grep paints under the list 1.4 s after open-tasks (clip
// frame 390), so the list stops playing before it.
const LIST_LIVE = 1.3;
const LIST_HOLD = 3.8;
const SECONDS = 14;

export const stopPairPlan = (fps: number) => {
  const f = (s: number) => toFrames(s, fps);
  const push = { from: f(ESTABLISH), to: f(ESTABLISH) + f(PUSH) };
  const end = f(SECONDS);

  const plain = timeline(P1, fps);
  const claimRead = mark(P1, "claim-done") + plain.seconds(CLAIM_READ);
  shownTarget(P1, CLAIM_LINE, claimRead);
  plain.play(mark(P1, "cmd-typed") + plain.seconds(SUBMIT - ESTABLISH), claimRead);
  // Nothing in the window changes between the claim and the grep's rows, which paint whole 0.1 s
  // before open-tasks lands, so the jump to them is the list appearing.
  const listEnd = mark(P1, "open-tasks") + plain.seconds(LIST_LIVE);
  shownTarget(P1, OPEN_LIST, listEnd);
  const list = plain.play(mark(P1, "open-tasks") - plain.seconds(0.1), listEnd);
  const cut = list.start + f(LIST_HOLD);
  plain.fill(listEnd, cut / fps);

  // The claim and the Stop hook feedback paint a clip frame apart, so the cut lands on both.
  const omca = timeline(F1, fps);
  const stopEnd = target(F1, STOP_LINE).to - SETTLE;
  shownTarget(F1, STOP_LINE, stopEnd);
  omca.play(mark(F1, "claim-done"), stopEnd);
  omca.fill(stopEnd, (end - cut) / fps);

  return {
    plain: { segments: plain.segments, keyframes: [...pushIn(VIEW, ROTATE_Y, push, CLAIM_LINE), { ...VIEW, frame: list.start, target: OPEN_LIST }] },
    omca: {
      segments: omca.segments.map((segment) => ({ ...segment, start: segment.start + cut })),
      keyframes: [{ ...VIEW, frame: cut, target: STOP_LINE }],
    },
    captions: {
      plain: { from: list.start, duration: cut - list.start },
      omca: { from: cut, duration: end - cut },
    },
    duration: end,
  };
};

/** Plain Claude Code claims the work is done and its own grep shows the open tasks; a match cut to OMCA sending the same claim back. */
export const StopPair = () => {
  const { fps } = useVideoConfig();
  const plan = stopPairPlan(fps);
  return (
    <Canvas>
      <Shot clip={P1} box={FIT.box} {...plan.plain} />
      <Shot clip={F1} box={FIT.box} {...plan.omca} />
      <Timed {...plan.captions.plain}>
        <Caption text="Claude said done. 8 tasks were open." />
      </Timed>
      <Timed {...plan.captions.omca}>
        <Caption text="OMCA sends it back." />
      </Timed>
    </Canvas>
  );
};
