import { useVideoConfig } from "remotion";
import { Callout } from "../components/Callout.tsx";
import { Caption } from "../components/Caption.tsx";
import { CornerLabel } from "../components/CornerLabel.tsx";
import { SideLabel } from "../components/SideLabel.tsx";
import { mark, shownTarget, target, targetRect } from "../footage.ts";
import { color, toFrames } from "../theme.ts";
import { P1 } from "./clips.ts";
import { aim, beatLength, Canvas, crossfadeFrames, fitWidth, labelSpan, marginCol, Shot, Timed, timeline } from "./shot.tsx";

// The pair shares this framing with the OMCA stop: the whole terminal width, from four rows above
// the claim (the prompt sits two rows above it) down 19 rows.
const FIT = fitWidth(P1);
export const STOP_BOX = FIT.box;
export const stopView = (clip: typeof P1) => aim(clip, STOP_BOX, { scale: FIT.scale, top: target(clip, "claim-line").row - 4, left: marginCol(clip) });
const OPEN = mark(P1, "open-tasks");
const OPEN_LIST = shownTarget(P1, "open-list", OPEN);
const LENGTH = beatLength(5);

export const plainStopPlan = (fps: number) => {
  const f = (s: number) => toFrames(s, fps);
  const t = timeline(P1, fps);
  const claim = mark(P1, "claim-done");
  const read = claim + t.seconds(0.6);
  t.play(claim, read);
  // The typed `grep` check runs on the input row below the window; it plays at 3x. The footage
  // holds on the open list, so the mock's reply to the follow-up never shows.
  t.play(read, OPEN, 3);
  const held = t.fill(OPEN, LENGTH);
  const edge = crossfadeFrames(fps);
  return {
    t,
    callout: { from: held.start + f(0.1), duration: held.duration - f(0.1) - edge },
    caption: { from: held.start, duration: held.duration - edge },
    duration: t.duration,
  };
};

export const PlainStop = () => {
  const { fps } = useVideoConfig();
  const plan = plainStopPlan(fps);
  return (
    <Canvas>
      <Shot clip={P1} border={color.plainBorder} box={STOP_BOX} keyframes={[{ frame: 0, ...stopView(P1) }]} segments={plan.t.segments}>
        <Timed {...plan.callout}>
          <Callout target={targetRect(P1, OPEN_LIST)} label="Still open" side="right" />
        </Timed>
      </Shot>
      <CornerLabel />
      <Timed {...labelSpan(plan.duration, fps, { leaves: true })}>
        <SideLabel text="Plain Claude Code" tone="plain" leaves />
      </Timed>
      <Timed {...plan.caption}>
        <Caption text="Claude said done. 8 tasks were open." />
      </Timed>
    </Canvas>
  );
};
