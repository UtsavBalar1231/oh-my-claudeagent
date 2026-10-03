import { useVideoConfig } from "remotion";
import { Caption } from "../components/Caption.tsx";
import { CornerLabel } from "../components/CornerLabel.tsx";
import { KEY_PRESS_AT, KeyCaps } from "../components/KeyCaps.tsx";
import { LowerThird } from "../components/LowerThird.tsx";
import { mark, target } from "../footage.ts";
import { color, toFrames } from "../theme.ts";
import { F2 } from "./clips.ts";
import { aim, beatLength, Canvas, crossfadeFrames, marginCol, Shot, Timed, timeline, transcriptBox, Chapter } from "./shot.tsx";

const DIALOG = mark(F2, "dialog");
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
  const rush = t.play(settled, mark(F2, "plan-written"), 3);
  t.fill(mark(F2, "plan-written"), beatLength(7));
  // The caption, the keycap and the lower third share the bottom band, one after another.
  const captionFrom = edge + f(0.1);
  return {
    t,
    caption: { from: captionFrom, duration: choice.start - captionFrom },
    keys: { from: choice.start + f(LEAD_IN - KEY_PRESS_AT), duration: f(1.6) },
    steps: { from: rush.start, duration: t.duration - rush.start - edge },
    duration: t.duration,
  };
};

export const Plan = () => {
  const { fps } = useVideoConfig();
  const plan = planPlan(fps);
  return (
    <Canvas>
      <Shot clip={F2} border={color.omcaBorder} box={BOX} keyframes={[{ frame: 0, ...VIEW }]} segments={plan.t.segments} />
      <CornerLabel />
      <Chapter name="Plan" beatDuration={plan.duration} enters leaves />
      <Timed {...plan.caption}>
        <Caption text="It plans with you first." />
      </Timed>
      <Timed {...plan.keys}>
        <KeyCaps keys={["↓"]} />
      </Timed>
      <Timed {...plan.steps}>
        <LowerThird items={["interview", "gap check", "review"]} />
      </Timed>
    </Canvas>
  );
};
