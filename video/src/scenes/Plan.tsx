import { useVideoConfig } from "remotion";
import { Caption } from "../components/Caption.tsx";
import { mark, target } from "../footage.ts";
import { toFrames } from "../theme.ts";
import { F2 } from "./clips.ts";
import { aim, beatLength, Canvas, crossfadeFrames, marginCol, Shot, Timed, timeline, transcriptBox } from "./shot.tsx";

// The dialog paints over four frames after the frame its mark lands on (clip-plan, 2026-11-17), so the
// hold starts once it is whole.
const DIALOG = mark(F2, "dialog") + 5;
const BOX = transcriptBox(F2);
// From the prompt, nine rows above the dialog's question, through the dialog's last option; Claude
// Code's diff panel opens at the right after the first plan write, past the window's columns.
const VIEW = aim(F2, BOX, { scale: 1, top: target(F2, "question").row - 9, left: marginCol(F2) });
const LEAD_IN = 0.6;

export const planPlan = (fps: number) => {
  const f = (s: number) => toFrames(s, fps);
  const edge = crossfadeFrames(fps);
  const t = timeline(F2, fps);
  const key = mark(F2, "key-choice");
  const settled = key + t.seconds(1);
  if (key - t.seconds(LEAD_IN) < DIALOG) throw new Error("clip-plan: the key choice comes too soon after the dialog for the cut");
  // The submitted prompt reaches the transcript a second after the command is typed; until then
  // the window is empty.
  t.play(mark(F2, "cmd-typed") + t.seconds(1), DIALOG, 3);
  t.hold(DIALOG, 1.8);
  // The dialog does not change until the key press, so the cut from the hold is invisible.
  const choice = t.play(key - t.seconds(LEAD_IN), settled);
  t.play(settled, mark(F2, "plan-written"), 3);
  t.fill(mark(F2, "plan-written"), beatLength(7));
  const captionFrom = edge + f(0.1);
  return {
    t,
    caption: { from: captionFrom, duration: choice.start - captionFrom },
    duration: t.duration,
  };
};

export const Plan = () => {
  const { fps } = useVideoConfig();
  const plan = planPlan(fps);
  return (
    <Canvas>
      <Shot clip={F2} box={BOX} keyframes={[{ frame: 0, ...VIEW }]} segments={plan.t.segments} />
      <Timed {...plan.caption}>
        <Caption text="It plans with you first." />
      </Timed>
    </Canvas>
  );
};
