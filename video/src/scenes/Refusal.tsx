import { useVideoConfig } from "remotion";
import { Caption } from "../components/Caption.tsx";
import { mark } from "../footage.ts";
import { F1 } from "./clips.ts";
import { STOP_BOX, stopView } from "./PlainStop.tsx";
import { beatLength, Canvas, captionSpan, Shot, Timed, timeline } from "./shot.tsx";

const FEEDBACK = mark(F1, "stop-feedback");

export const refusalPlan = (fps: number) => {
  const t = timeline(F1, fps);
  // The claim and the Stop hook's feedback land a frame apart; the hold starts on the feedback.
  t.hold(FEEDBACK, 3.2);
  const resumed = mark(F1, "resumed") + t.seconds(1);
  t.play(FEEDBACK, resumed);
  t.fill(resumed, beatLength(5.5));
  return {
    t,
    caption: captionSpan(t.duration, fps),
    duration: t.duration,
  };
};

export const Refusal = () => {
  const { fps } = useVideoConfig();
  const plan = refusalPlan(fps);
  return (
    <Canvas>
      <Shot clip={F1} box={STOP_BOX} keyframes={[{ frame: 0, ...stopView(F1) }]} segments={plan.t.segments} />
      <Timed {...plan.caption}>
        <Caption text="OMCA sends it back." />
      </Timed>
    </Canvas>
  );
};
