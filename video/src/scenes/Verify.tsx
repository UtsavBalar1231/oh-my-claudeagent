import { useVideoConfig } from "remotion";
import { Caption } from "../components/Caption.tsx";
import { mark } from "../footage.ts";
import { F6 } from "./clips.ts";
import { aim, beatLength, Canvas, captionSpan, PANE_COL, paneBox, Shot, Timed, timeline } from "./shot.tsx";

// The final task's page in the Task list pane, from its first row.
const BOX = paneBox(F6);
const VIEW = aim(F6, BOX, { scale: 1, top: 0, left: PANE_COL });
const NO_VERDICT = mark(F6, "no-verdict");
const PASSED = mark(F6, "passed");

export const verifyPlan = (fps: number) => {
  const t = timeline(F6, fps);
  const settled = PASSED + t.seconds(0.5);
  t.hold(NO_VERDICT, 2.2);
  // The page reads the ledger as it opens, so the run reopens it once the verdict is logged; the cut
  // from the hold to the reopened page leaves out the list shown between them.
  t.play(PASSED, settled);
  t.hold(settled, 2.6);
  t.fill(settled, beatLength(7));
  return {
    t,
    caption: captionSpan(t.duration, fps),
    duration: t.duration,
  };
};

export const Verify = () => {
  const { fps } = useVideoConfig();
  const plan = verifyPlan(fps);
  return (
    <Canvas>
      <Shot clip={F6} box={BOX} keyframes={[{ frame: 0, ...VIEW }]} segments={plan.t.segments} />
      <Timed {...plan.caption}>
        <Caption text="Done means proven." />
      </Timed>
    </Canvas>
  );
};
