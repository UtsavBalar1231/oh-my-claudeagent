import { useVideoConfig } from "remotion";
import { Callout } from "../components/Callout.tsx";
import { Caption } from "../components/Caption.tsx";
import { CornerLabel } from "../components/CornerLabel.tsx";
import { SideLabel } from "../components/SideLabel.tsx";
import { mark, shownTarget, targetRect } from "../footage.ts";
import { color, toFrames } from "../theme.ts";
import { F1 } from "./clips.ts";
import { STOP_BOX, stopView } from "./PlainStop.tsx";
import { beatLength, Canvas, captionSpan, labelSpan, Shot, Timed, timeline } from "./shot.tsx";

const FEEDBACK = mark(F1, "stop-feedback");
const STOP_LINE = shownTarget(F1, "stop-line", FEEDBACK);

export const refusalPlan = (fps: number) => {
  const f = (s: number) => toFrames(s, fps);
  const t = timeline(F1, fps);
  // The claim and the Stop hook's feedback land a frame apart; the hold starts on the feedback.
  const held = t.hold(FEEDBACK, 3.2);
  const resumed = mark(F1, "resumed") + t.seconds(1);
  t.play(FEEDBACK, resumed);
  t.fill(resumed, beatLength(5.5));
  return {
    t,
    callout: { from: held.start + f(0.45), duration: held.duration - f(0.55) },
    caption: captionSpan(t.duration, fps),
    duration: t.duration,
  };
};

export const Refusal = () => {
  const { fps } = useVideoConfig();
  const plan = refusalPlan(fps);
  return (
    <Canvas>
      <Shot clip={F1} border={color.omcaBorder} box={STOP_BOX} keyframes={[{ frame: 0, ...stopView(F1) }]} segments={plan.t.segments}>
        <Timed {...plan.callout}>
          <Callout target={targetRect(F1, STOP_LINE)} label="Sent back to work" side="below" />
        </Timed>
      </Shot>
      <CornerLabel />
      <Timed {...labelSpan(plan.duration, fps, { enters: true, leaves: true })}>
        <SideLabel text="With OMCA" tone="omca" enters leaves />
      </Timed>
      <Timed {...plan.caption}>
        <Caption text="OMCA sends it back." />
      </Timed>
    </Canvas>
  );
};
