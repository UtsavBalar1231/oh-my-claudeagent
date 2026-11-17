import { useVideoConfig } from "remotion";
import { Caption } from "../components/Caption.tsx";
import { mark, target } from "../footage.ts";
import { P1 } from "./clips.ts";
import { aim, beatLength, Canvas, crossfadeFrames, fitWidth, marginCol, Shot, Timed, timeline } from "./shot.tsx";

// The pair shares this framing with the OMCA stop: the whole terminal width, from four rows above
// the claim (the prompt sits two rows above it) down 19 rows.
const FIT = fitWidth(P1);
export const STOP_BOX = FIT.box;
export const stopView = (clip: typeof P1) => aim(clip, STOP_BOX, { scale: FIT.scale, top: target(clip, "claim-line").row - 4, left: marginCol(clip) });
const OPEN = mark(P1, "open-tasks");
const LENGTH = beatLength(5);

export const plainStopPlan = (fps: number) => {
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
    caption: { from: held.start, duration: held.duration - edge },
    duration: t.duration,
  };
};

export const PlainStop = () => {
  const { fps } = useVideoConfig();
  const plan = plainStopPlan(fps);
  return (
    <Canvas>
      <Shot clip={P1} box={STOP_BOX} keyframes={[{ frame: 0, ...stopView(P1) }]} segments={plan.t.segments} />
      <Timed {...plan.caption}>
        <Caption text="Claude said done. 8 tasks were open." />
      </Timed>
    </Canvas>
  );
};
