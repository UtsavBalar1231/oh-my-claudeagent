import { useVideoConfig } from "remotion";
import { Caption } from "../components/Caption.tsx";
import { mark, shownTarget } from "../footage.ts";
import { P2 } from "./clips.ts";
import { aim, beatLength, Canvas, crossfadeFrames, fitWidth, marginCol, Shot, Timed, timeline } from "./shot.tsx";

const FIT = fitWidth(P2);
export const RESET_BOX = FIT.box;
const RAN = mark(P2, "reset-ran");
const LOST_FILES = shownTarget(P2, "lost-files", RAN);
// Rows 4 to 22: the prompt, the reset call and the diff of the files it reverted.
const VIEW = aim(P2, RESET_BOX, { scale: FIT.scale, top: LOST_FILES.row - 6, left: marginCol(P2) });

export const plainResetPlan = (fps: number) => {
  const edge = crossfadeFrames(fps);
  const t = timeline(P2, fps);
  // The submitted prompt reaches the transcript a second after the command is typed; until then
  // the window is empty.
  t.play(mark(P2, "cmd-typed") + t.seconds(1), RAN, 3);
  // Nothing changes on screen after the reset, so the hold stands in for its last two seconds.
  const held = t.fill(RAN, beatLength(4.5));
  return {
    t,
    caption: { from: held.start, duration: held.duration - edge },
    duration: t.duration,
  };
};

export const PlainReset = () => {
  const { fps } = useVideoConfig();
  const plan = plainResetPlan(fps);
  return (
    <Canvas>
      <Shot clip={P2} box={RESET_BOX} keyframes={[{ frame: 0, ...VIEW }]} segments={plan.t.segments} />
      <Timed {...plan.caption}>
        <Caption text="Three files of work, gone." />
      </Timed>
    </Canvas>
  );
};
