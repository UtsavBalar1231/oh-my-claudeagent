import { useVideoConfig } from "remotion";
import { Caption } from "../components/Caption.tsx";
import { mark, shownTarget, target } from "../footage.ts";
import { toFrames } from "../theme.ts";
import { F2 } from "./clips.ts";
import { aim, Canvas, marginCol, pushIn, Shot, Timed, timeline, transcriptBox } from "./shot.tsx";

const BOX = transcriptBox(F2);
const QUESTION = "question";
// From the prompt, nine rows above the dialog's question, through the dialog's last option; Claude
// Code's diff panel opens at the right after the first plan write, past the window's columns.
const VIEW = aim(F2, BOX, { scale: 1, top: target(F2, QUESTION).row - 9, left: marginCol(F2) });
const ROTATE_Y = 7;
const ESTABLISH = 1.8;
const PUSH = 1.2;
const DIALOG_HOLD = 2.1;
const KEY_LEAD = 0.4;
// The dialog folds into its answer 1.3 s after the key press (clip frame 454).
const ANSWERED = 1.4;
const SECONDS = 10;

export const planPlan = (fps: number) => {
  const f = (s: number) => toFrames(s, fps);
  const push = { from: f(ESTABLISH), to: f(ESTABLISH) + f(PUSH) };
  const end = f(SECONDS);
  const t = timeline(F2, fps);
  const dialog = mark(F2, "dialog");
  const key = mark(F2, "key-choice");
  const written = mark(F2, "plan-written");

  // The dialog paints as the push lands and stays unchanged until the key press, so the cut from
  // its hold to the moment before the key shows no jump.
  const asked = dialog + t.seconds(DIALOG_HOLD);
  shownTarget(F2, QUESTION, asked);
  if (key - t.seconds(KEY_LEAD) <= asked) throw new Error("clip-plan: the key choice comes too soon after the dialog for the cut");
  const interview = t.play(dialog - t.seconds(ESTABLISH + PUSH), asked);
  // The key moves the choice to "Provider vault", Enter folds the dialog into its answer, and the
  // plan's rewrite plays at 3x.
  t.play(key - t.seconds(KEY_LEAD), key + t.seconds(ANSWERED));
  t.play(key + t.seconds(ANSWERED), written, 3);
  const plan = t.fill(written, SECONDS);

  return {
    t,
    keyframes: pushIn(VIEW, ROTATE_Y, push, QUESTION),
    captions: {
      interview: { from: push.to, duration: interview.duration - push.to },
      plan: { from: plan.start, duration: end - plan.start },
    },
    duration: end,
  };
};

/** The plan skill interviews the user against its draft, then writes the plan with the answer in it. */
export const Plan = () => {
  const { fps } = useVideoConfig();
  const plan = planPlan(fps);
  return (
    <Canvas>
      <Shot clip={F2} box={BOX} keyframes={plan.keyframes} segments={plan.t.segments} />
      <Timed {...plan.captions.interview}>
        <Caption text="It plans with you first." />
      </Timed>
      <Timed {...plan.captions.plan}>
        <Caption text="The answer goes into the plan." />
      </Timed>
    </Canvas>
  );
};
