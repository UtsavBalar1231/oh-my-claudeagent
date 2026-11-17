import { useVideoConfig } from "remotion";
import { Caption } from "../components/Caption.tsx";
import { mark, shownTarget } from "../footage.ts";
import { toFrames } from "../theme.ts";
import { F5 } from "./clips.ts";
import { RESET_BOX } from "./PlainReset.tsx";
import { aim, beatLength, Canvas, crossfadeFrames, fitWidth, marginCol, Shot, Timed, timeline } from "./shot.tsx";

const FIT = fitWidth(F5);
const REFUSED = mark(F5, "refused");
const KEPT = mark(F5, "kept");
const REFUSAL = shownTarget(F5, "refusal-row", KEPT);
// From the prompt, five rows above the refusal row, as the plain reset frames its twin.
const VIEW = aim(F5, RESET_BOX, { scale: FIT.scale, top: REFUSAL.row - 5, left: marginCol(F5) });
const LENGTH = beatLength(6.5);

export const guardPlan = (fps: number) => {
  const f = (s: number) => toFrames(s, fps);
  const edge = crossfadeFrames(fps);
  const t = timeline(F5, fps);
  // The submitted prompt reaches the transcript a second after the command is typed; until then
  // the window is empty.
  t.play(mark(F5, "cmd-typed") + t.seconds(1), REFUSED, 3);
  t.hold(REFUSED, 2.4);
  const reply = t.play(REFUSED, KEPT);
  t.fill(KEPT, LENGTH);
  return {
    t,
    caption: { from: edge + f(0.1), duration: reply.start - edge - f(0.1) },
    duration: t.duration,
  };
};

export const Guard = () => {
  const { fps } = useVideoConfig();
  const plan = guardPlan(fps);
  return (
    <Canvas>
      <Shot clip={F5} box={RESET_BOX} keyframes={[{ frame: 0, ...VIEW }]} segments={plan.t.segments} />
      <Timed {...plan.caption}>
        <Caption text="OMCA refuses it, even in bypass." />
      </Timed>
    </Canvas>
  );
};
