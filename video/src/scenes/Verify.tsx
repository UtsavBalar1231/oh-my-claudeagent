import { useVideoConfig } from "remotion";
import { Callout } from "../components/Callout.tsx";
import { Caption } from "../components/Caption.tsx";
import { CornerLabel } from "../components/CornerLabel.tsx";
import { mark, shownTarget, targetRect } from "../footage.ts";
import { color, toFrames } from "../theme.ts";
import { F6 } from "./clips.ts";
import { aim, beatLength, Canvas, chipOutset, captionSpan, PANE_COL, paneBox, Shot, Timed, timeline, TOP_BAR, Chapter } from "./shot.tsx";

// The Evidence pane from its first row: the verdict card and the ledger's first days.
const BOX = paneBox(F6);
const VIEW = aim(F6, BOX, { scale: 1, top: 0, left: PANE_COL });

export const verifyPlan = (fps: number) => {
  const f = (s: number) => toFrames(s, fps);
  const t = timeline(F6, fps);
  const complete = mark(F6, "complete");
  const settled = complete + t.seconds(0.5);
  const chip = shownTarget(F6, "complete-chip", settled);
  t.play(mark(F6, "tests-pass"), settled);
  const held = t.hold(settled, 2.6);
  const end = complete + t.seconds(2);
  t.play(settled, end);
  t.fill(end, beatLength(7));
  return {
    t,
    chip,
    callout: { from: held.start + f(0.1), duration: held.duration - f(0.1) },
    caption: captionSpan(t.duration, fps),
    duration: t.duration,
  };
};

export const Verify = () => {
  const { fps } = useVideoConfig();
  const plan = verifyPlan(fps);
  return (
    <Canvas>
      <Shot clip={F6} border={color.omcaBorder} box={BOX} keyframes={[{ frame: 0, ...VIEW }]} segments={plan.t.segments}>
        <Timed {...plan.callout}>
          <Callout target={targetRect(F6, plan.chip)} label="Verdict: COMPLETE" side={TOP_BAR} outset={chipOutset(F6, 1)} />
        </Timed>
      </Shot>
      <CornerLabel />
      <Chapter name="Prove" beatDuration={plan.duration} />
      <Timed {...plan.caption}>
        <Caption text="Done means proven." />
      </Timed>
    </Canvas>
  );
};
