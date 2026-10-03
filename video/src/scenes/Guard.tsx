import { useVideoConfig } from "remotion";
import { Callout } from "../components/Callout.tsx";
import { Caption } from "../components/Caption.tsx";
import { CornerLabel } from "../components/CornerLabel.tsx";
import { SideLabel } from "../components/SideLabel.tsx";
import { StatChip } from "../components/StatChip.tsx";
import { mark, shownTarget, targetRect } from "../footage.ts";
import { color, SAFE, toFrames } from "../theme.ts";
import { F5 } from "./clips.ts";
import { RESET_BOX } from "./PlainReset.tsx";
import { aim, beatLength, Canvas, crossfadeFrames, fitWidth, labelSpan, marginCol, Shot, Timed, timeline } from "./shot.tsx";

const FIT = fitWidth(F5);
const DIALOG = mark(F5, "dialog");
const REFUSED = mark(F5, "refused");
const DISCARD = shownTarget(F5, "discard-lines", DIALOG);
// The dialog closes the frame after its discard lines leave the screen.
const CLOSED = DISCARD.to + 1;
// The dialog view runs from the prompt, eleven rows above the discard lines, to "1. Refuse".
const TOP = DISCARD.row - 11;
const DIALOG_VIEW = aim(F5, RESET_BOX, { scale: FIT.scale, top: TOP, left: marginCol(F5) });
const LENGTH = beatLength(6.5);
const CHIP_AT = { top: RESET_BOX.y + RESET_BOX.height + 14, right: SAFE.x };

export const guardPlan = (fps: number) => {
  const f = (s: number) => toFrames(s, fps);
  const edge = crossfadeFrames(fps);
  const t = timeline(F5, fps);
  // The submitted prompt reaches the transcript a second after the command is typed; until then
  // the window is empty.
  t.play(mark(F5, "cmd-typed") + t.seconds(1), DIALOG, 3);
  const held = t.hold(DIALOG, 2.6);
  // The dialog waits unchanged until Refuse is chosen, so the cut into the last half second before
  // it closes is invisible.
  const refuse = t.play(CLOSED - t.seconds(0.5), CLOSED);
  t.play(CLOSED, REFUSED, 2);
  const end = REFUSED + t.seconds(1);
  t.play(REFUSED, end);
  t.fill(end, LENGTH);
  // The caption and the stat chip share the band under the window, one after the other.
  return {
    t,
    callout: { from: held.start + f(0.1), duration: held.duration - f(0.2) },
    caption: { from: edge + f(0.1), duration: refuse.start - edge - f(0.1) },
    chip: { from: refuse.start + f(0.2), duration: t.duration - refuse.start - f(0.2) - edge },
    duration: t.duration,
  };
};

export const Guard = () => {
  const { fps } = useVideoConfig();
  const plan = guardPlan(fps);
  return (
    <Canvas>
      <Shot clip={F5} border={color.omcaBorder} box={RESET_BOX} keyframes={[{ frame: 0, ...DIALOG_VIEW }]} segments={plan.t.segments}>
        <Timed {...plan.callout}>
          <Callout target={targetRect(F5, DISCARD)} label="Held for review" side="right" />
        </Timed>
      </Shot>
      <CornerLabel />
      <Timed {...labelSpan(plan.duration, fps, { enters: true, leaves: true })}>
        <SideLabel text="With OMCA · bypass" tone="omca" enters leaves />
      </Timed>
      <Timed {...plan.caption}>
        <Caption text="It shows what you'd lose." />
      </Timed>
      <Timed {...plan.chip}>
        <StatChip
          value="5 of 5"
          label="test commands blocked"
          source="Measured 2026-10-03 · Claude Code 2.1.288 · under bypassPermissions"
          at={CHIP_AT}
        />
      </Timed>
    </Canvas>
  );
};
